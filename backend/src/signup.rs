//! Self sign-up (ALLOW_SIGNUP=true): people create their own account on /register.
//!
//! 1. The account is created inactive. If the server can send email, it waits in state 'email' until its owner
//!    clicks the confirmation link (unconfirmed accounts are removed after 24 hours).
//! 2. Then, depending on Admin → Users → Sign-up: approved at once ("auto"), or state 'review' until a super admin
//!    approves or rejects it ("review", the default). Super admins get one bundled notification for what's waiting.
//!
//! Waiting accounts can't sign in (they're told why once their password is right), aren't in the normal user list,
//! and get their "Getting started" board only when they're activated. Rejecting deletes the account.

use std::net::SocketAddr;

use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::HeaderMap,
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    audit::ClientIp,
    auth::{SuperAdmin, token_hash},
    error::{AppError, AppResult},
    throttle,
};

const SETTINGS_KEY: &str = "signup";
/// sign-ups per address per hour (counted whether they succeed or not)
const SIGNUP_IP: throttle::Rule = throttle::Rule { limit: 5, window: std::time::Duration::from_secs(3600) };
/// accounts that may wait at once (confirmation + review), so a flood can't fill the database
const MAX_WAITING: i64 = 500;
/// how long a confirmation link (and the unconfirmed account) lasts
const CONFIRM_HOURS: i32 = 24;

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    /// "review": an admin approves each account; "auto": accounts can be used right away
    approval: String,
    /// people who signed up may create their own boards
    can_create_boards: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { approval: "review".into(), can_create_boards: true }
    }
}

async fn settings(state: &AppState) -> Settings {
    let v: Option<(Value,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = $1").bind(SETTINGS_KEY).fetch_optional(&state.db).await.ok().flatten();
    v.and_then(|(v,)| serde_json::from_value(v).ok()).unwrap_or_default()
}

/// Sign-up is switched on in the config and the first admin exists.
async fn open(state: &AppState) -> AppResult<()> {
    if !state.config.allow_signup || crate::setup::needs_setup(&state.db).await? {
        return Err(AppError::NotFound);
    }
    Ok(())
}

// ---------- the sign-up page ----------

#[derive(Deserialize)]
pub struct RegisterReq {
    username: String,
    #[serde(default)]
    display_name: String,
    email: String,
    password: String,
    locale: Option<String>,
    /// hidden field people never fill in; bots that do get a normal-looking answer and no account
    #[serde(default)]
    website: String,
}

/// What happens next, for the page to explain: "confirm_email" | "review" | "active" (signed in).
fn status(s: &str) -> Json<Value> {
    Json(json!({ "status": s }))
}

pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ClientIp(ip): ClientIp,
    jar: CookieJar,
    Json(r): Json<RegisterReq>,
) -> AppResult<(CookieJar, Json<Value>)> {
    open(&state).await?;
    let key = throttle::ip_key("signup", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    state.throttle.check(&key, SIGNUP_IP)?;
    state.throttle.hit(&key, SIGNUP_IP);
    let mail = crate::mail::load(&state).await?;
    let can_mail = crate::mail::ready(&mail);
    if !r.website.trim().is_empty() {
        tracing::info!("sign-up with the hidden field filled in ignored");
        return Ok((jar, status(if can_mail { "confirm_email" } else { "review" })));
    }
    let email = crate::auth::normalize_email(Some(r.email.clone()))?.flatten().ok_or(AppError::BadRequest("email_required"))?;
    let (waiting,): (i64,) = sqlx::query_as("SELECT count(*) FROM users WHERE signup IS NOT NULL AND deleted_at IS NULL").fetch_one(&state.db).await?;
    if waiting >= MAX_WAITING {
        return Err(AppError::BadRequest("signup_full"));
    }
    // signing up again with the same address replaces an account that was never confirmed (a lost email)
    sqlx::query("DELETE FROM users WHERE signup = 'email' AND lower(email) = lower($1)").bind(&email).execute(&state.db).await?;
    let locale = if r.locale.as_deref() == Some("th") { "th" } else { "en" };
    let set = settings(&state).await;
    let first = if can_mail { Some("email") } else { next_state(&set) };
    let user = crate::admin::insert_user(&state.db, &r.username, &r.display_name, Some(email), &r.password, false, set.can_create_boards, locale, false, first)
        .await
        .map_err(|e| match e {
            AppError::Conflict("already_exists") => AppError::Conflict("username_taken"),
            e => e,
        })?;
    crate::audit::log(&state, None, "signed_up", Some(user.id), ip.as_deref(), json!({ "username": user.username })).await;
    if first == Some("email") {
        if let Err(e) = crate::auth::send_link_email_for(&state, user.id, "confirm", CONFIRM_HOURS).await {
            // without the link the account could never be used: don't keep it holding the name and address
            tracing::warn!(error = %e, "sign-up confirmation email failed");
            sqlx::query("DELETE FROM users WHERE id = $1 AND signup = 'email'").bind(user.id).execute(&state.db).await?;
            return Err(AppError::BadRequest("signup_email_failed"));
        }
        return Ok((jar, status("confirm_email")));
    }
    after_confirmed(&state, user.id, first, &headers, jar, ip.as_deref()).await
}

/// "review" or None (= active right away), by the admin's choice.
fn next_state(s: &Settings) -> Option<&'static str> {
    if s.approval == "auto" { None } else { Some("review") }
}

/// The account's email is confirmed (or needn't be): wait for review, or activate and sign in.
async fn after_confirmed(
    state: &AppState,
    user_id: Uuid,
    now: Option<&str>,
    headers: &HeaderMap,
    jar: CookieJar,
    ip: Option<&str>,
) -> AppResult<(CookieJar, Json<Value>)> {
    match now {
        Some(_) => {
            crate::notify::signups_changed(state, true).await;
            Ok((jar, status("review")))
        }
        None => {
            activate(state, user_id, None).await?;
            let (jar, _) = crate::auth::start_session(state, user_id, headers, jar, ip, "signup").await?;
            Ok((jar, status("active")))
        }
    }
}

/// Waiting account → normal account (with its "Getting started" board).
async fn activate(state: &AppState, user_id: Uuid, by: Option<Uuid>) -> AppResult<bool> {
    let set = settings(state).await;
    let row: Option<(String,)> = sqlx::query_as(
        "UPDATE users SET signup = NULL, is_active = true, can_create_boards = $2, updated_at = now()
         WHERE id = $1 AND signup IS NOT NULL AND deleted_at IS NULL RETURNING locale",
    )
    .bind(user_id)
    .bind(set.can_create_boards)
    .fetch_optional(&state.db)
    .await?;
    let Some((locale,)) = row else { return Ok(false) };
    if let Err(e) = crate::tutorial::create(&state.db, user_id, &locale).await {
        tracing::warn!(error = %e, "could not create tutorial board");
    }
    if by.is_some() {
        crate::audit::log(state, by, "signup_approved", Some(user_id), None, json!({})).await;
    }
    Ok(true)
}

#[derive(Deserialize)]
pub struct ConfirmReq {
    token: String,
}

/// The link in the confirmation email.
pub async fn confirm(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ClientIp(ip): ClientIp,
    jar: CookieJar,
    Json(r): Json<ConfirmReq>,
) -> AppResult<(CookieJar, Json<Value>)> {
    open(&state).await?;
    let key = throttle::ip_key("token", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    state.throttle.check(&key, throttle::TOKEN_IP)?;
    let row: Option<(Uuid,)> = sqlx::query_as(
        "UPDATE password_tokens t SET used_at = now() FROM users u
         WHERE t.token_hash = $1 AND t.purpose = 'confirm' AND t.used_at IS NULL AND t.expires_at > now()
           AND u.id = t.user_id AND u.signup = 'email' AND u.deleted_at IS NULL
         RETURNING t.user_id",
    )
    .bind(token_hash(&r.token))
    .fetch_optional(&state.db)
    .await?;
    let Some((uid,)) = row else {
        state.throttle.hit(&key, throttle::TOKEN_IP);
        return Err(AppError::BadRequest("invalid_token"));
    };
    crate::audit::log(&state, Some(uid), "email_confirmed", Some(uid), ip.as_deref(), json!({})).await;
    let next = next_state(&settings(&state).await);
    if next.is_some() {
        sqlx::query("UPDATE users SET signup = 'review' WHERE id = $1").bind(uid).execute(&state.db).await?;
    }
    after_confirmed(&state, uid, next, &headers, jar, ip.as_deref()).await
}

// ---------- Admin → Users ----------

#[derive(Serialize, sqlx::FromRow)]
struct Waiting {
    id: Uuid,
    username: String,
    display_name: String,
    email: Option<String>,
    signed_up_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn admin_get(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<Value>> {
    let waiting: Vec<Waiting> = sqlx::query_as(
        "SELECT id, username, display_name, email, signed_up_at FROM users
         WHERE signup = 'review' AND deleted_at IS NULL ORDER BY signed_up_at",
    )
    .fetch_all(&state.db)
    .await?;
    let (unconfirmed,): (i64,) = sqlx::query_as("SELECT count(*) FROM users WHERE signup = 'email' AND deleted_at IS NULL").fetch_one(&state.db).await?;
    let s = settings(&state).await;
    Ok(Json(json!({
        // ALLOW_SIGNUP in the server's configuration
        "enabled": state.config.allow_signup,
        "approval": s.approval,
        "can_create_boards": s.can_create_boards,
        "can_email": crate::mail::ready(&crate::mail::load(&state).await?),
        "waiting": waiting,
        "unconfirmed": unconfirmed,
    })))
}

pub async fn admin_save(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, ClientIp(ip): ClientIp, Json(r): Json<Settings>) -> AppResult<Json<Value>> {
    if !matches!(r.approval.as_str(), "review" | "auto") {
        return Err(AppError::BadRequest("invalid_approval"));
    }
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()")
        .bind(SETTINGS_KEY)
        .bind(serde_json::to_value(&r).map_err(|e| AppError::Internal(e.into()))?)
        .execute(&state.db)
        .await?;
    crate::audit::log(&state, Some(me.id), "settings_changed", None, ip.as_deref(), json!({ "area": "signup", "approval": r.approval, "can_create_boards": r.can_create_boards })).await;
    admin_get(State(state), SuperAdmin(me)).await
}

#[derive(Deserialize)]
pub struct Ids {
    ids: Vec<Uuid>,
}

/// Approve waiting accounts; each gets an email saying so (when the server can send email).
pub async fn approve(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, Json(r): Json<Ids>) -> AppResult<Json<Value>> {
    let mut n = 0;
    for id in r.ids.iter().take(500) {
        let ok: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE id = $1 AND signup = 'review' AND deleted_at IS NULL").bind(id).fetch_optional(&state.db).await?;
        if ok.is_none() || !activate(&state, *id, Some(me.id)).await? {
            continue;
        }
        n += 1;
        let st = state.clone();
        let id = *id;
        tokio::spawn(async move {
            if let Err(e) = crate::auth::send_approved_email(&st, id).await {
                tracing::warn!(error = %e, "approval email failed");
            }
        });
    }
    crate::notify::signups_changed(&state, false).await;
    Ok(Json(json!({ "approved": n })))
}

/// Reject (delete) waiting accounts. Only accounts that are still waiting can be removed this way.
pub async fn reject(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, ClientIp(ip): ClientIp, Json(r): Json<Ids>) -> AppResult<Json<Value>> {
    let gone: Vec<(Uuid, String)> = sqlx::query_as("DELETE FROM users WHERE id = ANY($1) AND signup IS NOT NULL RETURNING id, username")
        .bind(&r.ids)
        .fetch_all(&state.db)
        .await?;
    for (id, username) in &gone {
        crate::audit::log(&state, Some(me.id), "signup_rejected", Some(*id), ip.as_deref(), json!({ "username": username })).await;
    }
    crate::notify::signups_changed(&state, false).await;
    Ok(Json(json!({ "rejected": gone.len() })))
}

/// Hourly: remove accounts whose email was never confirmed (their link has expired).
pub fn spawn_pruner(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            tick.tick().await;
            match sqlx::query("DELETE FROM users WHERE signup = 'email' AND signed_up_at < now() - make_interval(hours => $1)")
                .bind(CONFIRM_HOURS)
                .execute(&state.db)
                .await
            {
                Ok(r) if r.rows_affected() > 0 => tracing::info!(removed = r.rows_affected(), "unconfirmed sign-ups removed"),
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "unconfirmed sign-up cleanup failed"),
            }
        }
    });
}
