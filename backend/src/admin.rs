//! User administration (super admin only). There is no self sign-up.

use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{CurrentUser, SuperAdmin, USER_COLUMNS, User, hash_password, validate_password},
    error::{AppError, AppResult},
};

const AVATAR_COLORS: &[&str] = &["#2f5bd3", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"];

fn validate_username(u: &str) -> AppResult<String> {
    let u = u.trim();
    let ok = (2..=40).contains(&u.chars().count())
        && u.chars().all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok { Ok(u.to_string()) } else { Err(AppError::BadRequest("invalid_username")) }
}

#[derive(Deserialize)]
pub struct CreateUser {
    username: String,
    display_name: String,
    email: Option<String>,
    password: String,
    #[serde(default)]
    is_super_admin: bool,
    #[serde(default = "yes")]
    can_create_boards: bool,
    /// UI language for the new user (and of their tutorial board)
    locale: Option<String>,
    /// email them a "set your password" link (needs an email address and email set up)
    #[serde(default)]
    send_invite: bool,
}
fn yes() -> bool {
    true
}

/// Shared by the HTTP endpoint and the `create-admin` CLI command.
pub async fn insert_user(
    db: &sqlx::PgPool,
    username: &str,
    display_name: &str,
    email: Option<String>,
    password: &str,
    is_super_admin: bool,
    can_create_boards: bool,
    locale: &str,
    must_change_password: bool,
) -> AppResult<User> {
    let locale = if locale == "th" { "th" } else { "en" };
    let username = validate_username(username)?;
    validate_password(password)?;
    let email = crate::auth::normalize_email(email)?.flatten();
    if let Some(e) = &email {
        crate::auth::ensure_email_free(db, e, None).await?;
    }
    let display_name = if display_name.trim().is_empty() { username.clone() } else { display_name.trim().to_string() };
    let pw = password.to_string();
    let hash = tokio::task::spawn_blocking(move || hash_password(&pw)).await.map_err(|e| anyhow::anyhow!(e))??;
    let id = Uuid::now_v7();
    let color = AVATAR_COLORS[(id.as_u128() % AVATAR_COLORS.len() as u128) as usize];
    let user: User = sqlx::query_as(sqlf!(
        "INSERT INTO users (id, username, display_name, email, password_hash, is_super_admin, can_create_boards, avatar_color, locale, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING {USER_COLUMNS}"
    ))
    .bind(id)
    .bind(&username)
    .bind(display_name)
    .bind(email)
    .bind(hash)
    .bind(is_super_admin)
    .bind(can_create_boards)
    .bind(color)
    .bind(locale)
    .bind(must_change_password)
    .fetch_one(db)
    .await?;
    // every new account starts with its own "Getting started" board (best effort: never block account creation)
    if let Err(e) = crate::tutorial::create(db, user.id, locale).await {
        tracing::warn!(error = %e, user = %user.username, "could not create tutorial board");
    }
    Ok(user)
}

pub async fn list_users(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<Vec<User>>> {
    let users: Vec<User> = sqlx::query_as(sqlf!("SELECT {USER_COLUMNS} FROM users WHERE deleted_at IS NULL ORDER BY lower(display_name)"))
        .fetch_all(&state.db)
        .await?;
    Ok(Json(users))
}

pub async fn create_user(
    State(state): State<AppState>,
    SuperAdmin(admin): SuperAdmin,
    Json(r): Json<CreateUser>,
) -> AppResult<Json<serde_json::Value>> {
    let locale = r.locale.clone().unwrap_or_else(|| admin.locale.clone());
    // the admin chose this password, so the user must replace it at first sign-in
    let u = insert_user(&state.db, &r.username, &r.display_name, r.email, &r.password, r.is_super_admin, r.can_create_boards, &locale, true)
        .await
        .map_err(|e| match e {
            AppError::Conflict("already_exists") => AppError::Conflict("username_taken"),
            e => e,
        })?;
    let mut invite = serde_json::Value::Null;
    if r.send_invite && u.email.is_some() {
        invite = match crate::auth::send_link_email(&state, u.id, "invite").await {
            Ok(()) => serde_json::json!({ "sent": true }),
            Err(e) => serde_json::json!({ "sent": false, "error": e }),
        };
    }
    Ok(Json(serde_json::json!({ "user": u, "invite": invite })))
}

/// Emails the user a password-reset link (instead of the admin choosing a password).
pub async fn send_reset(State(state): State<AppState>, _a: SuperAdmin, Path(id): Path<Uuid>) -> AppResult<Json<serde_json::Value>> {
    Ok(Json(match crate::auth::send_link_email(&state, id, "reset").await {
        Ok(()) => serde_json::json!({ "sent": true }),
        Err(e) => serde_json::json!({ "sent": false, "error": e }),
    }))
}

#[derive(Deserialize)]
pub struct UpdateUser {
    display_name: Option<String>,
    email: Option<String>,
    is_super_admin: Option<bool>,
    can_create_boards: Option<bool>,
    is_active: Option<bool>,
}

pub async fn update_user(
    State(state): State<AppState>,
    SuperAdmin(me): SuperAdmin,
    Path(id): Path<Uuid>,
    Json(r): Json<UpdateUser>,
) -> AppResult<Json<User>> {
    if id == me.id && (r.is_super_admin == Some(false) || r.is_active == Some(false)) {
        return Err(AppError::BadRequest("cannot_demote_self"));
    }
    let email = crate::auth::normalize_email(r.email.clone())?;
    if let Some(Some(e)) = &email {
        crate::auth::ensure_email_free(&state.db, e, Some(id)).await?;
    }
    let user: User = sqlx::query_as(sqlf!(
        "UPDATE users SET display_name = COALESCE($2, display_name), email = CASE WHEN $7 THEN $3 ELSE email END,
         is_super_admin = COALESCE($4, is_super_admin), can_create_boards = COALESCE($5, can_create_boards),
         is_active = COALESCE($6, is_active), updated_at = now() WHERE id = $1 RETURNING {USER_COLUMNS}"
    ))
    .bind(id)
    .bind(r.display_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    .bind(email.clone().flatten())
    .bind(r.is_super_admin)
    .bind(r.can_create_boards)
    .bind(r.is_active)
    .bind(email.is_some())
    .fetch_one(&state.db)
    .await?;
    if !user.is_active {
        sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(id).execute(&state.db).await?;
    }
    Ok(Json(user))
}

#[derive(Deserialize)]
pub struct ResetPassword {
    password: String,
}

pub async fn reset_password(
    State(state): State<AppState>,
    _a: SuperAdmin,
    Path(id): Path<Uuid>,
    Json(r): Json<ResetPassword>,
) -> AppResult<Json<serde_json::Value>> {
    validate_password(&r.password)?;
    let pw = r.password.clone();
    let hash = tokio::task::spawn_blocking(move || hash_password(&pw)).await.map_err(|e| anyhow::anyhow!(e))??;
    // an admin-chosen password must be replaced by the user at next sign-in
    let res = sqlx::query("UPDATE users SET password_hash = $2, must_change_password = true, updated_at = now() WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .bind(hash)
        .execute(&state.db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(id).execute(&state.db).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Minimal directory of active users (for adding board members / assignees).
#[derive(Serialize, sqlx::FromRow)]
pub struct UserBrief {
    id: Uuid,
    username: String,
    display_name: String,
    avatar_color: String,
    avatar_id: Option<Uuid>,
}

pub async fn directory(State(state): State<AppState>, _u: CurrentUser) -> AppResult<Json<Vec<UserBrief>>> {
    let users: Vec<UserBrief> = sqlx::query_as(
        "SELECT id, username, display_name, avatar_color, avatar_id FROM users WHERE is_active ORDER BY lower(display_name)",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(users))
}

// ---------- deleting users ----------

#[derive(Serialize, sqlx::FromRow)]
pub struct BoardImpact {
    id: Uuid,
    name: String,
    card_count: i64,
}

#[derive(Serialize)]
pub struct DeletePreview {
    /// boards the user owns and is the only member of: deleted with everything in them
    deleted: Vec<BoardImpact>,
    /// shared boards where the user is the only owner: another member becomes owner
    new_owner: Vec<BoardImpact>,
    /// other shared boards: the user is just removed
    removed_from: i64,
}

async fn impact(db: &sqlx::PgPool, id: Uuid) -> AppResult<DeletePreview> {
    let deleted: Vec<BoardImpact> = sqlx::query_as(
        "SELECT b.id, b.name, (SELECT count(*) FROM cards c WHERE c.board_id = b.id) AS card_count
         FROM boards b JOIN board_members m ON m.board_id = b.id AND m.user_id = $1
         WHERE NOT EXISTS (SELECT 1 FROM board_members o WHERE o.board_id = b.id AND o.user_id <> $1)
         ORDER BY lower(b.name)",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let new_owner: Vec<BoardImpact> = sqlx::query_as(
        "SELECT b.id, b.name, (SELECT count(*) FROM cards c WHERE c.board_id = b.id) AS card_count
         FROM boards b JOIN board_members m ON m.board_id = b.id AND m.user_id = $1
         JOIN board_roles r ON r.id = m.role_id AND r.is_owner
         WHERE EXISTS (SELECT 1 FROM board_members o WHERE o.board_id = b.id AND o.user_id <> $1)
           AND NOT EXISTS (SELECT 1 FROM board_members o JOIN board_roles r2 ON r2.id = o.role_id
                           WHERE o.board_id = b.id AND o.user_id <> $1 AND r2.is_owner)
         ORDER BY lower(b.name)",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let (total,): (i64,) = sqlx::query_as("SELECT count(*) FROM board_members WHERE user_id = $1").bind(id).fetch_one(db).await?;
    let removed_from = total - deleted.len() as i64 - new_owner.len() as i64;
    Ok(DeletePreview { deleted, new_owner, removed_from })
}

pub async fn delete_preview(State(state): State<AppState>, _a: SuperAdmin, Path(id): Path<Uuid>) -> AppResult<Json<DeletePreview>> {
    Ok(Json(impact(&state.db, id).await?))
}

/// Deletes an account. Boards only they were in are deleted (with their files); on shared boards they're
/// removed (if they were the only owner, the longest-standing other member becomes owner). Their comments
/// and history stay, shown as "[Deleted User] Name (username)". The username and email become free again.
pub async fn delete_user(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, Path(id): Path<Uuid>) -> AppResult<Json<serde_json::Value>> {
    if id == me.id {
        return Err(AppError::BadRequest("cannot_delete_self"));
    }
    let (username,): (String,) = sqlx::query_as("SELECT username FROM users WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    let plan = impact(&state.db, id).await?;
    let mut tx = state.db.begin().await?;
    for b in &plan.new_owner {
        // hand ownership to whoever joined the board earliest
        sqlx::query(
            "UPDATE board_members SET role_id = (SELECT id FROM board_roles WHERE board_id = $1 AND is_owner LIMIT 1)
             WHERE board_id = $1 AND user_id = (SELECT user_id FROM board_members WHERE board_id = $1 AND user_id <> $2
                                                ORDER BY added_at LIMIT 1)",
        )
        .bind(b.id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    for b in &plan.deleted {
        sqlx::query("DELETE FROM boards WHERE id = $1").bind(b.id).execute(&mut *tx).await?;
    }
    for q in [
        "DELETE FROM board_members WHERE user_id = $1",
        "DELETE FROM card_assignees WHERE user_id = $1",
        "DELETE FROM board_prefs WHERE user_id = $1",
        "DELETE FROM sessions WHERE user_id = $1",
        "DELETE FROM password_tokens WHERE user_id = $1",
    ] {
        sqlx::query(q).bind(id).execute(&mut *tx).await?;
    }
    sqlx::query(
        "UPDATE users SET deleted_at = now(), is_active = false, password_hash = NULL, email = NULL, totp_secret = NULL,
                is_super_admin = false, can_create_boards = false, updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    crate::avatars::purge_for_user(&state, id).await;
    sqlx::query("UPDATE users SET avatar_id = NULL WHERE id = $1").bind(id).execute(&state.db).await?;
    let mut files = 0;
    for b in &plan.deleted {
        files += crate::files::delete_board_objects(&state.store, b.id).await;
    }
    for b in plan.new_owner.iter() {
        state.hub.notify(b.id, "member", None, me.id);
    }
    tracing::info!(user = %username, by = %me.username, boards_deleted = plan.deleted.len(), files, "user deleted");
    Ok(Json(serde_json::json!({
        "ok": true,
        "boards_deleted": plan.deleted.len(),
        "boards_new_owner": plan.new_owner.len(),
        "files_deleted": files,
    })))
}
