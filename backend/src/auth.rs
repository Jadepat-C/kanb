//! Local accounts + cookie sessions (stored hashed in Postgres) + CSRF origin check.

use argon2::{
    Argon2,
    password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash},
};
use axum::{
    Json,
    extract::{ConnectInfo, FromRequestParts, Request, State},
    http::{HeaderMap, Method, header, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use uuid::Uuid;

use crate::{
    AppState,
    error::{AppError, AppResult},
    throttle,
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
    /// what to notify this person about (notify::KINDS)
    pub notify_events: Vec<String>,
    /// two-factor sign-in (authenticator app) is on
    pub totp_enabled: bool,
    /// last time the account used Kanb (None = not recorded yet, not "never")
    pub last_seen_at: Option<DateTime<Utc>>,
    /// an admin requires two-factor sign-in for everyone (see admin::SECURITY_KEY)
    pub require_2fa: bool,
    /// false for accounts made by single sign-on that never set a password
    pub has_password: bool,
    /// Admin → Departments
    pub department_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

pub const USER_COLUMNS: &str = "id, username, display_name, email, is_super_admin, can_create_boards, \
     is_active, locale, theme, avatar_color, must_change_password, avatar_id, notify_email, notify_events, \
     (totp_enabled_at IS NOT NULL) AS totp_enabled, last_seen_at, \
     COALESCE((SELECT (value->>'require_2fa')::boolean FROM app_settings WHERE key = 'security'), false) AS require_2fa, \
     (password_hash IS NOT NULL) AS has_password, department_id, created_at";

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

/// Argon2id deliberately uses about 19 MB of memory per hash or check (that's what makes stolen hashes expensive to
/// crack). Unbounded, a burst of simultaneous sign-in attempts, even wrong ones, could run a small server out of
/// memory; at most two run at once and the rest wait their turn (each takes tens of milliseconds).
static PASSWORD_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// `hash_password` off the async runtime, within the password slots.
pub async fn hash_password_bounded(password: String) -> AppResult<String> {
    let _slot = PASSWORD_SLOTS.acquire().await.map_err(|e| anyhow::anyhow!(e))?;
    Ok(tokio::task::spawn_blocking(move || hash_password(&password)).await.map_err(|e| anyhow::anyhow!(e))??)
}

/// `verify_password` off the async runtime, within the password slots.
pub async fn verify_password_bounded(password: String, hash: String) -> AppResult<bool> {
    let _slot = PASSWORD_SLOTS.acquire().await.map_err(|e| anyhow::anyhow!(e))?;
    Ok(tokio::task::spawn_blocking(move || verify_password(&password, &hash)).await.map_err(|e| anyhow::anyhow!(e))?)
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
        let path = parts
            .extensions
            .get::<axum::extract::OriginalUri>()
            .map(|u| u.path().to_string())
            .unwrap_or_else(|| parts.uri.path().to_string());
        let path = path.strip_prefix("/api").unwrap_or(&path).to_string();
        // an API token: only the token counts (never a cookie sent along with it). Other Authorization headers (a
        // reverse proxy's Basic auth in front of Kanb, say) are none of our business: the session cookie decides.
        if let Some(token) = bearer(&parts.headers) {
            let user = crate::tokens::authenticate(state, &token, &parts.method, &path).await?;
            gate(&user, &path, false)?;
            let cu = CurrentUser(user);
            parts.extensions.insert(cu.clone());
            return Ok(cu);
        }
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar.get(COOKIE_NAME).ok_or(AppError::Unauthorized)?.value().to_string();
        let hash = token_hash(&token);
        let row: Option<(DateTime<Utc>, String)> =
            sqlx::query_as("SELECT last_seen_at, method FROM sessions WHERE token_hash = $1 AND expires_at > now()")
                .bind(&hash)
                .fetch_optional(&state.db)
                .await?;
        let (last_seen, method) = row.ok_or(AppError::Unauthorized)?;
        // signed in through the provider: it checked who this is (and its own two-factor), so neither an
        // admin-set password nor Kanb's "require two-factor" stands in the way
        let sso = method == "sso";
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
            sqlx::query("UPDATE users SET last_seen_at = now() WHERE id = $1").bind(user.id).execute(&state.db).await?;
        }
        gate(&user, &path, sso)?;
        let cu = CurrentUser(user);
        parts.extensions.insert(cu.clone());
        Ok(cu)
    }
}

/// The API token in `Authorization: Bearer …`, if any.
pub fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let t = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))?.trim();
    Some(t.to_string())
}

/// What a signed-in account may still not do. Until an admin-set password has been replaced, only "change my
/// password" (and reading /me) works; while two-factor sign-in is required and not set up, only setting it up does.
/// Neither applies to a single sign-on session (the provider checked who this is, and its own two-factor).
fn gate(user: &User, path: &str, sso: bool) -> AppResult<()> {
    if sso {
        return Ok(());
    }
    if user.must_change_password {
        if !["/me", "/me/password", "/auth/logout"].contains(&path) {
            return Err(AppError::Forbidden);
        }
    } else if user.require_2fa && !user.totp_enabled && !["/me", "/me/2fa/setup", "/me/2fa/enable", "/auth/logout"].contains(&path) {
        return Err(AppError::TwoFactorRequired);
    }
    Ok(())
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
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(req): Json<LoginReq>,
) -> AppResult<(CookieJar, Json<serde_json::Value>)> {
    // rate limits come before the (deliberately slow) password check
    let ip = throttle::ip_key("login", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    state.throttle.check(&ip, throttle::LOGIN_IP)?;
    let row: Option<(Uuid, Option<String>, bool, bool, Option<String>, bool)> =
        // usernames can't contain '@', so anything with '@' is looked up as an email
        sqlx::query_as(
            "SELECT id, password_hash, is_active, totp_enabled_at IS NOT NULL, signup, is_super_admin FROM users
             WHERE deleted_at IS NULL
               AND CASE WHEN strpos($1, '@') > 0 THEN lower(email) = lower($1) ELSE lower(username) = lower($1) END",
        )
            .bind(req.username.trim())
            .fetch_optional(&state.db)
            .await?;
    // unknown names are counted the same way, so a 429 doesn't reveal which accounts exist
    let account = match &row {
        Some((id, ..)) => format!("login-account:{id}"),
        None => throttle::account_key("login-account", &req.username),
    };
    state.throttle.check(&account, throttle::LOGIN_ACCOUNT)?;
    let password = req.password.clone();
    let ok = match &row {
        // a self sign-up still waiting is checked too, to tell its owner why they can't sign in yet
        Some((_, Some(hash), true, _, _, _)) | Some((_, Some(hash), _, _, Some(_), _)) => {
            let hash = hash.clone();
            verify_password_bounded(password, hash).await?
        }
        _ => {
            // constant-ish time for unknown users
            let _ = hash_password_bounded(password).await;
            false
        }
    };
    let client = throttle::client_ip(peer, &headers, state.config.trust_proxy).to_string();
    if !ok {
        state.throttle.hit(&ip, throttle::LOGIN_IP);
        state.throttle.hit(&account, throttle::LOGIN_ACCOUNT);
        tracing::warn!(username = %req.username, "failed login");
        // a known account by id; for an unknown name only a short copy of what was typed
        let data = match &row {
            Some(_) => serde_json::json!({}),
            None => serde_json::json!({ "typed": req.username.trim().chars().take(40).collect::<String>() }),
        };
        crate::audit::log(&state, None, "sign_in_failed", row.as_ref().map(|r| r.0), Some(&client), data).await;
        crate::metrics::sign_in("failed");
        return Err(AppError::SignInFailed("invalid_credentials"));
    }
    state.throttle.clear(&account);
    let (user_id, _, _, totp_on, signup, super_admin) = row.unwrap();
    match signup.as_deref() {
        Some("email") => return Err(AppError::Denied("email_not_confirmed")),
        Some(_) => return Err(AppError::Denied("pending_approval")),
        None => {}
    }
    // single sign-on required: passwords only for super admins (so a broken provider can't lock everyone out)
    if !super_admin && crate::sso::required(&state).await {
        return Err(AppError::Denied("sso_required"));
    }
    if totp_on {
        // step 2: the authenticator code (POST /auth/login/code with this ticket)
        let ticket = crate::twofa::start_challenge(&state, user_id).await?;
        return Ok((jar, Json(serde_json::json!({ "totp_required": true, "ticket": ticket }))));
    }
    let (jar, Json(user)) = start_session(&state, user_id, &headers, jar, Some(&client), "password").await?;
    Ok((jar, Json(serde_json::to_value(user).map_err(|e| anyhow::anyhow!(e))?)))
}

/// Signs the user in: new session row + cookie, "last active", and a sign-in entry in the activity log.
/// `method`: password | totp | recovery | setup | signup | sso.
pub async fn start_session(
    state: &AppState,
    user_id: Uuid,
    headers: &HeaderMap,
    jar: CookieJar,
    ip: Option<&str>,
    method: &str,
) -> AppResult<(CookieJar, Json<User>)> {
    crate::metrics::sign_in("ok");
    let token = new_token();
    let ua = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|s| s.chars().take(300).collect::<String>());
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, user_agent, ip, expires_at, method) VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), $6)",
    )
    .bind(token_hash(&token))
    .bind(user_id)
    .bind(&ua)
    .bind(ip)
    .bind(state.config.session_days as i32)
    .bind(method)
    .execute(&state.db)
    .await?;
    sqlx::query("UPDATE users SET last_seen_at = now() WHERE id = $1").bind(user_id).execute(&state.db).await?;
    crate::audit::log(state, Some(user_id), "sign_in", Some(user_id), ip, serde_json::json!({ "method": method, "device": ua.map(|u| device_name(&u)) }))
        .await;
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

pub async fn logout(State(state): State<AppState>, crate::audit::ClientIp(ip): crate::audit::ClientIp, jar: CookieJar) -> AppResult<CookieJar> {
    if let Some(c) = jar.get(COOKIE_NAME) {
        let gone: Option<(Uuid,)> = sqlx::query_as("DELETE FROM sessions WHERE token_hash = $1 RETURNING user_id")
            .bind(token_hash(c.value()))
            .fetch_optional(&state.db)
            .await?;
        if let Some((uid,)) = gone {
            crate::audit::log(&state, Some(uid), "sign_out", Some(uid), ip.as_deref(), serde_json::json!({})).await;
        }
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
    notify_events: Option<Vec<String>>,
}

pub async fn update_me(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    headers: HeaderMap,
    Json(req): Json<UpdateMe>,
) -> AppResult<Json<User>> {
    // an API token can't change where password-reset emails go
    if req.email.is_some() && bearer(&headers).is_some() {
        return Err(AppError::Denied("token_not_allowed"));
    }
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
         notify_events = COALESCE($9, notify_events), updated_at = now() WHERE id = $1 RETURNING {USER_COLUMNS}"
    ))
    .bind(u.id)
    .bind(req.display_name.map(|s| s.trim().to_string()))
    .bind(email.clone().flatten())
    .bind(req.locale)
    .bind(req.theme)
    .bind(req.avatar_color)
    .bind(email.is_some())
    .bind(req.notify_email)
    // known kinds only, kept in display order
    .bind(req.notify_events.map(|e| crate::notify::KINDS.iter().filter(|k| e.iter().any(|x| x == *k)).map(|k| k.to_string()).collect::<Vec<_>>()))
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
    crate::audit::ClientIp(ip): crate::audit::ClientIp,
    jar: CookieJar,
    Json(req): Json<ChangePassword>,
) -> AppResult<Json<serde_json::Value>> {
    if !u.is_super_admin && crate::sso::required(&state).await {
        return Err(AppError::Denied("sso_required"));
    }
    validate_password(&req.new_password)?;
    let (hash,): (Option<String>,) = sqlx::query_as("SELECT password_hash FROM users WHERE id = $1")
        .bind(u.id)
        .fetch_one(&state.db)
        .await?;
    let cur = req.current_password.clone().unwrap_or_default();
    // right after an admin-set password (forced change) the user just proved it by signing in; an account made by
    // single sign-on has no password yet and may set its first one
    let ok = u.must_change_password
        || match hash {
            Some(h) => verify_password_bounded(cur, h).await?,
            None => true,
        };
    if !ok {
        return Err(AppError::BadRequest("invalid_credentials"));
    }
    let np = req.new_password.clone();
    let new_hash = hash_password_bounded(np).await?;
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
    crate::audit::log(&state, Some(u.id), "password_changed", Some(u.id), ip.as_deref(), serde_json::json!({ "forced": u.must_change_password })).await;
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
    send_link_email_for(state, user_id, purpose, if purpose == "invite" { 72 } else { 1 }).await
}

/// Emails a one-time link for `purpose`: invite / reset (→ /reset-password) or confirm (→ /confirm-email).
pub async fn send_link_email_for(state: &AppState, user_id: Uuid, purpose: &str, hours: i32) -> Result<(), String> {
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
    let token = create_password_token(&state.db, user_id, purpose, hours).await.map_err(|e| e.to_string())?;
    let base = crate::mail::base_url(state, &s);
    let page = if purpose == "confirm" { "confirm-email" } else { "reset-password" };
    let link = format!("{base}/{page}?token={token}");
    let (subject, text, html) = crate::mail::link_email(purpose, &locale, &name, &username, &link, &format!("{base}/login"));
    crate::mail::send(&s, &email, &name, &subject, text, html).await
}

/// "Your account was approved" (after a self sign-up). Ok when the server can't send email or the account has none.
pub async fn send_approved_email(state: &AppState, user_id: Uuid) -> Result<(), String> {
    let s = crate::mail::load(state).await.map_err(|e| e.to_string())?;
    if !crate::mail::ready(&s) {
        return Ok(());
    }
    let (name, username, email, locale): (String, String, Option<String>, String) =
        sqlx::query_as("SELECT display_name, username, email, locale FROM users WHERE id = $1 AND deleted_at IS NULL")
            .bind(user_id)
            .fetch_one(&state.db)
            .await
            .map_err(|e| e.to_string())?;
    let Some(email) = email else { return Ok(()) };
    let base = crate::mail::base_url(state, &s);
    let login = format!("{base}/login");
    let (subject, text, html) = crate::mail::link_email("approved", &locale, &name, &username, &login, &login);
    crate::mail::send(&s, &email, &name, &subject, text, html).await
}

/// Public: whether the login page should offer "Forgot password?".
pub async fn options(State(state): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let s = crate::mail::load(&state).await?;
    let needs_setup = crate::setup::needs_setup(&state.db).await?;
    Ok(Json(serde_json::json!({
        "email_enabled": crate::mail::ready(&s),
        "needs_setup": needs_setup,
        "signup": state.config.allow_signup && !needs_setup,
        // the "Sign in with …" button: { label, required } or null
        "sso": if needs_setup { serde_json::Value::Null } else { crate::sso::public_info(&state).await },
    })))
}

#[derive(Deserialize)]
pub struct ForgotReq {
    /// username or email
    login: String,
}

/// Always answers the same way, so it can't be used to find out which accounts/emails exist.
pub async fn forgot(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(r): Json<ForgotReq>,
) -> AppResult<Json<serde_json::Value>> {
    // every request counts: this endpoint sends email, so it must not become a way to flood someone's inbox
    let ip = throttle::ip_key("forgot", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    let account = throttle::account_key("forgot-account", &r.login);
    state.throttle.check(&ip, throttle::FORGOT_IP)?;
    state.throttle.check(&account, throttle::FORGOT_ACCOUNT)?;
    state.throttle.hit(&ip, throttle::FORGOT_IP);
    state.throttle.hit(&account, throttle::FORGOT_ACCOUNT);
    let s = crate::mail::load(&state).await?;
    if !crate::mail::ready(&s) {
        return Err(AppError::BadRequest("email_disabled"));
    }
    // with single sign-on required, only super admins still have passwords to reset
    let only_admins = crate::sso::required(&state).await;
    let row: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM users WHERE deleted_at IS NULL AND is_active AND email IS NOT NULL AND (is_super_admin OR NOT $2)
           AND CASE WHEN strpos($1, '@') > 0 THEN lower(email) = lower($1) ELSE lower(username) = lower($1) END
           AND NOT EXISTS (SELECT 1 FROM password_tokens t WHERE t.user_id = users.id AND t.purpose = 'reset'
                           AND t.created_at > now() - interval '1 minute')",
    )
    .bind(r.login.trim())
    .bind(only_admins)
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
pub async fn check_token(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(r): Json<TokenReq>,
) -> AppResult<Json<serde_json::Value>> {
    let ip = throttle::ip_key("token", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    state.throttle.check(&ip, throttle::TOKEN_IP)?;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT u.username, t.purpose FROM password_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND u.deleted_at IS NULL AND u.is_active
           AND t.purpose IN ('invite', 'reset')",
    )
    .bind(token_hash(&r.token))
    .fetch_optional(&state.db)
    .await?;
    if row.is_none() {
        state.throttle.hit(&ip, throttle::TOKEN_IP);
    }
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

pub async fn reset(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(r): Json<ResetReq>,
) -> AppResult<Json<serde_json::Value>> {
    let ip = throttle::ip_key("token", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    state.throttle.check(&ip, throttle::TOKEN_IP)?;
    validate_password(&r.password)?;
    let mut tx = state.db.begin().await?;
    let row: Option<(Uuid,)> = sqlx::query_as(
        "UPDATE password_tokens t SET used_at = now() FROM users u
         WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now() AND t.purpose IN ('invite', 'reset')
           AND u.id = t.user_id AND u.deleted_at IS NULL AND u.is_active
         RETURNING t.user_id",
    )
    .bind(token_hash(&r.token))
    .fetch_optional(&mut *tx)
    .await?;
    let Some((uid,)) = row else {
        state.throttle.hit(&ip, throttle::TOKEN_IP);
        return Err(AppError::BadRequest("invalid_token"));
    };
    let pw = r.password.clone();
    let hash = hash_password_bounded(pw).await?;
    sqlx::query("UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1")
        .bind(uid)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    // every other outstanding link and every session dies with the old password
    sqlx::query("UPDATE password_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL").bind(uid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(uid).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM api_tokens WHERE user_id = $1").bind(uid).execute(&mut *tx).await?;
    tx.commit().await?;
    let client = throttle::client_ip(peer, &headers, state.config.trust_proxy).to_string();
    crate::audit::log(&state, Some(uid), "password_reset", Some(uid), Some(&client), serde_json::json!({})).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// "Firefox on Windows" from a User-Agent header, for the devices list and the activity log.
pub fn device_name(ua: &str) -> String {
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("OPR/") || ua.contains("Opera") {
        "Opera"
    } else if ua.contains("Firefox/") || ua.contains("FxiOS") {
        "Firefox"
    } else if ua.contains("Chrome/") || ua.contains("CriOS") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        "Browser"
    };
    let os = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        "macOS"
    } else if ua.contains("CrOS") {
        "ChromeOS"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        ""
    };
    if os.is_empty() { browser.to_string() } else { format!("{browser} on {os}") }
}

#[cfg(test)]
mod device_tests {
    use super::device_name;

    #[test]
    fn names_common_browsers() {
        assert_eq!(device_name("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0"), "Edge on Windows");
        assert_eq!(device_name("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
        assert_eq!(device_name("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"), "Firefox on Linux");
        assert_eq!(device_name("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36"), "Chrome on Android");
        assert_eq!(device_name("curl/8.0"), "Browser");
    }
}
