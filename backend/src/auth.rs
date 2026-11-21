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
    pub must_change_password: bool,
    pub avatar_id: Option<Uuid>,
    pub notify_email: bool,
    /// two-factor sign-in (authenticator app) is on
    pub totp_enabled: bool,
    pub created_at: DateTime<Utc>,
}

pub const USER_COLUMNS: &str = "id, username, display_name, email, is_super_admin, can_create_boards, \
     is_active, locale, theme, avatar_color, must_change_password, avatar_id, notify_email, \
     (totp_enabled_at IS NOT NULL) AS totp_enabled, created_at";

/// How a user's name is shown in history: "Name · @username"; deleted accounts read "[Deleted User] Name (username)".
/// Use with the users table aliased as `u`.
pub const DISPLAY_NAME_SQL: &str =
    "CASE WHEN u.deleted_at IS NOT NULL THEN '[Deleted User] ' || u.display_name || ' (' || u.username || ')' ELSE u.display_name || ' · @' || u.username END";

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
    let taken: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2)",
    )
        .bind(email)
        .bind(except)
        .fetch_optional(db)
        .await?;
    if taken.is_some() { Err(AppError::Conflict("email_taken")) } else { Ok(()) }
}

pub(crate) fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub(crate) fn new_token() -> String {
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
        // Until an admin-set password has been replaced, only "change my password" (and reading /me) works.
        if user.must_change_password {
            let path = parts
                .extensions
                .get::<axum::extract::OriginalUri>()
                .map(|u| u.path().to_string())
                .unwrap_or_else(|| parts.uri.path().to_string());
            let allowed = ["/api/me", "/api/me/password", "/api/auth/logout", "/me", "/me/password", "/auth/logout"];
            if !allowed.contains(&path.as_str()) {
                return Err(AppError::Forbidden);
            }
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
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    let row: Option<(Uuid, Option<String>, bool, bool)> =
        // usernames can't contain '@', so anything with '@' is looked up as an email
        sqlx::query_as(
            "SELECT id, password_hash, is_active, totp_enabled_at IS NOT NULL FROM users
             WHERE deleted_at IS NULL
               AND CASE WHEN strpos($1, '@') > 0 THEN lower(email) = lower($1) ELSE lower(username) = lower($1) END",
        )
            .bind(req.username.trim())
            .fetch_optional(&state.db)
            .await?;
    let password = req.password.clone();
    let ok = match &row {
        Some((_, Some(hash), true, _)) => {
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
    let (user_id, _, _, totp_on) = row.unwrap();
    if totp_on {
        // step 2: the authenticator code (POST /auth/login/code with this ticket)
        let ticket = crate::twofa::start_challenge(&state, user_id).await?;
        return Ok((jar, Json(serde_json::json!({ "totp_required": true, "ticket": ticket }))));
    }
    let (jar, Json(user)) = start_session(&state, user_id, &headers, jar).await?;
    Ok((jar, Json(serde_json::to_value(user).map_err(|e| anyhow::anyhow!(e))?)))
}

/// Signs the user in: new session row + cookie.
pub async fn start_session(state: &AppState, user_id: Uuid, headers: &HeaderMap, jar: CookieJar) -> AppResult<(CookieJar, Json<User>)> {
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
    notify_email: Option<bool>,
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
         locale = COALESCE($4, locale), theme = COALESCE($5, theme), avatar_color = COALESCE($6, avatar_color), notify_email = COALESCE($8, notify_email), \
         updated_at = now() WHERE id = $1 RETURNING {USER_COLUMNS}"
    ))
    .bind(u.id)
    .bind(req.display_name.map(|s| s.trim().to_string()))
    .bind(email.clone().flatten())
    .bind(req.locale)
    .bind(req.theme)
    .bind(req.avatar_color)
    .bind(email.is_some())
    .bind(req.notify_email)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(user))
}

#[derive(Deserialize)]
pub struct ChangePassword {
    #[serde(default)]
    current_password: Option<String>,
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
    let cur = req.current_password.clone().unwrap_or_default();
    // right after an admin-set password (forced change) the user just proved it by signing in
    let ok = u.must_change_password
        || match hash {
            Some(h) => tokio::task::spawn_blocking(move || verify_password(&cur, &h)).await.map_err(|e| anyhow::anyhow!(e))?,
            None => false,
        };
    if !ok {
        return Err(AppError::BadRequest("invalid_credentials"));
    }
    let np = req.new_password.clone();
    let new_hash = tokio::task::spawn_blocking(move || hash_password(&np)).await.map_err(|e| anyhow::anyhow!(e))??;
    sqlx::query("UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1")
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

// ---------- one-time links: welcome (set your password) and forgot password ----------

/// Creates a one-time token for `purpose` (invite | reset), valid for `hours`. Returns the raw token.
pub async fn create_password_token(db: &sqlx::PgPool, user_id: Uuid, purpose: &str, hours: i32) -> AppResult<String> {
    let token = new_token();
    sqlx::query(
        "INSERT INTO password_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4))",
    )
    .bind(token_hash(&token))
    .bind(user_id)
    .bind(purpose)
    .bind(hours)
    .execute(db)
    .await?;
    Ok(token)
}

/// Emails a set-password (invite) or reset link. Err = SMTP error text for the admin.
pub async fn send_link_email(state: &AppState, user_id: Uuid, purpose: &str) -> Result<(), String> {
    let s = crate::mail::load(state).await.map_err(|e| e.to_string())?;
    if !crate::mail::ready(&s) {
        return Err("email is not set up".into());
    }
    let (name, username, email, locale): (String, String, Option<String>, String) =
        sqlx::query_as("SELECT display_name, username, email, locale FROM users WHERE id = $1 AND deleted_at IS NULL")
            .bind(user_id)
            .fetch_one(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    let email = email.ok_or("user has no email")?;
    let hours = if purpose == "invite" { 72 } else { 1 };
    let token = create_password_token(&state.db, user_id, purpose, hours).await.map_err(|e| e.to_string())?;
    let base = crate::mail::base_url(state, &s);
    let link = format!("{base}/reset-password?token={token}");
    let (subject, text, html) = crate::mail::link_email(purpose, &locale, &name, &username, &link, &format!("{base}/login"));
    crate::mail::send(&s, &email, &name, &subject, text, html).await
}

/// Public: whether the login page should offer "Forgot password?".
pub async fn options(State(state): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let s = crate::mail::load(&state).await?;
    Ok(Json(serde_json::json!({ "email_enabled": crate::mail::ready(&s) })))
}

#[derive(Deserialize)]
pub struct ForgotReq {
    /// username or email
    login: String,
}

/// Always answers the same way, so it can't be used to find out which accounts/emails exist.
pub async fn forgot(State(state): State<AppState>, Json(r): Json<ForgotReq>) -> AppResult<Json<serde_json::Value>> {
    let s = crate::mail::load(&state).await?;
    if !crate::mail::ready(&s) {
        return Err(AppError::BadRequest("email_disabled"));
    }
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM users WHERE deleted_at IS NULL AND is_active AND email IS NOT NULL
           AND CASE WHEN strpos($1, '@') > 0 THEN lower(email) = lower($1) ELSE lower(username) = lower($1) END
           AND NOT EXISTS (SELECT 1 FROM password_tokens t WHERE t.user_id = users.id AND t.purpose = 'reset'
                           AND t.created_at > now() - interval '1 minute')",
    )
    .bind(r.login.trim())
    .fetch_optional(&state.db)
    .await?;
    if let Some((uid,)) = row {
        // send in the background: the response time must not reveal whether the account exists
        let st = state.clone();
        tokio::spawn(async move {
            if let Err(e) = send_link_email(&st, uid, "reset").await {
                tracing::warn!(error = %e, user = %uid, "password reset email failed");
            }
        });
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct TokenReq {
    token: String,
}

/// Lets the reset page say "this link has expired" before the user types a new password.
pub async fn check_token(State(state): State<AppState>, Json(r): Json<TokenReq>) -> AppResult<Json<serde_json::Value>> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT u.username, t.purpose FROM password_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.deleted_at IS NULL AND u.is_active",
    )
    .bind(token_hash(&r.token))
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(match row {
        Some((username, purpose)) => serde_json::json!({ "valid": true, "username": username, "purpose": purpose }),
        None => serde_json::json!({ "valid": false }),
    }))
}

#[derive(Deserialize)]
pub struct ResetReq {
    token: String,
    password: String,
}

pub async fn reset(State(state): State<AppState>, Json(r): Json<ResetReq>) -> AppResult<Json<serde_json::Value>> {
    validate_password(&r.password)?;
    let mut tx = state.db.begin().await?;
    let row: Option<(Uuid,)> = sqlx::query_as(
        "UPDATE password_tokens t SET used_at = now() FROM users u
         WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
           AND u.id = t.user_id AND u.deleted_at IS NULL AND u.is_active
         RETURNING t.user_id",
    )
    .bind(token_hash(&r.token))
    .fetch_optional(&mut *tx)
    .await?;
    let (uid,) = row.ok_or(AppError::BadRequest("invalid_token"))?;
    let pw = r.password.clone();
    let hash = tokio::task::spawn_blocking(move || hash_password(&pw)).await.map_err(|e| anyhow::anyhow!(e))??;
    sqlx::query("UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1")
        .bind(uid)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    // every other outstanding link and every session dies with the old password
    sqlx::query("UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL").bind(uid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(uid).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
