//! Optional two-factor sign-in with an authenticator app (Google/Microsoft Authenticator, 1Password, …):
//! TOTP, SHA-1, 6 digits, 30 s, ±1 step for clock drift. Off by default; each user turns it on in Profile.
//! - a code can't be used twice (the last accepted step is stored)
//! - 8 one-time recovery codes for a lost phone (stored hashed)
//! - the user (Profile) or a super admin (Admin page) can turn it off; `kanban reset-2fa` on the server too

use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use axum_extra::extract::cookie::CookieJar;
use qrcode::{QrCode, render::svg};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use totp_rs::{Builder, Secret, Totp};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{CurrentUser, SuperAdmin, User, verify_password},
    error::{AppError, AppResult},
};

const ISSUER: &str = "Kanb";

fn totp(secret_b32: &str, account: &str) -> AppResult<Totp> {
    let secret = Secret::try_from_base32(secret_b32).map_err(|_| anyhow::anyhow!("bad totp secret"))?;
    Builder::new()
        .with_secret(secret)
        .with_account_name(account)
        .with_issuer(Some(ISSUER))
        .build()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("totp: {e:?}")))
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

/// Valid code for this secret that wasn't used before? Returns the matched step.
fn check(secret_b32: &str, account: &str, code: &str, last_step: Option<i64>) -> AppResult<Option<i64>> {
    let code: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if code.len() != 6 {
        return Ok(None);
    }
    let secret = crate::crypto::open(secret_b32).map_err(AppError::Internal)?;
    let t = totp(&secret, account)?;
    Ok(t.check(&code, now()).map(|step| step as i64).filter(|step| last_step.is_none_or(|last| *step > last)))
}

/// Marks a code's time step as used. False if another request used it (or a later one) first.
async fn claim_step(state: &AppState, user_id: Uuid, step: i64) -> AppResult<bool> {
    let res = sqlx::query("UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)")
        .bind(user_id)
        .bind(step)
        .execute(&state.db)
        .await?;
    Ok(res.rows_affected() == 1)
}

fn hash_code(code: &str) -> String {
    let norm: String = code.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
    hex::encode(Sha256::digest(norm.as_bytes()))
}

/// 8 codes like "k7m2-x9qp" (no look-alike characters).
fn new_recovery_codes() -> (Vec<String>, Vec<String>) {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut plain = Vec::new();
    for _ in 0..8 {
        let mut buf = [0u8; 8];
        getrandom::fill(&mut buf).expect("os rng");
        let s: String = buf.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
        plain.push(format!("{}-{}", &s[..4], &s[4..]));
    }
    let hashed = plain.iter().map(|c| hash_code(c)).collect();
    (plain, hashed)
}

// ---------- setup / manage (Profile) ----------

/// Step 1: a new secret + QR code. Nothing changes until the first code is confirmed (step 2).
pub async fn setup(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    let secret = Secret::generate().to_base32();
    sqlx::query("UPDATE users SET totp_pending_secret = $2 WHERE id = $1").bind(u.id).bind(crate::crypto::seal(&secret)).execute(&state.db).await?;
    let account = u.email.clone().unwrap_or_else(|| u.username.clone());
    let url = totp(&secret, &account)?.to_url().map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let qr = QrCode::new(url.as_bytes()).map_err(|e| anyhow::anyhow!(e))?;
    let svg = qr.render::<svg::Color>().min_dimensions(220, 220).quiet_zone(true).build();
    // plain SVG text; the page shows it as an <img> data URL
    // grouped for typing by hand: ABCD EFGH …
    let grouped = secret.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join(" ");
    Ok(Json(json!({ "qr_svg": svg, "secret": grouped, "otpauth_url": url })))
}

#[derive(Deserialize)]
pub struct CodeReq {
    code: String,
    password: Option<String>,
}

/// Step 2: confirm a code from the app → 2FA is on; returns the recovery codes (shown once).
pub async fn enable(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<CodeReq>) -> AppResult<Json<Value>> {
    // switching to a new phone while 2FA is on: the password too, so an unlocked screen isn't enough
    if u.totp_enabled {
        confirm(&state, &u, &ConfirmReq { code: None, password: r.password.clone() }).await?;
    }
    let (pending,): (Option<String>,) =
        sqlx::query_as("SELECT totp_pending_secret FROM users WHERE id = $1").bind(u.id).fetch_one(&state.db).await?;
    let pending = pending.ok_or(AppError::BadRequest("totp_no_setup"))?;
    let account = u.email.clone().unwrap_or_else(|| u.username.clone());
    let step = check(&pending, &account, &r.code, None)?.ok_or(AppError::BadRequest("totp_invalid"))?;
    let (plain, hashed) = new_recovery_codes();
    sqlx::query(
        "UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = now(),
                totp_last_step = $2, totp_recovery = $3, updated_at = now() WHERE id = $1",
    )
    .bind(u.id)
    .bind(step)
    .bind(&hashed)
    .execute(&state.db)
    .await?;
    tracing::info!(user = %u.username, "two-factor sign-in turned on");
    Ok(Json(json!({ "ok": true, "recovery_codes": plain })))
}

#[derive(Deserialize)]
pub struct ConfirmReq {
    /// either a current authenticator code …
    code: Option<String>,
    /// … or the account password
    password: Option<String>,
}

/// Proves it's really the user (not just someone at an unlocked screen) before changing 2FA.
async fn confirm(state: &AppState, u: &User, r: &ConfirmReq) -> AppResult<()> {
    let (hash, secret, last): (Option<String>, Option<String>, Option<i64>) =
        sqlx::query_as("SELECT password_hash, totp_secret, totp_last_step FROM users WHERE id = $1").bind(u.id).fetch_one(&state.db).await?;
    if let (Some(code), Some(secret)) = (r.code.as_deref().filter(|c| !c.trim().is_empty()), secret.as_deref()) {
        let account = u.email.clone().unwrap_or_else(|| u.username.clone());
        if let Some(step) = check(secret, &account, code, last)? {
            if claim_step(state, u.id, step).await? {
                return Ok(());
            }
        }
        return Err(AppError::BadRequest("totp_invalid"));
    }
    if let (Some(pw), Some(hash)) = (r.password.clone(), hash) {
        let ok = tokio::task::spawn_blocking(move || verify_password(&pw, &hash)).await.map_err(|e| anyhow::anyhow!(e))?;
        if ok {
            return Ok(());
        }
    }
    Err(AppError::BadRequest("invalid_credentials"))
}

pub async fn disable(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<ConfirmReq>) -> AppResult<Json<Value>> {
    confirm(&state, &u, &r).await?;
    clear(&state, u.id).await?;
    tracing::info!(user = %u.username, "two-factor sign-in turned off by the user");
    Ok(Json(json!({ "ok": true })))
}

pub async fn regenerate_codes(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<ConfirmReq>) -> AppResult<Json<Value>> {
    if !u.totp_enabled {
        return Err(AppError::BadRequest("totp_not_enabled"));
    }
    confirm(&state, &u, &r).await?;
    let (plain, hashed) = new_recovery_codes();
    sqlx::query("UPDATE users SET totp_recovery = $2 WHERE id = $1").bind(u.id).bind(&hashed).execute(&state.db).await?;
    Ok(Json(json!({ "recovery_codes": plain })))
}

pub async fn clear(state: &AppState, user_id: Uuid) -> AppResult<()> {
    sqlx::query(
        "UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
                totp_recovery = '{}', updated_at = now() WHERE id = $1",
    )
    .bind(user_id)
    .execute(&state.db)
    .await?;
    sqlx::query("DELETE FROM login_challenges WHERE user_id = $1").bind(user_id).execute(&state.db).await?;
    Ok(())
}

/// Admin page: for a lost or replaced phone. The user signs in with just the password and can set it up again.
pub async fn admin_reset(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let (username,): (String,) = sqlx::query_as("SELECT username FROM users WHERE id = $1 AND deleted_at IS NULL").bind(id).fetch_one(&state.db).await?;
    clear(&state, id).await?;
    tracing::info!(user = %username, by = %me.username, "two-factor sign-in reset by an admin");
    Ok(Json(json!({ "ok": true })))
}

// ---------- sign-in, step 2 ----------

/// Called by `login` after a correct password when 2FA is on: a short-lived ticket for step 2.
pub async fn start_challenge(state: &AppState, user_id: Uuid) -> AppResult<String> {
    sqlx::query("DELETE FROM login_challenges WHERE expires_at < now()").execute(&state.db).await?;
    // a fresh ticket doesn't reset the count: 10 wrong codes in 5 minutes and the account waits
    let (recent,): (i64,) = sqlx::query_as("SELECT COALESCE(SUM(attempts), 0)::bigint FROM login_challenges WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;
    if recent >= 10 {
        tracing::warn!(%user_id, "two-factor sign-in throttled");
        return Err(AppError::BadRequest("too_many_attempts"));
    }
    let ticket = crate::auth::new_token();
    sqlx::query("INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '5 minutes')")
        .bind(crate::auth::token_hash(&ticket))
        .bind(user_id)
        .execute(&state.db)
        .await?;
    Ok(ticket)
}

#[derive(Deserialize)]
pub struct LoginCode {
    ticket: String,
    /// 6-digit app code, or a recovery code
    code: String,
}

pub async fn login_code(
    State(state): State<AppState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(r): Json<LoginCode>,
) -> AppResult<(CookieJar, Json<User>)> {
    use crate::throttle;
    let ip = throttle::ip_key("login", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    state.throttle.check(&ip, throttle::LOGIN_IP)?;
    // count the attempt first: 5 wrong codes and the ticket is dead (sign in with the password again)
    let row: Option<(Uuid,)> = sqlx::query_as(
        "UPDATE login_challenges SET attempts = attempts + 1
         WHERE token_hash = $1 AND expires_at > now() AND attempts < 5 RETURNING user_id",
    )
    .bind(crate::auth::token_hash(&r.ticket))
    .fetch_optional(&state.db)
    .await?;
    let Some((uid,)) = row else {
        state.throttle.hit(&ip, throttle::LOGIN_IP);
        return Err(AppError::BadRequest("totp_expired"));
    };
    // a ticket allows 5 codes, but someone with the password could keep asking for new tickets: limit per account too
    let account = format!("code-account:{uid}");
    state.throttle.check(&account, throttle::CODE_ACCOUNT)?;
    let (username, email, secret, last, recovery): (String, Option<String>, Option<String>, Option<i64>, Vec<String>) = sqlx::query_as(
        "SELECT username, email, totp_secret, totp_last_step, totp_recovery FROM users WHERE id = $1 AND is_active AND deleted_at IS NULL",
    )
    .bind(uid)
    .fetch_one(&state.db)
    .await?;
    let secret = secret.ok_or(AppError::BadRequest("totp_expired"))?;
    let account = email.unwrap_or(username.clone());
    let ok = if let Some(step) = check(&secret, &account, &r.code, last)? {
        claim_step(&state, uid, step).await?
    } else {
        // recovery code: one-time; the conditional update makes two simultaneous uses impossible
        let h = hash_code(&r.code);
        let used = recovery.contains(&h)
            && sqlx::query("UPDATE users SET totp_recovery = array_remove(totp_recovery, $2) WHERE id = $1 AND $2 = ANY(totp_recovery)")
                .bind(uid)
                .bind(&h)
                .execute(&state.db)
                .await?
                .rows_affected()
                == 1;
        if used {
            tracing::info!(user = %username, "signed in with a recovery code");
        }
        used
    };
    if !ok {
        state.throttle.hit(&ip, throttle::LOGIN_IP);
        state.throttle.hit(&account, throttle::CODE_ACCOUNT);
        tracing::warn!(user = %username, "wrong two-factor code");
        return Err(AppError::BadRequest("totp_invalid"));
    }
    state.throttle.clear(&account);
    sqlx::query("DELETE FROM login_challenges WHERE user_id = $1").bind(uid).execute(&state.db).await?;
    crate::auth::start_session(&state, uid, &headers, jar).await
}
