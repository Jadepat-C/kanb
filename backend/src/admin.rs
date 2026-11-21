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

const AVATAR_COLORS: &[&str] = &["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"];

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
) -> AppResult<User> {
    let username = validate_username(username)?;
    validate_password(password)?;
    let display_name = if display_name.trim().is_empty() { username.clone() } else { display_name.trim().to_string() };
    let pw = password.to_string();
    let hash = tokio::task::spawn_blocking(move || hash_password(&pw)).await.map_err(|e| anyhow::anyhow!(e))??;
    let id = Uuid::now_v7();
    let color = AVATAR_COLORS[(id.as_u128() % AVATAR_COLORS.len() as u128) as usize];
    let user: User = sqlx::query_as(sqlf!(
        "INSERT INTO users (id, username, display_name, email, password_hash, is_super_admin, can_create_boards, avatar_color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING {USER_COLUMNS}"
    ))
    .bind(id)
    .bind(&username)
    .bind(display_name)
    .bind(email.map(|e| e.trim().to_string()).filter(|e| !e.is_empty()))
    .bind(hash)
    .bind(is_super_admin)
    .bind(can_create_boards)
    .bind(color)
    .fetch_one(db)
    .await?;
    Ok(user)
}

pub async fn list_users(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<Vec<User>>> {
    let users: Vec<User> = sqlx::query_as(sqlf!("SELECT {USER_COLUMNS} FROM users ORDER BY lower(display_name)"))
        .fetch_all(&state.db)
        .await?;
    Ok(Json(users))
}

pub async fn create_user(
    State(state): State<AppState>,
    _a: SuperAdmin,
    Json(r): Json<CreateUser>,
) -> AppResult<Json<User>> {
    let u = insert_user(&state.db, &r.username, &r.display_name, r.email, &r.password, r.is_super_admin, r.can_create_boards)
        .await
        .map_err(|e| match e {
            AppError::Conflict(_) => AppError::Conflict("username_taken"),
            e => e,
        })?;
    Ok(Json(u))
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
    let user: User = sqlx::query_as(sqlf!(
        "UPDATE users SET display_name = COALESCE($2, display_name), email = COALESCE($3, email),
         is_super_admin = COALESCE($4, is_super_admin), can_create_boards = COALESCE($5, can_create_boards),
         is_active = COALESCE($6, is_active), updated_at = now() WHERE id = $1 RETURNING {USER_COLUMNS}"
    ))
    .bind(id)
    .bind(r.display_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    .bind(r.email.map(|s| s.trim().to_string()))
    .bind(r.is_super_admin)
    .bind(r.can_create_boards)
    .bind(r.is_active)
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
    let res = sqlx::query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1")
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
}

pub async fn directory(State(state): State<AppState>, _u: CurrentUser) -> AppResult<Json<Vec<UserBrief>>> {
    let users: Vec<UserBrief> = sqlx::query_as(
        "SELECT id, username, display_name, avatar_color FROM users WHERE is_active ORDER BY lower(display_name)",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(users))
}
