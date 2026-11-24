//! Admin pages beyond users and settings: signed-in devices, all boards, system status, the site announcement.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    Json,
    extract::{Path, State},
};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    audit::ClientIp,
    auth::{CurrentUser, SuperAdmin},
    error::{AppError, AppResult},
};

/// Set by the release build (Dockerfile ARG KANB_VERSION, from the git tag); "dev" otherwise.
pub const VERSION: &str = match option_env!("KANB_VERSION") {
    Some(v) => v,
    None => "dev",
};

/// When this server process started (for "up since").
pub static STARTED: OnceLock<DateTime<Utc>> = OnceLock::new();

/// Releases are looked up here (the project's GitHub repository).
const RELEASES_URL: &str = "https://api.github.com/repos/Jadepat-C/kanb/releases/latest";

// ---------- signed-in devices ----------

#[derive(Serialize, sqlx::FromRow)]
pub struct Session {
    id: Uuid,
    created_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    user_agent: Option<String>,
    ip: Option<String>,
    /// the admin's own session (this browser)
    current: bool,
    #[sqlx(skip)]
    device: String,
}

fn my_hash(jar: &CookieJar) -> String {
    jar.get(crate::auth::COOKIE_NAME).map(|c| crate::auth::token_hash(c.value())).unwrap_or_default()
}

pub async fn sessions(State(state): State<AppState>, _a: SuperAdmin, jar: CookieJar, Path(user_id): Path<Uuid>) -> AppResult<Json<Vec<Session>>> {
    let mut rows: Vec<Session> = sqlx::query_as(
        "SELECT id, created_at, last_seen_at, user_agent, ip, token_hash = $2 AS current
         FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC",
    )
    .bind(user_id)
    .bind(my_hash(&jar))
    .fetch_all(&state.db)
    .await?;
    for s in &mut rows {
        s.device = s.user_agent.as_deref().map(crate::auth::device_name).unwrap_or_else(|| "Browser".into());
    }
    Ok(Json(rows))
}

/// "Sign out everywhere" (keeps the admin's own browser signed in when it's their account).
pub async fn revoke_all(
    State(state): State<AppState>,
    SuperAdmin(me): SuperAdmin,
    ClientIp(ip): ClientIp,
    jar: CookieJar,
    Path(user_id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let r = sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2").bind(user_id).bind(my_hash(&jar)).execute(&state.db).await?;
    crate::audit::log(&state, Some(me.id), "sessions_revoked", Some(user_id), ip.as_deref(), json!({ "count": r.rows_affected() })).await;
    Ok(Json(json!({ "signed_out": r.rows_affected() })))
}

pub async fn revoke_one(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, ClientIp(ip): ClientIp, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let row: Option<(Uuid,)> = sqlx::query_as("DELETE FROM sessions WHERE id = $1 RETURNING user_id").bind(id).fetch_optional(&state.db).await?;
    let (user_id,) = row.ok_or(AppError::NotFound)?;
    crate::audit::log(&state, Some(me.id), "sessions_revoked", Some(user_id), ip.as_deref(), json!({ "count": 1 })).await;
    Ok(Json(json!({ "signed_out": 1 })))
}

// ---------- all boards ----------

#[derive(Serialize, sqlx::FromRow)]
pub struct BoardRow {
    id: Uuid,
    name: String,
    color: String,
    is_tutorial: bool,
    archived_at: Option<DateTime<Utc>>,
    /// latest change to the board or any of its cards
    last_activity: DateTime<Utc>,
    members: i64,
    cards: i64,
    bytes: i64,
    /// [{id, name, active}]
    owners: Value,
}

pub async fn boards(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<Vec<BoardRow>>> {
    let dn = crate::auth::DISPLAY_NAME_SQL;
    let rows: Vec<BoardRow> = sqlx::query_as(sqlf!(
        "SELECT b.id, b.name, b.color, b.is_tutorial, b.archived_at,
                GREATEST(b.updated_at, (SELECT max(c.updated_at) FROM cards c WHERE c.board_id = b.id)) AS last_activity,
                (SELECT count(*) FROM board_members m WHERE m.board_id = b.id) AS members,
                (SELECT count(*) FROM cards c WHERE c.board_id = b.id AND c.archived_at IS NULL) AS cards,
                (SELECT COALESCE(sum(a.size), 0)::bigint FROM attachments a WHERE a.board_id = b.id AND a.deleted_at IS NULL) AS bytes,
                COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', {dn}, 'active', u.is_active AND u.deleted_at IS NULL)
                                          ORDER BY u.display_name)
                          FROM board_members m JOIN board_roles r ON r.id = m.role_id AND r.is_owner JOIN users u ON u.id = m.user_id
                          WHERE m.board_id = b.id), '[]'::json) AS owners
         FROM boards b
         ORDER BY b.archived_at IS NOT NULL, lower(b.name)"
    ))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct AddOwner {
    user_id: Uuid,
}

/// Makes someone an owner of a board (e.g. when the previous owner left). Existing owners stay.
pub async fn add_owner(
    State(state): State<AppState>,
    SuperAdmin(me): SuperAdmin,
    ClientIp(ip): ClientIp,
    Path(board_id): Path<Uuid>,
    Json(r): Json<AddOwner>,
) -> AppResult<Json<Value>> {
    let (name,): (String,) = sqlx::query_as("SELECT name FROM boards WHERE id = $1").bind(board_id).fetch_one(&state.db).await?;
    let active: Option<(bool,)> =
        sqlx::query_as("SELECT is_active FROM users WHERE id = $1 AND deleted_at IS NULL").bind(r.user_id).fetch_optional(&state.db).await?;
    if !matches!(active, Some((true,))) {
        return Err(AppError::BadRequest("user_inactive"));
    }
    sqlx::query(
        "INSERT INTO board_members (board_id, user_id, role_id)
         SELECT $1, $2, id FROM board_roles WHERE board_id = $1 AND is_owner LIMIT 1
         ON CONFLICT (board_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id",
    )
    .bind(board_id)
    .bind(r.user_id)
    .execute(&state.db)
    .await?;
    state.hub.notify(board_id, "member", None, me.id);
    crate::audit::log(&state, Some(me.id), "board_owner_added", Some(board_id), ip.as_deref(), json!({ "board_name": name, "user_id": r.user_id })).await;
    Ok(Json(json!({ "ok": true })))
}

// ---------- system status ----------

/// Newest release on GitHub, asked at most every 6 hours (a failed check is retried after 30 minutes).
/// Only when an admin opens the System page; nothing about this server is sent.
static RELEASE: Mutex<Option<(Instant, Option<Value>)>> = Mutex::new(None);

async fn latest_release() -> Option<Value> {
    if let Ok(g) = RELEASE.lock()
        && let Some((at, v)) = g.as_ref()
    {
        let ttl = if v.is_some() { Duration::from_secs(6 * 3600) } else { Duration::from_secs(1800) };
        if at.elapsed() < ttl {
            return v.clone();
        }
    }
    let fetched = async {
        let client = reqwest::Client::builder().user_agent("kanb-update-check").timeout(Duration::from_secs(10)).build().ok()?;
        let r: Value = client.get(RELEASES_URL).header("Accept", "application/vnd.github+json").send().await.ok()?.error_for_status().ok()?.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok())?;
        Some(json!({ "version": r.get("tag_name")?, "url": r.get("html_url")?, "published_at": r.get("published_at") }))
    }
    .await;
    if let Ok(mut g) = RELEASE.lock() {
        *g = Some((Instant::now(), fetched.clone()));
    }
    fetched
}

pub async fn system(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<Value>> {
    let db = &state.db;
    let (db_bytes,): (i64,) = sqlx::query_as("SELECT pg_database_size(current_database())").fetch_one(db).await?;
    let (pg_version,): (String,) = sqlx::query_as("SELECT current_setting('server_version')").fetch_one(db).await?;
    let (migrations, last_migration): (i64, Option<String>) =
        sqlx::query_as("SELECT count(*), max(version)::text || ' ' || (SELECT description FROM _sqlx_migrations ORDER BY version DESC LIMIT 1) FROM _sqlx_migrations")
            .fetch_one(db)
            .await?;
    let (users, active_30d, boards, cards): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM users WHERE deleted_at IS NULL AND is_active),
                (SELECT count(*) FROM users WHERE deleted_at IS NULL AND is_active AND last_seen_at > now() - interval '30 days'),
                (SELECT count(*) FROM boards WHERE archived_at IS NULL AND NOT is_tutorial),
                (SELECT count(*) FROM cards WHERE archived_at IS NULL)",
    )
    .fetch_one(db)
    .await?;
    let smtp = crate::mail::load(&state).await?;
    let last_mail = crate::mail::last_send().map(|(at, err)| json!({ "at": at, "ok": err.is_none(), "error": err }));
    Ok(Json(json!({
        "version": VERSION,
        "latest": latest_release().await,
        "started_at": STARTED.get(),
        "database": { "bytes": db_bytes, "postgres": pg_version, "migrations": migrations, "last_migration": last_migration },
        "files_bytes": crate::files::storage_used(db).await?,
        "files_limit_bytes": crate::files::storage_limit(&state),
        "counts": { "users": users, "active_30d": active_30d, "boards": boards, "cards": cards },
        "email": { "enabled": smtp.enabled, "ready": crate::mail::ready(&smtp), "last": last_mail },
    })))
}

// ---------- site announcement ----------

const ANNOUNCEMENT_KEY: &str = "announcement";
const MAX_TEXT: usize = 500;

#[derive(Serialize, Deserialize, Clone)]
pub struct Announcement {
    /// changes on every save, so a new message shows again for people who dismissed the old one
    id: Uuid,
    text: String,
    /// info | warning
    level: String,
    /// stop showing it after this
    until: Option<DateTime<Utc>>,
}

async fn load_announcement(state: &AppState) -> AppResult<Option<Announcement>> {
    let row: Option<(Value,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = $1").bind(ANNOUNCEMENT_KEY).fetch_optional(&state.db).await?;
    Ok(row.and_then(|(v,)| serde_json::from_value(v).ok()))
}

/// For everyone signed in: the current message, or null (none, or past its end time).
pub async fn announcement(State(state): State<AppState>, _u: CurrentUser) -> AppResult<Json<Option<Announcement>>> {
    Ok(Json(load_announcement(&state).await?.filter(|a| a.until.is_none_or(|t| t > Utc::now()))))
}

pub async fn admin_announcement(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<Option<Announcement>>> {
    Ok(Json(load_announcement(&state).await?))
}

#[derive(Deserialize)]
pub struct SaveAnnouncement {
    /// empty = remove the announcement
    text: String,
    level: String,
    until: Option<DateTime<Utc>>,
}

pub async fn save_announcement(
    State(state): State<AppState>,
    SuperAdmin(me): SuperAdmin,
    ClientIp(ip): ClientIp,
    Json(r): Json<SaveAnnouncement>,
) -> AppResult<Json<Option<Announcement>>> {
    let text = r.text.trim();
    if text.chars().count() > MAX_TEXT {
        return Err(AppError::BadRequest("too_long"));
    }
    if !["info", "warning"].contains(&r.level.as_str()) {
        return Err(AppError::BadRequest("invalid_level"));
    }
    let saved = if text.is_empty() {
        sqlx::query("DELETE FROM app_settings WHERE key = $1").bind(ANNOUNCEMENT_KEY).execute(&state.db).await?;
        None
    } else {
        let a = Announcement { id: Uuid::now_v7(), text: text.to_string(), level: r.level, until: r.until };
        sqlx::query(
            "INSERT INTO app_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(ANNOUNCEMENT_KEY)
        .bind(serde_json::to_value(&a).map_err(|e| AppError::Internal(e.into()))?)
        .execute(&state.db)
        .await?;
        Some(a)
    };
    crate::audit::log(
        &state,
        Some(me.id),
        "settings_changed",
        None,
        ip.as_deref(),
        json!({ "area": "announcement", "removed": saved.is_none(), "text": saved.as_ref().map(|a| a.text.clone()) }),
    )
    .await;
    Ok(Json(saved))
}
