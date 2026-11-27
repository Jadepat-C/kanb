//! Personal API tokens (Profile → API tokens). A script sends `Authorization: Bearer kanb_…` and acts as the
//! token's owner, with the owner's permissions:
//! - "read" tokens may only read (GET);
//! - no token may touch account security: tokens, password, two-factor sign-in, signed-in devices, single sign-on,
//!   sign-in itself, or the account's email address (which could otherwise be changed and used to reset the password);
//! - the account's own rules still apply (deactivated, must change password, two-factor required);
//! - a password reset by email, an admin-set password and the admin's "sign out everywhere" revoke them all.
//! Only a SHA-256 hash is stored. The `kanb_` prefix lets secret scanners recognise a leaked token.

use axum::{
    Json,
    extract::{Path, State},
    http::Method,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    audit::ClientIp,
    auth::{CurrentUser, User, USER_COLUMNS, new_token, token_hash},
    error::{AppError, AppResult},
};

pub const PREFIX: &str = "kanb_";
/// tokens one person may have
const MAX_TOKENS: i64 = 50;

/// What a request signed in with a token may not do, whatever its scope (paths without the /api prefix).
fn denied_path(path: &str) -> bool {
    const DENY: [&str; 6] = ["/me/tokens", "/me/password", "/me/2fa", "/me/sessions", "/me/sso", "/auth/"];
    DENY.iter().any(|d| path == d.trim_end_matches('/') || path.starts_with(d)) || path.ends_with("/ws")
}

/// The user behind `Authorization: Bearer <token>`, after the token's own rules. Err(Unauthorized) for a token that
/// doesn't exist, was revoked or has expired.
pub async fn authenticate(state: &AppState, token: &str, method: &Method, path: &str) -> AppResult<User> {
    if !token.starts_with(PREFIX) {
        return Err(AppError::Unauthorized);
    }
    let row: Option<(Uuid, Uuid, String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, user_id, scope, last_used_at FROM api_tokens WHERE token_hash = $1 AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(token_hash(token))
    .fetch_optional(&state.db)
    .await?;
    let (id, user_id, scope, last_used) = row.ok_or(AppError::Unauthorized)?;
    let user: User = sqlx::query_as(sqlf!("SELECT {USER_COLUMNS} FROM users WHERE id = $1 AND is_active AND deleted_at IS NULL"))
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::Unauthorized)?;
    if denied_path(path) {
        return Err(AppError::Denied("token_not_allowed"));
    }
    if scope == "read" && !matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return Err(AppError::Denied("token_read_only"));
    }
    // "last used", written at most once a minute
    if last_used.is_none_or(|t| Utc::now() - t > Duration::minutes(1)) {
        sqlx::query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1").bind(id).execute(&state.db).await?;
        sqlx::query("UPDATE users SET last_seen_at = now() WHERE id = $1").bind(user_id).execute(&state.db).await?;
    }
    Ok(user)
}

/// Every token of `user` stops working (password reset, admin sign-out). Returns how many there were.
pub async fn revoke_all(db: &sqlx::PgPool, user: Uuid) -> AppResult<u64> {
    Ok(sqlx::query("DELETE FROM api_tokens WHERE user_id = $1").bind(user).execute(db).await?.rows_affected())
}

#[derive(Serialize, sqlx::FromRow)]
pub struct TokenInfo {
    id: Uuid,
    name: String,
    prefix: String,
    scope: String,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
}

/// GET /me/tokens
pub async fn list(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Vec<TokenInfo>>> {
    Ok(Json(
        sqlx::query_as("SELECT id, name, prefix, scope, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC")
            .bind(u.id)
            .fetch_all(&state.db)
            .await?,
    ))
}

#[derive(Deserialize)]
pub struct CreateReq {
    name: String,
    scope: String,
    /// days until it stops working; None = never
    expires_days: Option<i64>,
}

/// POST /me/tokens: the token itself is in the answer, and never again.
pub async fn create(State(state): State<AppState>, CurrentUser(u): CurrentUser, ClientIp(ip): ClientIp, Json(r): Json<CreateReq>) -> AppResult<Json<Value>> {
    let name: String = r.name.trim().chars().take(80).collect();
    if name.is_empty() {
        return Err(AppError::BadRequest("name_required"));
    }
    if !matches!(r.scope.as_str(), "read" | "write") {
        return Err(AppError::BadRequest("invalid_scope"));
    }
    if r.expires_days.is_some_and(|d| !(1..=3650).contains(&d)) {
        return Err(AppError::BadRequest("invalid_expiry"));
    }
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM api_tokens WHERE user_id = $1").bind(u.id).fetch_one(&state.db).await?;
    if n >= MAX_TOKENS {
        return Err(AppError::BadRequest("too_many_tokens"));
    }
    let token = format!("{PREFIX}{}", new_token());
    let id = Uuid::now_v7();
    let info: TokenInfo = sqlx::query_as(
        "INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::int8 IS NULL THEN NULL ELSE now() + make_interval(days => $7::int4) END)
         RETURNING id, name, prefix, scope, created_at, last_used_at, expires_at",
    )
    .bind(id)
    .bind(u.id)
    .bind(&name)
    .bind(token_hash(&token))
    .bind(token.chars().take(PREFIX.len() + 6).collect::<String>())
    .bind(&r.scope)
    .bind(r.expires_days)
    .fetch_one(&state.db)
    .await?;
    crate::audit::log(&state, Some(u.id), "token_created", Some(u.id), ip.as_deref(), json!({ "name": name, "scope": r.scope })).await;
    Ok(Json(json!({ "token": token, "info": info })))
}

/// DELETE /me/tokens/{id}
pub async fn revoke(State(state): State<AppState>, CurrentUser(u): CurrentUser, ClientIp(ip): ClientIp, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let gone: Option<(String,)> = sqlx::query_as("DELETE FROM api_tokens WHERE id = $1 AND user_id = $2 RETURNING name")
        .bind(id)
        .bind(u.id)
        .fetch_optional(&state.db)
        .await?;
    let (name,) = gone.ok_or(AppError::NotFound)?;
    crate::audit::log(&state, Some(u.id), "token_revoked", Some(u.id), ip.as_deref(), json!({ "name": name })).await;
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    #[test]
    fn account_security_is_off_limits() {
        for p in ["/me/tokens", "/me/tokens/123", "/me/password", "/me/2fa/setup", "/me/sessions", "/me/sso/link", "/auth/logout", "/boards/1/ws", "/notifications/ws"] {
            assert!(super::denied_path(p), "{p}");
        }
        for p in ["/me", "/boards", "/cards/1", "/me/timer", "/me/contact-points", "/search"] {
            assert!(!super::denied_path(p), "{p}");
        }
    }
}
