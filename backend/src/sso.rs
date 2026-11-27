//! Single sign-on with OpenID Connect: Google, Microsoft Entra ID, Authentik, Keycloak, Authelia, Zitadel and any
//! other provider that publishes `/.well-known/openid-configuration`. Set up in Admin → Single sign-on.
//!
//! Authorization code flow with PKCE, `state` and `nonce`. The flow is bound to the browser by a short-lived cookie
//! (its hash keys the `sso_flows` row), so a callback can't be replayed or completed in another browser. The ID token
//! comes straight from the provider's token endpoint over TLS, which OpenID Connect Core 3.1.3.7 (6) allows in
//! place of checking its signature; its issuer, audience, expiry and nonce are checked. That's also why the provider
//! must be reached over https (plain http only on this machine, for development and tests).
//!
//! Who an SSO sign-in is:
//! 1. the account already connected to this provider account (issuer + subject, which never change), else
//! 2. the account with the same email address, when the provider says it's verified (or the admin trusts the
//!    provider's addresses); it's connected from then on, else
//! 3. with ALLOW_SIGNUP on, a new account under the sign-up rules (admin approval or not; allowed email domains),
//! 4. otherwise nobody: "no account".
//!
//! SSO sessions skip Kanb's own two-factor sign-in (the provider handles that). "Require single sign-on" turns off
//! password sign-in for everyone except super admins, who keep it so a broken provider can't lock everyone out.

use std::{
    net::SocketAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{ConnectInfo, Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Redirect, Response},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    audit::ClientIp,
    auth::{CurrentUser, SuperAdmin, new_token, token_hash},
    error::{AppError, AppResult},
    throttle,
};

const KEY: &str = "sso";
const FLOW_COOKIE: &str = "kanb_sso";
const FLOW_PATH: &str = "/api/auth/sso";
const FLOW_MINUTES: i64 = 10;
/// sign-ins started per address (each one stores a row until it finishes or expires); generous, because a whole
/// office signing in at 9 am shares one address
const START_IP: throttle::Rule = throttle::Rule { limit: 300, window: Duration::from_secs(15 * 60) };

#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub enabled: bool,
    /// the provider's issuer URL, e.g. https://accounts.google.com or https://auth.example.com/application/o/kanb/
    pub issuer: String,
    pub client_id: String,
    /// stored encrypted (crypto::seal); never sent to the browser
    pub client_secret: String,
    /// the button text: "Sign in with {label}"
    pub label: String,
    /// new accounts only from these email domains (empty = any); existing accounts aren't affected
    pub allowed_domains: Vec<String>,
    /// treat every email address from the provider as verified (a provider your organisation controls, like
    /// Microsoft Entra ID, which doesn't send "email_verified")
    pub trust_email: bool,
    /// password sign-in only for super admins
    pub require_sso: bool,
}

impl Settings {
    fn ready(&self) -> bool {
        self.enabled && !self.issuer.trim().is_empty() && !self.client_id.trim().is_empty() && !self.client_secret.is_empty()
    }
}

pub async fn load(state: &AppState) -> AppResult<Settings> {
    let row: Option<(Value,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = $1").bind(KEY).fetch_optional(&state.db).await?;
    let mut s: Settings = row.and_then(|(v,)| serde_json::from_value(v).ok()).unwrap_or_default();
    s.client_secret = crate::crypto::open(&s.client_secret).map_err(AppError::Internal)?;
    Ok(s)
}

/// The settings, when single sign-on is switched on and complete.
pub async fn active(state: &AppState) -> Option<Settings> {
    load(state).await.ok().filter(Settings::ready)
}

/// Password sign-in is only for super admins.
pub async fn required(state: &AppState) -> bool {
    active(state).await.is_some_and(|s| s.require_sso)
}

/// For the sign-in page (`/auth/options`): the button, or null.
pub async fn public_info(state: &AppState) -> Value {
    match active(state).await {
        Some(s) => json!({ "label": label(&s), "required": s.require_sso }),
        None => Value::Null,
    }
}

fn label(s: &Settings) -> String {
    if s.label.trim().is_empty() { "SSO".into() } else { s.label.trim().into() }
}

/// Where the provider sends people back to; entered in the provider's settings.
pub fn redirect_uri(state: &AppState) -> String {
    format!("{}{FLOW_PATH}/callback", state.origins.first().map(|o| o.trim_end_matches('/')).unwrap_or(""))
}

// ---------- talking to the provider ----------

#[derive(Deserialize, Clone)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    userinfo_endpoint: Option<String>,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
}

static DISCOVERY: Mutex<Option<(String, Instant, Discovery)>> = Mutex::new(None);

/// https, or plain http to this machine only (development and tests): the ID token's trust rests on TLS.
fn check_url(u: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(u.trim()).map_err(|_| format!("not a valid URL: {u}"))?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => Ok(url),
        "http" if local => Ok(url),
        _ => Err(format!("{u} must start with https://")),
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .user_agent("Kanb")
        .build()
        .expect("http client")
}

async fn get_json(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let r = req.header(reqwest::header::ACCEPT, "application/json").send().await.map_err(|e| format!("can't reach the provider: {e}"))?;
    let status = r.status();
    let body = r.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let text = String::from_utf8_lossy(&body);
        return Err(format!("the provider answered {status}: {}", text.chars().take(300).collect::<String>()));
    }
    serde_json::from_slice(&body).map_err(|_| "the provider's answer isn't JSON".to_string())
}

async fn discover(issuer: &str) -> Result<Discovery, String> {
    let issuer = issuer.trim();
    if let Some((i, at, d)) = DISCOVERY.lock().unwrap().as_ref()
        && i == issuer
        && at.elapsed() < Duration::from_secs(3600)
    {
        return Ok(d.clone());
    }
    check_url(issuer)?;
    let url = format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/'));
    let v = get_json(http().get(&url)).await?;
    let d: Discovery = serde_json::from_value(v).map_err(|e| format!("{url} is missing something: {e}"))?;
    if d.issuer.trim_end_matches('/') != issuer.trim_end_matches('/') {
        return Err(format!("the provider calls itself {}, not {issuer}", d.issuer));
    }
    check_url(&d.authorization_endpoint)?;
    check_url(&d.token_endpoint)?;
    if let Some(u) = &d.userinfo_endpoint {
        check_url(u)?;
    }
    *DISCOVERY.lock().unwrap() = Some((issuer.to_string(), Instant::now(), d.clone()));
    Ok(d)
}

/// application/x-www-form-urlencoded value
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// What the provider says about the person.
#[derive(Debug, Default)]
struct Claims {
    subject: String,
    email: Option<String>,
    email_verified: bool,
    name: Option<String>,
    username: Option<String>,
    locale: Option<String>,
}

fn str_claim(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Checks the ID token (from the token endpoint over TLS: no signature check needed, see the module comment).
fn id_token_claims(token: &str, d: &Discovery, client_id: &str, nonce: &str, now: i64) -> Result<Value, &'static str> {
    let mut parts = token.split('.');
    let (Some(_), Some(payload), Some(_), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("bad_token");
    };
    let bytes = Base64UrlUnpadded::decode_vec(payload.trim_end_matches('=')).map_err(|_| "bad_token")?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "bad_token")?;
    if v.get("iss").and_then(Value::as_str) != Some(d.issuer.as_str()) {
        return Err("wrong_issuer");
    }
    let aud_ok = match v.get("aud") {
        Some(Value::String(a)) => a == client_id,
        Some(Value::Array(a)) => {
            a.iter().any(|x| x.as_str() == Some(client_id))
                && (a.len() == 1 || v.get("azp").and_then(Value::as_str) == Some(client_id))
        }
        _ => false,
    };
    if !aud_ok {
        return Err("wrong_audience");
    }
    // a minute's leeway for clocks that differ a little
    if v.get("exp").and_then(Value::as_i64).is_none_or(|exp| exp < now - 60) {
        return Err("expired_token");
    }
    if v.get("nonce").and_then(Value::as_str) != Some(nonce) {
        return Err("bad_nonce");
    }
    if str_claim(&v, "sub").is_none() {
        return Err("bad_token");
    }
    Ok(v)
}

fn verified(v: &Value) -> bool {
    match v.get("email_verified") {
        Some(Value::Bool(b)) => *b,
        // some providers send it as a string
        Some(Value::String(s)) => s == "true",
        _ => false,
    }
}

/// The code from the callback → who signed in. Err: a short code for the sign-in page (details are logged).
async fn exchange(s: &Settings, d: &Discovery, redirect_uri: &str, code: &str, verifier: &str, nonce: &str) -> Result<Claims, &'static str> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("code_verifier", verifier.to_string()),
    ];
    let methods = &d.token_endpoint_auth_methods_supported;
    // client_secret_basic is the default when the provider doesn't say
    let basic = methods.is_empty() || methods.iter().any(|m| m == "client_secret_basic");
    let mut req = http().post(&d.token_endpoint).header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded");
    if basic {
        req = req.basic_auth(enc(&s.client_id), Some(enc(&s.client_secret)));
    } else {
        form.push(("client_id", s.client_id.clone()));
        form.push(("client_secret", s.client_secret.clone()));
    }
    let body = form.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect::<Vec<_>>().join("&");
    let tokens = get_json(req.body(body)).await.map_err(|e| {
        tracing::warn!(error = %e, "single sign-on: token request failed");
        "token_failed"
    })?;
    let id_token = tokens.get("id_token").and_then(Value::as_str).ok_or("token_failed")?;
    let v = id_token_claims(id_token, d, &s.client_id, nonce, chrono::Utc::now().timestamp()).inspect_err(|e| {
        tracing::warn!(problem = e, "single sign-on: ID token refused");
    })?;
    let mut c = Claims {
        subject: str_claim(&v, "sub").unwrap_or_default(),
        email: str_claim(&v, "email"),
        email_verified: verified(&v),
        name: str_claim(&v, "name"),
        username: str_claim(&v, "preferred_username"),
        locale: str_claim(&v, "locale"),
    };
    // many providers put the email (and name) only in the userinfo answer
    if (c.email.is_none() || c.name.is_none())
        && let (Some(url), Some(access)) = (&d.userinfo_endpoint, tokens.get("access_token").and_then(Value::as_str))
    {
        match get_json(http().get(url).bearer_auth(access)).await {
            Ok(u) if str_claim(&u, "sub").as_deref() == Some(c.subject.as_str()) => {
                if c.email.is_none() {
                    c.email = str_claim(&u, "email");
                    c.email_verified = verified(&u);
                }
                c.name = c.name.or_else(|| str_claim(&u, "name"));
                c.username = c.username.or_else(|| str_claim(&u, "preferred_username"));
                c.locale = c.locale.or_else(|| str_claim(&u, "locale"));
            }
            Ok(_) => tracing::warn!("single sign-on: userinfo is about someone else; ignored"),
            Err(e) => tracing::warn!(error = %e, "single sign-on: userinfo request failed"),
        }
    }
    if s.trust_email && c.email.is_some() {
        c.email_verified = true;
    }
    c.email = c.email.and_then(|e| crate::auth::normalize_email(Some(e)).ok().flatten().flatten());
    Ok(c)
}

// ---------- signing in ----------

/// A new flow: the row, the cookie that binds it to this browser, and the provider's sign-in URL.
async fn begin(state: &AppState, s: &Settings, jar: CookieJar, link_user: Option<Uuid>) -> AppResult<(CookieJar, String)> {
    let d = discover(&s.issuer).await.map_err(|e| {
        tracing::warn!(error = %e, "single sign-on: provider unreachable");
        AppError::BadRequest("sso_unreachable")
    })?;
    let (cookie, st, nonce, verifier) = (new_token(), new_token(), new_token(), new_token());
    sqlx::query("DELETE FROM sso_flows WHERE expires_at < now()").execute(&state.db).await?;
    sqlx::query(
        "INSERT INTO sso_flows (token_hash, state, nonce, verifier, link_user, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))",
    )
    .bind(token_hash(&cookie))
    .bind(&st)
    .bind(&nonce)
    .bind(&verifier)
    .bind(link_user)
    .bind(FLOW_MINUTES as i32)
    .execute(&state.db)
    .await?;
    let challenge = Base64UrlUnpadded::encode_string(&Sha256::digest(verifier.as_bytes()));
    let mut url = reqwest::Url::parse(&d.authorization_endpoint).map_err(|e| anyhow::anyhow!(e))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &s.client_id)
        .append_pair("redirect_uri", &redirect_uri(state))
        .append_pair("scope", "openid email profile")
        .append_pair("state", &st)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    // Lax, not Strict: the provider's redirect back is a cross-site navigation, which must carry it
    let c = Cookie::build((FLOW_COOKIE, cookie))
        .http_only(true)
        .secure(state.config.cookie_secure)
        .same_site(SameSite::Lax)
        .path(FLOW_PATH)
        .max_age(time::Duration::minutes(FLOW_MINUTES))
        .build();
    Ok((jar.add(c), url.to_string()))
}

fn to_login(code: &str) -> Response {
    Redirect::to(&format!("/login?sso_error={code}")).into_response()
}

/// GET /auth/sso/start: the "Sign in with …" button.
pub async fn start(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, jar: CookieJar) -> Response {
    let Some(s) = active(&state).await else { return to_login("sso_off") };
    let ip = throttle::ip_key("sso", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    if state.throttle.check(&ip, START_IP).is_err() {
        return to_login("too_many");
    }
    state.throttle.hit(&ip, START_IP);
    match begin(&state, &s, jar, None).await {
        Ok((jar, url)) => (jar, Redirect::to(&url)).into_response(),
        Err(AppError::BadRequest(code)) => to_login(code),
        Err(e) => {
            tracing::warn!(error = %e, "single sign-on: could not start");
            to_login("sso_failed")
        }
    }
}

/// POST /me/sso/link: connect the provider to the signed-in account (Profile). Answers the URL to open.
pub async fn link(State(state): State<AppState>, CurrentUser(u): CurrentUser, jar: CookieJar) -> AppResult<(CookieJar, Json<Value>)> {
    let s = active(&state).await.ok_or(AppError::BadRequest("sso_off"))?;
    let (jar, url) = begin(&state, &s, jar, Some(u.id)).await?;
    Ok((jar, Json(json!({ "url": url }))))
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// GET /auth/sso/callback: the provider sends the browser back here.
pub async fn callback(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Query(q): Query<CallbackQuery>,
) -> Response {
    let ip_addr = throttle::client_ip(peer, &headers, state.config.trust_proxy);
    let ip = throttle::ip_key("login", ip_addr);
    if state.throttle.check(&ip, throttle::LOGIN_IP).is_err() {
        return to_login("too_many");
    }
    let client = ip_addr.to_string();
    let cookie = jar.get(FLOW_COOKIE).map(|c| c.value().to_string());
    let jar = jar.remove(Cookie::build(FLOW_COOKIE).path(FLOW_PATH));
    // one use only, and only in the browser that started it
    let flow: Option<(String, String, String, Option<Uuid>)> = match cookie {
        Some(c) => sqlx::query_as(
            "DELETE FROM sso_flows WHERE token_hash = $1 AND expires_at > now() RETURNING state, nonce, verifier, link_user",
        )
        .bind(token_hash(&c))
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten(),
        None => None,
    };
    let fail = |jar: CookieJar, code: &'static str, linking: bool| -> Response {
        state.throttle.hit(&ip, throttle::LOGIN_IP);
        let to = if linking { format!("/profile?tab=security&sso_error={code}") } else { format!("/login?sso_error={code}") };
        (jar, Redirect::to(&to)).into_response()
    };
    let Some((want_state, nonce, verifier, link_user)) = flow else { return fail(jar, "expired", false) };
    let linking = link_user.is_some();
    if let Some(e) = &q.error {
        tracing::info!(error = %e.chars().take(100).collect::<String>(), "single sign-on: the provider refused or was cancelled");
        return fail(jar, "cancelled", linking);
    }
    if q.state.as_deref() != Some(want_state.as_str()) {
        return fail(jar, "invalid_state", linking);
    }
    let Some(code) = q.code.filter(|c| !c.is_empty()) else { return fail(jar, "invalid_state", linking) };
    let Some(s) = active(&state).await else { return fail(jar, "sso_off", linking) };
    let d = match discover(&s.issuer).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "single sign-on: provider unreachable");
            return fail(jar, "sso_unreachable", linking);
        }
    };
    let claims = match exchange(&s, &d, &redirect_uri(&state), &code, &verifier, &nonce).await {
        Ok(c) => c,
        Err(code) => {
            crate::audit::log(&state, None, "sso_failed", link_user, Some(&client), json!({ "reason": code })).await;
            return fail(jar, code, linking);
        }
    };

    if let Some(uid) = link_user {
        return match connect(&state, uid, &d.issuer, &claims).await {
            Ok(()) => {
                crate::audit::log(&state, Some(uid), "sso_linked", Some(uid), Some(&client), json!({ "email": claims.email })).await;
                (jar, Redirect::to("/profile?tab=security&sso=linked")).into_response()
            }
            Err(AppError::Conflict(code)) => fail(jar, code, true),
            Err(e) => {
                tracing::warn!(error = %e, "single sign-on: could not connect");
                fail(jar, "sso_failed", true)
            }
        };
    }

    let uid = match who(&state, &s, &d.issuer, &claims, &client).await {
        Ok(uid) => uid,
        Err(code) => {
            if !matches!(code, "pending_approval" | "email_not_confirmed") {
                crate::audit::log(&state, None, "sso_failed", None, Some(&client), json!({ "reason": code, "email": claims.email })).await;
            }
            return fail(jar, code, false);
        }
    };
    state.throttle.clear(&format!("login-account:{uid}"));
    match crate::auth::start_session(&state, uid, &headers, jar, Some(&client), "sso").await {
        Ok((jar, _)) => (jar, Redirect::to("/")).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "single sign-on: could not start the session");
            to_login("sso_failed")
        }
    }
}

/// Connects a provider account to `uid` (Profile → Connect). Conflict when it already belongs to someone else.
async fn connect(state: &AppState, uid: Uuid, issuer: &str, c: &Claims) -> AppResult<()> {
    let owner: Option<(Uuid,)> = sqlx::query_as("SELECT user_id FROM user_identities WHERE issuer = $1 AND subject = $2")
        .bind(issuer)
        .bind(&c.subject)
        .fetch_optional(&state.db)
        .await?;
    match owner {
        Some((o,)) if o != uid => Err(AppError::Conflict("linked_elsewhere")),
        Some(_) => {
            touch(state, issuer, c).await?;
            Ok(())
        }
        None => {
            insert_identity(state, uid, issuer, c).await?;
            Ok(())
        }
    }
}

async fn insert_identity(state: &AppState, uid: Uuid, issuer: &str, c: &Claims) -> AppResult<()> {
    sqlx::query("INSERT INTO user_identities (id, user_id, issuer, subject, email, last_used_at) VALUES ($1, $2, $3, $4, $5, now())")
        .bind(Uuid::now_v7())
        .bind(uid)
        .bind(issuer)
        .bind(&c.subject)
        .bind(&c.email)
        .execute(&state.db)
        .await?;
    Ok(())
}

async fn touch(state: &AppState, issuer: &str, c: &Claims) -> AppResult<()> {
    sqlx::query("UPDATE user_identities SET email = COALESCE($3, email), last_used_at = now() WHERE issuer = $1 AND subject = $2")
        .bind(issuer)
        .bind(&c.subject)
        .bind(&c.email)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Which account this sign-in is (see the module comment). Err: a code for the sign-in page.
async fn who(state: &AppState, s: &Settings, issuer: &str, c: &Claims, client: &str) -> Result<Uuid, &'static str> {
    let db_err = |e: AppError| {
        tracing::warn!(error = %e, "single sign-on: database error");
        "sso_failed"
    };
    let known: Option<(Uuid,)> = sqlx::query_as("SELECT user_id FROM user_identities WHERE issuer = $1 AND subject = $2")
        .bind(issuer)
        .bind(&c.subject)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| db_err(e.into()))?;
    if let Some((uid,)) = known {
        touch(state, issuer, c).await.map_err(db_err)?;
        return usable(state, uid).await;
    }
    // an existing account with this (verified) address: connect it
    if let (Some(email), true) = (&c.email, c.email_verified) {
        let found: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL")
            .bind(email)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| db_err(e.into()))?;
        if let Some((uid,)) = found {
            insert_identity(state, uid, issuer, c).await.map_err(db_err)?;
            crate::audit::log(state, Some(uid), "sso_linked", Some(uid), Some(client), json!({ "email": email, "by": "email" })).await;
            return usable(state, uid).await;
        }
    }
    create(state, s, issuer, c, client).await
}

/// Can this account sign in now? Err: why not.
async fn usable(state: &AppState, uid: Uuid) -> Result<Uuid, &'static str> {
    let row: Option<(bool, Option<String>, bool)> =
        sqlx::query_as("SELECT is_active, signup, deleted_at IS NOT NULL FROM users WHERE id = $1").bind(uid).fetch_optional(&state.db).await.ok().flatten();
    match row {
        None | Some((_, _, true)) => Err("no_account"),
        Some((_, Some(s), _)) if s == "email" => Err("email_not_confirmed"),
        Some((_, Some(_), _)) => Err("pending_approval"),
        Some((false, None, _)) => Err("account_disabled"),
        Some((true, None, false)) => Ok(uid),
    }
}

/// A new account for someone the provider knows and Kanb doesn't: only with sign-up on (ALLOW_SIGNUP), under its
/// rules, with a verified email address from an allowed domain.
async fn create(state: &AppState, s: &Settings, issuer: &str, c: &Claims, client: &str) -> Result<Uuid, &'static str> {
    if !state.config.allow_signup || crate::setup::needs_setup(&state.db).await.unwrap_or(true) {
        return Err("no_account");
    }
    let Some(email) = c.email.clone().filter(|_| c.email_verified) else { return Err("email_unverified") };
    let domain = email.rsplit_once('@').map(|(_, d)| d.to_lowercase()).unwrap_or_default();
    if !s.allowed_domains.is_empty() && !s.allowed_domains.iter().any(|d| *d == domain) {
        return Err("domain_not_allowed");
    }
    let (waiting,): (i64,) = sqlx::query_as("SELECT count(*) FROM users WHERE signup IS NOT NULL AND deleted_at IS NULL")
        .fetch_one(&state.db)
        .await
        .map_err(|_| "sso_failed")?;
    if waiting >= crate::signup::MAX_WAITING {
        return Err("signup_full");
    }
    let rules = crate::signup::settings(state).await;
    let first = crate::signup::next_state(&rules);
    let locale = if c.locale.as_deref().is_some_and(|l| l.starts_with("th")) { "th" } else { "en" };
    let name = c.name.clone().unwrap_or_else(|| email.split('@').next().unwrap_or("").to_string());
    let base = username_base(c.username.as_deref().filter(|u| !u.contains('@')).unwrap_or(email.split('@').next().unwrap_or("")));
    let mut user = None;
    for n in 0..20 {
        let candidate = match n {
            0 => base.clone(),
            1..=9 => format!("{base}{}", n + 1),
            _ => format!("{base}-{}", &new_token()[..6]),
        };
        match crate::admin::insert_user(&state.db, &candidate, &name, Some(email.clone()), None, false, rules.can_create_boards, locale, false, first).await {
            Ok(u) => {
                user = Some(u);
                break;
            }
            // the name is taken: try the next one
            Err(AppError::Conflict("already_exists")) => continue,
            Err(AppError::Conflict(code)) => return Err(code),
            Err(e) => {
                tracing::warn!(error = %e, "single sign-on: could not create the account");
                return Err("sso_failed");
            }
        }
    }
    let user = user.ok_or("sso_failed")?;
    let _ = insert_identity(state, user.id, issuer, c).await;
    crate::audit::log(state, None, "signed_up", Some(user.id), Some(client), json!({ "username": user.username, "via": "sso" })).await;
    if first.is_some() {
        crate::notify::signups_changed(state, true).await;
        return Err("pending_approval");
    }
    Ok(user.id)
}

/// A valid username from what the provider calls the person: letters, digits, . _ -; 2–30 characters.
fn username_base(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-')).take(30).collect();
    if cleaned.chars().count() >= 2 { cleaned } else { "user".into() }
}

// ---------- Profile ----------

#[derive(Serialize, sqlx::FromRow)]
struct Identity {
    id: Uuid,
    email: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    last_used_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// GET /me/sso
pub async fn mine(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    let ids: Vec<Identity> = sqlx::query_as("SELECT id, email, created_at, last_used_at FROM user_identities WHERE user_id = $1 ORDER BY created_at")
        .bind(u.id)
        .fetch_all(&state.db)
        .await?;
    let s = active(&state).await;
    Ok(Json(json!({
        "available": s.is_some(),
        "label": s.as_ref().map(label),
        "required": s.as_ref().is_some_and(|s| s.require_sso),
        "identities": ids,
    })))
}

/// DELETE /me/sso/{id}
pub async fn unlink(State(state): State<AppState>, CurrentUser(u): CurrentUser, ClientIp(ip): ClientIp, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    if required(&state).await && !u.is_super_admin {
        return Err(AppError::Denied("sso_required"));
    }
    let gone: Option<(Option<String>,)> = sqlx::query_as("DELETE FROM user_identities WHERE id = $1 AND user_id = $2 RETURNING email")
        .bind(id)
        .bind(u.id)
        .fetch_optional(&state.db)
        .await?;
    let (email,) = gone.ok_or(AppError::NotFound)?;
    crate::audit::log(&state, Some(u.id), "sso_unlinked", Some(u.id), ip.as_deref(), json!({ "email": email })).await;
    Ok(Json(json!({ "ok": true })))
}

// ---------- Admin → Single sign-on ----------

#[derive(Serialize)]
pub struct View {
    #[serde(flatten)]
    settings: Settings,
    has_secret: bool,
    redirect_uri: String,
    /// ALLOW_SIGNUP: whether people the provider knows can get a new account
    signup: bool,
    /// accounts connected to a provider account
    connected: i64,
    /// active accounts (not super admins) that couldn't sign in if single sign-on were required: no email address
    /// to match and no connected provider account
    stranded: i64,
}

pub async fn admin_get(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<View>> {
    let mut s = load(&state).await?;
    let has_secret = !s.client_secret.is_empty();
    s.client_secret = String::new(); // never sent back to the browser
    let (connected,): (i64,) = sqlx::query_as("SELECT count(DISTINCT user_id) FROM user_identities").fetch_one(&state.db).await?;
    let (stranded,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM users u WHERE u.is_active AND u.deleted_at IS NULL AND u.signup IS NULL AND NOT u.is_super_admin
           AND u.email IS NULL AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id)",
    )
    .fetch_one(&state.db)
    .await?;
    Ok(Json(View { settings: s, has_secret, redirect_uri: redirect_uri(&state), signup: state.config.allow_signup, connected, stranded }))
}

#[derive(Deserialize)]
pub struct SaveReq {
    enabled: bool,
    issuer: String,
    client_id: String,
    /// None or "" = keep the stored secret
    client_secret: Option<String>,
    #[serde(default)]
    label: String,
    #[serde(default)]
    allowed_domains: Vec<String>,
    #[serde(default)]
    trust_email: bool,
    #[serde(default)]
    require_sso: bool,
}

fn domains(list: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for d in list {
        let d = d.trim().trim_start_matches('@').to_lowercase();
        if d.is_empty() {
            continue;
        }
        if !d.contains('.') || d.starts_with('.') || d.ends_with('.') || d.chars().any(|c| c.is_whitespace() || c == '@' || c == '/') {
            return Err(AppError::BadRequest("invalid_domain"));
        }
        if !out.contains(&d) {
            out.push(d);
        }
    }
    Ok(out)
}

async fn settings_from(state: &AppState, r: SaveReq) -> AppResult<Settings> {
    let old = load(state).await?;
    let secret = r.client_secret.filter(|x| !x.is_empty()).unwrap_or(old.client_secret);
    let s = Settings {
        enabled: r.enabled,
        issuer: r.issuer.trim().into(),
        client_id: r.client_id.trim().into(),
        client_secret: secret,
        label: r.label.trim().chars().take(40).collect(),
        allowed_domains: domains(&r.allowed_domains)?,
        trust_email: r.trust_email,
        require_sso: r.require_sso && r.enabled,
    };
    if !s.issuer.is_empty() {
        check_url(&s.issuer).map_err(|_| AppError::BadRequest("sso_issuer_https"))?;
    }
    Ok(s)
}

/// POST /admin/sso/test: can the provider be reached with these (unsaved) settings? Answers the problem in words.
pub async fn admin_test(State(state): State<AppState>, _a: SuperAdmin, Json(r): Json<SaveReq>) -> AppResult<Json<Value>> {
    let s = settings_from(&state, r).await?;
    if s.issuer.is_empty() {
        return Err(AppError::BadRequest("sso_incomplete"));
    }
    *DISCOVERY.lock().unwrap() = None;
    Ok(Json(match discover(&s.issuer).await {
        Ok(d) => json!({ "ok": true, "issuer": d.issuer, "authorization_endpoint": d.authorization_endpoint }),
        Err(e) => json!({ "ok": false, "error": e }),
    }))
}

pub async fn admin_save(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, ClientIp(ip): ClientIp, Json(r): Json<SaveReq>) -> AppResult<Json<View>> {
    let old = load(&state).await?;
    let s = settings_from(&state, r).await?;
    if s.enabled {
        if !s.ready() {
            return Err(AppError::BadRequest("sso_incomplete"));
        }
        *DISCOVERY.lock().unwrap() = None;
        if let Err(e) = discover(&s.issuer).await {
            tracing::warn!(error = %e, "single sign-on: provider check failed");
            return Err(AppError::BadRequest("sso_unreachable"));
        }
    }
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()")
        .bind(KEY)
        .bind(serde_json::to_value(Settings { client_secret: crate::crypto::seal(&s.client_secret), ..s.clone() }).map_err(|e| anyhow::anyhow!(e))?)
        .execute(&state.db)
        .await?;
    // which fields changed, never their values (the secret is compared in plain text here and not stored)
    let fields = crate::audit::changed_fields(&serde_json::to_value(&old).unwrap_or_default(), &serde_json::to_value(&s).unwrap_or_default());
    crate::audit::log(&state, Some(me.id), "settings_changed", None, ip.as_deref(), json!({ "area": "sso", "fields": fields })).await;
    // "require single sign-on" just turned on: password sessions end, except super admins'
    if s.require_sso && !(old.ready() && old.require_sso) {
        let r = sqlx::query(
            "DELETE FROM sessions WHERE method <> 'sso' AND user_id IN (SELECT id FROM users WHERE NOT is_super_admin)",
        )
        .execute(&state.db)
        .await?;
        // and API tokens: someone removed at the provider mustn't keep script access
        let t = sqlx::query("DELETE FROM api_tokens WHERE user_id IN (SELECT id FROM users WHERE NOT is_super_admin)").execute(&state.db).await?;
        tracing::info!(ended = r.rows_affected(), tokens = t.rows_affected(), "single sign-on required: password sessions and API tokens ended");
    }
    admin_get(State(state), SuperAdmin(me)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disc() -> Discovery {
        Discovery {
            issuer: "https://idp.example.com".into(),
            authorization_endpoint: "https://idp.example.com/auth".into(),
            token_endpoint: "https://idp.example.com/token".into(),
            userinfo_endpoint: None,
            token_endpoint_auth_methods_supported: vec![],
        }
    }

    fn token(v: Value) -> String {
        format!("eyJhbGciOiJSUzI1NiJ9.{}.c2ln", Base64UrlUnpadded::encode_string(v.to_string().as_bytes()))
    }

    #[test]
    fn checks_the_id_token() {
        let ok = json!({ "iss": "https://idp.example.com", "aud": "kanb", "exp": 2000, "nonce": "n1", "sub": "123" });
        assert!(id_token_claims(&token(ok.clone()), &disc(), "kanb", "n1", 1000).is_ok());
        let with = |k: &str, v: Value| {
            let mut t = ok.clone();
            t[k] = v;
            id_token_claims(&token(t), &disc(), "kanb", "n1", 1000)
        };
        assert_eq!(with("iss", json!("https://evil.example.com")).unwrap_err(), "wrong_issuer");
        assert_eq!(with("aud", json!("other")).unwrap_err(), "wrong_audience");
        assert!(with("aud", json!(["kanb"])).is_ok());
        // several audiences: the token must have been issued to us (azp)
        assert_eq!(with("aud", json!(["kanb", "other"])).unwrap_err(), "wrong_audience");
        let mut multi = ok.clone();
        multi["aud"] = json!(["kanb", "other"]);
        multi["azp"] = json!("kanb");
        assert!(id_token_claims(&token(multi), &disc(), "kanb", "n1", 1000).is_ok());
        assert_eq!(with("exp", json!(900)).unwrap_err(), "expired_token");
        assert_eq!(with("nonce", json!("n2")).unwrap_err(), "bad_nonce");
        assert_eq!(with("sub", json!("")).unwrap_err(), "bad_token");
        assert_eq!(id_token_claims("not-a-token", &disc(), "kanb", "n1", 1000).unwrap_err(), "bad_token");
    }

    #[test]
    fn urls_must_be_https_except_this_machine() {
        assert!(check_url("https://accounts.google.com").is_ok());
        assert!(check_url("http://127.0.0.1:9000/realms/x").is_ok());
        assert!(check_url("http://localhost:9000").is_ok());
        assert!(check_url("http://idp.lan:9000").is_err());
        assert!(check_url("ftp://idp.example.com").is_err());
    }

    #[test]
    fn usernames_from_the_provider() {
        assert_eq!(username_base("somchai.k"), "somchai.k");
        assert_eq!(username_base("John Smith!"), "JohnSmith");
        assert_eq!(username_base("ใจดี"), "ใจดี");
        assert_eq!(username_base("@"), "user");
    }

    #[test]
    fn form_encoding() {
        assert_eq!(enc("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
    }
}
