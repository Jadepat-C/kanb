//! First run: while there are no accounts at all, the sign-in page offers "create the first admin" instead.
//! It asks for a setup code so that whoever reaches a fresh, already-public install first can't claim it:
//! deploy/setup.sh writes one into .env (SETUP_CODE) and prints it; otherwise a random one is printed in the server
//! log at startup. Once any account exists (even a deleted one) the endpoint refuses, and the CLI
//! (`kanban create-admin`) remains the way in.

use axum::{
    Json,
    extract::{ConnectInfo, State},
    http::HeaderMap,
};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use std::net::SocketAddr;

use crate::{
    AppState,
    auth::User,
    config::Config,
    error::{AppError, AppResult},
    throttle,
};

/// Two simultaneous setups must not both see "no accounts yet".
static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The code to accept: SETUP_CODE if set, otherwise a fresh random one for this run of the server.
pub fn code(config: &Config) -> String {
    match config.setup_code.as_deref().map(str::trim) {
        Some(c) if !normalize(c).is_empty() => c.to_string(),
        _ => generate(),
    }
}

fn generate() -> String {
    // no 0/O, 1/I/L: easy to read out of a log and type
    const ABC: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut buf = [0u8; 8];
    getrandom::fill(&mut buf).expect("os rng");
    let s: String = buf.iter().map(|b| ABC[*b as usize % ABC.len()] as char).collect();
    format!("{}-{}", &s[..4], &s[4..])
}

/// Codes compare without dashes, spaces or case.
fn normalize(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect()
}

fn same(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub async fn needs_setup(db: &sqlx::PgPool) -> AppResult<bool> {
    let (empty,): (bool,) = sqlx::query_as("SELECT NOT EXISTS (SELECT 1 FROM users)").fetch_one(db).await?;
    Ok(empty)
}

/// At startup: tell the operator how to create the first admin.
pub async fn announce(state: &AppState) {
    if !needs_setup(&state.db).await.unwrap_or(false) {
        return;
    }
    let url = state.origins.first().cloned().unwrap_or_default();
    if state.config.setup_code.as_deref().is_some_and(|c| !normalize(c).is_empty()) {
        tracing::info!("No accounts yet: open {url} and enter the setup code from your .env (SETUP_CODE) to create the first admin.");
    } else {
        tracing::warn!("No accounts yet: open {url} and enter setup code {} to create the first admin.", state.setup_code);
    }
}

#[derive(Deserialize)]
pub struct SetupReq {
    code: String,
    username: String,
    #[serde(default)]
    display_name: String,
    password: String,
    #[serde(default)]
    locale: String,
}

pub async fn create_first_admin(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(r): Json<SetupReq>,
) -> AppResult<(CookieJar, Json<User>)> {
    let ip = throttle::ip_key("setup", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    state.throttle.check(&ip, throttle::TOKEN_IP)?;
    let _guard = LOCK.lock().await;
    if !needs_setup(&state.db).await? {
        return Err(AppError::Conflict("already_set_up"));
    }
    if !same(&r.code, &state.setup_code) {
        state.throttle.hit(&ip, throttle::TOKEN_IP);
        tracing::warn!("wrong first-run setup code");
        crate::metrics::sign_in("setup_code_failed");
        return Err(AppError::SignInFailed("setup_code_invalid"));
    }
    let locale = if r.locale == "th" { "th" } else { "en" };
    let user = crate::admin::insert_user(&state.db, &r.username, r.display_name.trim(), None, &r.password, true, true, locale, false).await?;
    tracing::info!(user = %user.username, "first admin created in the browser");
    crate::auth::start_session(&state, user.id, &headers, jar).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes() {
        let c = generate();
        assert_eq!(c.len(), 9);
        assert!(same(&c, &c.to_lowercase().replace('-', " ")));
        assert!(!same(&c, &generate()));
        assert!(same("a1b2c3-d4e5f6", "A1B2C3D4E5F6"));
        assert!(!same("a1b2c3", "a1b2c4"));
        assert!(!same("", "x"));
    }
}
