//! Local accounts + cookie sessions (stored hashed in Postgres) + CSRF origin check.

use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};
use axum::{
    Json,
    extract::{FromRequestParts, Request, State},
    http::{HeaderMap, Method, header, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AppResult},
};

pub const COOKIE_NAME: &str = "kanban_session";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub email: Option<String>,
    pub is_super_admin: bool,
    pub can_create_boards: bool,
    pub is_active: bool,
    pub locale: String,
    pub theme: String,
    pub avatar_color: String,
    pub created_at: DateTime<Utc>,
}

pub const USER_COLUMNS: &str = "id, username, display_name, email, is_super_admin, can_create_boards, \
     is_active, locale, theme, avatar_color, created_at";

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hash: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

pub fn validate_password(p: &str) -> AppResult<()> {
    if p.chars().count() < 8 {
        return Err(AppError::BadRequest("password_too_short"));
    }
    Ok(())
}

/// Request field semantics: absent = leave unchanged, "" = remove the email, otherwise a validated address.
pub fn normalize_email(e: Option<String>) -> AppResult<Option<Option<String>>> {
    let Some(e) = e else { return Ok(None) };
    let e = e.trim().to_string();
    if e.is_empty() {
        return Ok(Some(None));
    }
    let valid = e.len() <= 254
        && !e.chars().any(char::is_whitespace)
        && matches!(e.split_once('@'), Some((local, domain)) if !local.is_empty() && !domain.contains('@')
            && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'));
    if !valid {
        return Err(AppError::BadRequest("invalid_email"));
    }
    Ok(Some(Some(e)))
}

/// Emails sign people in, so they must be unique (case-insensitive).
pub async fn ensure_email_free(db: &sqlx::PgPool, email: &str, except: Option<Uuid>) -> AppResult<()> {
    let taken: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE lower(email) = lower($1) AND ($2::uuid IS NULL OR id <> $2)")
        .bind(email)
        .bind(except)
        .fetch_optional(db)
        .await?;
    if taken.is_some() { Err(AppError::Conflict("email_taken")) } else { Ok(()) }
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn new_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("os rng");
    hex::encode(buf)
}

/// Authenticated user extracted from the session cookie.
#[derive(Debug, Clone)]
pub struct CurrentUser(pub User);

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if let Some(u) = parts.extensions.get::<CurrentUser>() {
            return Ok(u.clone());
        }
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar.get(COOKIE_NAME).ok_or(AppError::Unauthorized)?.value().to_string();
        let hash = token_hash(&token);
        let row: Option<(DateTime<Utc>,)> =
            sqlx::query_as("SELECT last_seen_at FROM sessions WHERE token_hash = $1 AND expires_at > now()")
                .bind(&hash)
                .fetch_optional(&state.db)
                .await?;
        let (last_seen,) = row.ok_or(AppError::Unauthorized)?;
        let user: User = sqlx::query_as(sqlf!(
            "SELECT {USER_COLUMNS} FROM users u WHERE id = (SELECT user_id FROM sessions WHERE token_hash = $1) AND is_active"
        ))
        .bind(&hash)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::Unauthorized)?;
        // sliding expiry, written at most every 10 minutes
        if Utc::now() - last_seen > Duration::minutes(10) {
            sqlx::query("UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2) WHERE token_hash = $1")
                .bind(&hash)
                .bind(state.config.session_days as i32)
                .execute(&state.db)
                .await?;
        }
        let cu = CurrentUser(user);
        parts.extensions.insert(cu.clone());
        Ok(cu)
    }
}

/// Super-admin-only extractor.
pub struct SuperAdmin(pub User);

impl FromRequestParts<AppState> for SuperAdmin {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let CurrentUser(u) = CurrentUser::from_request_parts(parts, state).await?;
        if !u.is_super_admin {
            return Err(AppError::Forbidden);
        }
        Ok(SuperAdmin(u))
    }
}

/// Rejects state-changing requests (and WebSocket upgrades) from foreign origins.
pub async fn csrf_guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let is_ws = req
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) && !is_ws;
    if !safe && !origin_ok(req.headers(), &state.origins) {
        return AppError::Forbidden.into_response();
    }
    next.run(req).await
}

fn origin_ok(headers: &HeaderMap, allowed: &[String]) -> bool {
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        return allowed.iter().any(|a| a == origin);
    }
    // No Origin header: only accept if the browser says it's same-origin (or non-browser clients without either header).
    match headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        Some(site) => site == "same-origin" || site == "none",
        None => true,
    }
}

#[derive(Deserialize)]
pub struct LoginReq {
    /// username or email address
    username: String,
    password: String,
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(req): Json<LoginReq>,
) -> AppResult<(CookieJar, Json<User>)> {
    let row: Option<(Uuid, Option<String>, bool)> =
        // usernames can't contain '@', so anything with '@' is looked up as an email
        sqlx::query_as(
            "SELECT id, password_hash, is_active FROM users
             WHERE CASE WHEN strpos($1, '@') > 0 THEN lower(email) = lower($1) ELSE lower(username) = lower($1) END",
        )
            .bind(req.username.trim())
            .fetch_optional(&state.db)
            .await?;
    let password = req.password.clone();
    let ok = match &row {
        Some((_, Some(hash), true)) => {
            let hash = hash.clone();
            tokio::task::spawn_blocking(move || verify_password(&password, &hash))
                .await
                .map_err(|e| anyhow::anyhow!(e))?
        }
        _ => {
            // constant-ish time for unknown users
            let _ = tokio::task::spawn_blocking(move || hash_password(&password)).await;
            false
        }
    };
    if !ok {
        tracing::warn!(username = %req.username, "failed login");
        return Err(AppError::BadRequest("invalid_credentials"));
    }
    let user_id = row.unwrap().0;
    let token = new_token();
    let ua = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|s| s.chars().take(300).collect::<String>());
    sqlx::query("INSERT INTO sessions (token_hash, user_id, user_agent, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))")
        .bind(token_hash(&token))
        .bind(user_id)
        .bind(ua)
        .bind(state.config.session_days as i32)
        .execute(&state.db)
        .await?;
    // opportunistic cleanup
    sqlx::query("DELETE FROM sessions WHERE expires_at < now()").execute(&state.db).await?;

    let user: User = sqlx::query_as(sqlf!("SELECT {USER_COLUMNS} FROM users WHERE id = $1"))
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
    let cookie = Cookie::build((COOKIE_NAME, token))
        .http_only(true)
        .secure(state.config.cookie_secure)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time_days(state.config.session_days))
        .build();
    Ok((jar.add(cookie), Json(user)))
}

fn time_days(d: i64) -> time::Duration {
    time::Duration::days(d)
}

pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> AppResult<CookieJar> {
    if let Some(c) = jar.get(COOKIE_NAME) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(token_hash(c.value()))
            .execute(&state.db)
            .await?;
    }
    Ok(jar.remove(Cookie::build(COOKIE_NAME).path("/")))
}

pub async fn me(CurrentUser(u): CurrentUser) -> Json<User> {
    Json(u)
}

#[derive(Deserialize)]
pub struct UpdateMe {
    display_name: Option<String>,
    email: Option<String>,
    locale: Option<String>,
    theme: Option<String>,
    avatar_color: Option<String>,
}

pub async fn update_me(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Json(req): Json<UpdateMe>,
) -> AppResult<Json<User>> {
    if let Some(l) = &req.locale
        && !["en", "th"].contains(&l.as_str())
    {
        return Err(AppError::BadRequest("invalid_locale"));
    }
    if let Some(t) = &req.theme
        && !["light", "dark", "system"].contains(&t.as_str())
    {
        return Err(AppError::BadRequest("invalid_theme"));
    }
    if let Some(n) = &req.display_name
        && n.trim().is_empty()
    {
        return Err(AppError::BadRequest("name_required"));
    }
    let email = normalize_email(req.email.clone())?;
    if let Some(Some(e)) = &email {
        ensure_email_free(&state.db, e, Some(u.id)).await?;
    }
    let user: User = sqlx::query_as(sqlf!(
        "UPDATE users SET display_name = COALESCE($2, display_name), email = CASE WHEN $7 THEN $3 ELSE email END, \
         locale = COALESCE($4, locale), theme = COALESCE($5, theme), avatar_color = COALESCE($6, avatar_color), \
         updated_at = now() WHERE id = $1 RETURNING {USER_COLUMNS}"
    ))
    .bind(u.id)
    .bind(req.display_name.map(|s| s.trim().to_string()))
    .bind(email.clone().flatten())
    .bind(req.locale)
    .bind(req.theme)
    .bind(req.avatar_color)
    .bind(email.is_some())
    .fetch_one(&state.db)
    .await?;
    Ok(Json(user))
}

#[derive(Deserialize)]
pub struct ChangePassword {
    current_password: String,
    new_password: String,
}

pub async fn change_password(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    jar: CookieJar,
    Json(req): Json<ChangePassword>,
) -> AppResult<Json<serde_json::Value>> {
    validate_password(&req.new_password)?;
    let (hash,): (Option<String>,) = sqlx::query_as("SELECT password_hash FROM users WHERE id = $1")
        .bind(u.id)
        .fetch_one(&state.db)
        .await?;
    let cur = req.current_password.clone();
    let ok = match hash {
        Some(h) => tokio::task::spawn_blocking(move || verify_password(&cur, &h)).await.map_err(|e| anyhow::anyhow!(e))?,
        None => false,
    };
    if !ok {
        return Err(AppError::BadRequest("invalid_credentials"));
    }
    let np = req.new_password.clone();
    let new_hash = tokio::task::spawn_blocking(move || hash_password(&np)).await.map_err(|e| anyhow::anyhow!(e))??;
    sqlx::query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1")
        .bind(u.id)
        .bind(new_hash)
        .execute(&state.db)
        .await?;
    // sign out every other session
    let current = jar.get(COOKIE_NAME).map(|c| token_hash(c.value())).unwrap_or_default();
    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2")
        .bind(u.id)
        .bind(current)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
