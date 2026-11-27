//! Single sign-on with OpenID Connect: Google, Microsoft, Authentik, Keycloak, Authelia, Zitadel and any other
//! provider that publishes `/.well-known/openid-configuration`. Several providers can be set up side by side
//! (Admin → Single sign-on); the sign-in page shows a button for each.
//!
//! Authorization code flow with PKCE, `state` and `nonce`. The flow is bound to the browser by a short-lived cookie
//! (its hash keys the `sso_flows` row, which also records the provider), so a callback can't be replayed, completed
//! in another browser, or finished with a different provider's settings. The ID token comes straight from the
//! provider's token endpoint over TLS, which OpenID Connect Core 3.1.3.7 (6) allows in place of checking its
//! signature; its issuer, audience, expiry and nonce are checked. That's also why providers must be reached over https
//! (plain http only on this machine, for development and tests).
//!
//! Who an SSO sign-in is:
//! 1. the account already connected to this provider account (issuer + subject, which never change), else
//! 2. the account with the same email address, when the provider says it's verified (or the admin trusts that
//!    provider's addresses); it's connected from then on, else
//! 3. with ALLOW_SIGNUP on, a new account under the sign-up rules (admin approval or not; allowed email domains),
//! 4. otherwise nobody: "no account". People can still connect a provider themselves (Profile → Security).
//!
//! Microsoft: the "common" and "organizations" endpoints serve every Entra tenant, so their issuer is a template
//! (`…/{tenantid}/v2.0`) filled in from each token's `tid`. On those, "trust email addresses" is refused: any tenant's
//! admin can put any address on their users. Microsoft never says an address is verified.
//!
//! SSO sessions skip Kanb's own two-factor sign-in (the provider handles that). "Require single sign-on" turns off
//! password sign-in for everyone except super admins, who keep it so a broken provider can't lock everyone out.

use std::{
    collections::HashMap,
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
/// at most this many providers
const MAX_PROVIDERS: usize = 10;
/// sign-ins started per address (each one stores a row until it finishes or expires); generous, because a whole
/// office signing in at 9 am shares one address
const START_IP: throttle::Rule = throttle::Rule { limit: 300, window: Duration::from_secs(15 * 60) };

#[derive(Serialize, Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(default)]
pub struct Provider {
    /// stable id (in sign-in links and on connected accounts)
    pub id: String,
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
    /// treat every email address from this provider as verified (a provider your organisation controls that doesn't
    /// send "email_verified", like a single Microsoft Entra tenant)
    pub trust_email: bool,
}

impl Provider {
    fn ready(&self) -> bool {
        self.enabled && !self.issuer.trim().is_empty() && !self.client_id.trim().is_empty() && !self.client_secret.is_empty()
    }
    fn label(&self) -> String {
        if self.label.trim().is_empty() { "SSO".into() } else { self.label.trim().into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub providers: Vec<Provider>,
    /// password sign-in only for super admins (while at least one provider is ready)
    pub require_sso: bool,
}

/// What 0.4.x stored: one provider at the top level.
#[derive(Deserialize, Default)]
#[serde(default)]
struct OldSettings {
    enabled: bool,
    issuer: String,
    client_id: String,
    client_secret: String,
    label: String,
    allowed_domains: Vec<String>,
    trust_email: bool,
    require_sso: bool,
}

/// Settings as stored (secrets still sealed); the 0.4.x shape becomes a list of one.
fn parse(v: Value) -> Settings {
    if v.get("issuer").is_some() && v.get("providers").is_none() {
        let o: OldSettings = serde_json::from_value(v).unwrap_or_default();
        let providers = if o.issuer.trim().is_empty() && o.client_id.trim().is_empty() {
            vec![]
        } else {
            vec![Provider {
                id: "default".into(),
                enabled: o.enabled,
                issuer: o.issuer,
                client_id: o.client_id,
                client_secret: o.client_secret,
                label: o.label,
                allowed_domains: o.allowed_domains,
                trust_email: o.trust_email,
            }]
        };
        return Settings { providers, require_sso: o.require_sso };
    }
    serde_json::from_value(v).unwrap_or_default()
}

pub async fn load(state: &AppState) -> AppResult<Settings> {
    let row: Option<(Value,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = $1").bind(KEY).fetch_optional(&state.db).await?;
    let mut s = row.map(|(v,)| parse(v)).unwrap_or_default();
    for p in &mut s.providers {
        p.client_secret = crate::crypto::open(&p.client_secret).map_err(AppError::Internal)?;
    }
    Ok(s)
}

async fn store(state: &AppState, s: &Settings) -> AppResult<()> {
    let mut sealed = s.clone();
    for p in &mut sealed.providers {
        p.client_secret = crate::crypto::seal(&p.client_secret);
    }
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()")
        .bind(KEY)
        .bind(serde_json::to_value(&sealed).map_err(|e| anyhow::anyhow!(e))?)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// The providers people can sign in with right now.
pub async fn active(state: &AppState) -> Vec<Provider> {
    load(state).await.map(|s| s.providers.into_iter().filter(Provider::ready).collect()).unwrap_or_default()
}

/// Password sign-in is only for super admins.
pub async fn required(state: &AppState) -> bool {
    load(state).await.is_ok_and(|s| s.require_sso && s.providers.iter().any(Provider::ready))
}

/// For the sign-in page (`/auth/options`): { providers: [{id, label}], required }, or null when SSO is off.
pub async fn public_info(state: &AppState) -> Value {
    let Ok(s) = load(state).await else { return Value::Null };
    let ready: Vec<Value> = s.providers.iter().filter(|p| p.ready()).map(|p| json!({ "id": p.id, "label": p.label() })).collect();
    if ready.is_empty() {
        return Value::Null;
    }
    json!({ "providers": ready, "required": s.require_sso })
}

/// Where providers send people back to; entered in each provider's settings (the same for all of them).
pub fn redirect_uri(state: &AppState) -> String {
    format!("{}{FLOW_PATH}/callback", state.origins.first().map(|o| o.trim_end_matches('/')).unwrap_or(""))
}

// ---------- talking to a provider ----------

#[derive(Deserialize, Clone)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    userinfo_endpoint: Option<String>,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Vec<String>,
}

impl Discovery {
    /// One issuer for many tenants (Microsoft "common" / "organizations"): `…/{tenantid}/…`.
    fn multi_tenant(&self) -> bool {
        self.issuer.contains("{tenantid}")
    }
}

/// by the configured issuer URL
static DISCOVERY: Mutex<Option<HashMap<String, (Instant, Discovery)>>> = Mutex::new(None);

fn forget(issuer: &str) {
    if let Some(m) = DISCOVERY.lock().unwrap().as_mut() {
        m.remove(issuer.trim());
    }
}

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

/// The issuer a provider reports is the one we typed, or another one on the same host (Microsoft turns
/// `…/consumers/v2.0` or `…/contoso.onmicrosoft.com/v2.0` into the tenant's id).
fn same_issuer(configured: &str, reported: &str) -> bool {
    let (a, b) = (configured.trim().trim_end_matches('/'), reported.trim().trim_end_matches('/'));
    if a == b {
        return true;
    }
    match (reqwest::Url::parse(a), reqwest::Url::parse(b)) {
        (Ok(x), Ok(y)) => x.scheme() == y.scheme() && x.host_str() == y.host_str() && x.port_or_known_default() == y.port_or_known_default(),
        _ => false,
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
    if let Some((at, d)) = DISCOVERY.lock().unwrap().as_ref().and_then(|m| m.get(issuer))
        && at.elapsed() < Duration::from_secs(3600)
    {
        return Ok(d.clone());
    }
    check_url(issuer)?;
    let url = format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/'));
    let v = get_json(http().get(&url)).await?;
    let d: Discovery = serde_json::from_value(v).map_err(|e| format!("{url} is missing something: {e}"))?;
    if !same_issuer(issuer, &d.issuer) {
        return Err(format!("the provider calls itself {}, not {issuer}", d.issuer));
    }
    check_url(&d.authorization_endpoint)?;
    check_url(&d.token_endpoint)?;
    if let Some(u) = &d.userinfo_endpoint {
        check_url(u)?;
    }
    DISCOVERY.lock().unwrap().get_or_insert_with(HashMap::new).insert(issuer.to_string(), (Instant::now(), d.clone()));
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
    /// the token's issuer (with a multi-tenant provider: the person's tenant)
    issuer: String,
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

fn is_guid(s: &str) -> bool {
    s.len() == 36 && s.chars().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// The token's `iss` is the provider's issuer (for a multi-tenant one: the template with the token's own tenant).
fn issuer_ok(expected: &str, v: &Value) -> bool {
    let Some(iss) = v.get("iss").and_then(Value::as_str) else { return false };
    if expected.contains("{tenantid}") {
        return v.get("tid").and_then(Value::as_str).is_some_and(|tid| is_guid(tid) && iss == expected.replace("{tenantid}", tid));
    }
    iss == expected
}

/// Checks the ID token (from the token endpoint over TLS: no signature check needed, see the module comment).
fn id_token_claims(token: &str, d: &Discovery, client_id: &str, nonce: &str, now: i64) -> Result<Value, &'static str> {
    let mut parts = token.split('.');
    let (Some(_), Some(payload), Some(_), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return Err("bad_token");
    };
    let bytes = Base64UrlUnpadded::decode_vec(payload.trim_end_matches('=')).map_err(|_| "bad_token")?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| "bad_token")?;
    if !issuer_ok(&d.issuer, &v) {
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
async fn exchange(p: &Provider, d: &Discovery, redirect_uri: &str, code: &str, verifier: &str, nonce: &str) -> Result<Claims, &'static str> {
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
        req = req.basic_auth(enc(&p.client_id), Some(enc(&p.client_secret)));
    } else {
        form.push(("client_id", p.client_id.clone()));
        form.push(("client_secret", p.client_secret.clone()));
    }
    let body = form.iter().map(|(k, v)| format!("{k}={}", enc(v))).collect::<Vec<_>>().join("&");
    let tokens = get_json(req.body(body)).await.map_err(|e| {
        tracing::warn!(error = %e, provider = %p.label(), "single sign-on: token request failed");
        "token_failed"
    })?;
    let id_token = tokens.get("id_token").and_then(Value::as_str).ok_or("token_failed")?;
    let v = id_token_claims(id_token, d, &p.client_id, nonce, chrono::Utc::now().timestamp()).inspect_err(|e| {
        tracing::warn!(problem = e, provider = %p.label(), "single sign-on: ID token refused");
    })?;
    let mut c = Claims {
        issuer: str_claim(&v, "iss").unwrap_or_default(),
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
    // never on a multi-tenant issuer: any tenant could claim any address
    if p.trust_email && !d.multi_tenant() && c.email.is_some() {
        c.email_verified = true;
    }
    c.email = c.email.and_then(|e| crate::auth::normalize_email(Some(e)).ok().flatten().flatten());
    Ok(c)
}

// ---------- signing in ----------

/// A new flow: the row, the cookie that binds it to this browser, and the provider's sign-in URL.
async fn begin(state: &AppState, p: &Provider, jar: CookieJar, link_user: Option<Uuid>) -> AppResult<(CookieJar, String)> {
    let d = discover(&p.issuer).await.map_err(|e| {
        tracing::warn!(error = %e, provider = %p.label(), "single sign-on: provider unreachable");
        AppError::BadRequest("sso_unreachable")
    })?;
    let (cookie, st, nonce, verifier) = (new_token(), new_token(), new_token(), new_token());
    sqlx::query("DELETE FROM sso_flows WHERE expires_at < now()").execute(&state.db).await?;
    sqlx::query(
        "INSERT INTO sso_flows (token_hash, state, nonce, verifier, link_user, provider, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7))",
    )
    .bind(token_hash(&cookie))
    .bind(&st)
    .bind(&nonce)
    .bind(&verifier)
    .bind(link_user)
    .bind(&p.id)
    .bind(FLOW_MINUTES as i32)
    .execute(&state.db)
    .await?;
    let challenge = Base64UrlUnpadded::encode_string(&Sha256::digest(verifier.as_bytes()));
    let mut url = reqwest::Url::parse(&d.authorization_endpoint).map_err(|e| anyhow::anyhow!(e))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &p.client_id)
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

/// The provider asked for: by id, or the only one there is.
fn pick(ready: Vec<Provider>, id: Option<&str>) -> Option<Provider> {
    match id.filter(|i| !i.is_empty()) {
        Some(id) => ready.into_iter().find(|p| p.id == id),
        None if ready.len() == 1 => ready.into_iter().next(),
        None => None,
    }
}

fn to_login(code: &str, provider: Option<&str>) -> Response {
    let p = provider.map(|p| format!("&provider={}", enc(p))).unwrap_or_default();
    Redirect::to(&format!("/login?sso_error={code}{p}")).into_response()
}

#[derive(Deserialize)]
pub struct StartQuery {
    provider: Option<String>,
}

/// GET /auth/sso/start?provider=…: a "Sign in with …" button.
pub async fn start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Query(q): Query<StartQuery>,
) -> Response {
    let Some(p) = pick(active(&state).await, q.provider.as_deref()) else { return to_login("sso_off", None) };
    let ip = throttle::ip_key("sso", throttle::client_ip(peer, &headers, state.config.trust_proxy));
    if state.throttle.check(&ip, START_IP).is_err() {
        return to_login("too_many", Some(&p.id));
    }
    state.throttle.hit(&ip, START_IP);
    match begin(&state, &p, jar, None).await {
        Ok((jar, url)) => (jar, Redirect::to(&url)).into_response(),
        Err(AppError::BadRequest(code)) => to_login(code, Some(&p.id)),
        Err(e) => {
            tracing::warn!(error = %e, "single sign-on: could not start");
            to_login("sso_failed", Some(&p.id))
        }
    }
}

#[derive(Deserialize, Default)]
pub struct LinkReq {
    provider: Option<String>,
}

/// POST /me/sso/link {provider}: connect a provider to the signed-in account (Profile). Answers the URL to open.
pub async fn link(State(state): State<AppState>, CurrentUser(u): CurrentUser, jar: CookieJar, body: Option<Json<LinkReq>>) -> AppResult<(CookieJar, Json<Value>)> {
    let r = body.map(|b| b.0).unwrap_or_default();
    let p = pick(active(&state).await, r.provider.as_deref()).ok_or(AppError::BadRequest("sso_off"))?;
    let (jar, url) = begin(&state, &p, jar, Some(u.id)).await?;
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
        return to_login("too_many", None);
    }
    let client = ip_addr.to_string();
    let cookie = jar.get(FLOW_COOKIE).map(|c| c.value().to_string());
    let jar = jar.remove(Cookie::build(FLOW_COOKIE).path(FLOW_PATH));
    // one use only, and only in the browser that started it
    let flow: Option<(String, String, String, Option<Uuid>, Option<String>)> = match cookie {
        Some(c) => sqlx::query_as(
            "DELETE FROM sso_flows WHERE token_hash = $1 AND expires_at > now() RETURNING state, nonce, verifier, link_user, provider",
        )
        .bind(token_hash(&c))
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten(),
        None => None,
    };
    let fail = |jar: CookieJar, code: &'static str, linking: bool, provider: Option<&str>| -> Response {
        state.throttle.hit(&ip, throttle::LOGIN_IP);
        let p = provider.map(|p| format!("&provider={}", enc(p))).unwrap_or_default();
        let to = if linking { format!("/profile?tab=security&sso_error={code}{p}") } else { format!("/login?sso_error={code}{p}") };
        (jar, Redirect::to(&to)).into_response()
    };
    let Some((want_state, nonce, verifier, link_user, provider_id)) = flow else { return fail(jar, "expired", false, None) };
    let linking = link_user.is_some();
    // the provider this flow was started with, and only that one (a flow from before 0.5 has none: the only provider)
    let Some(p) = pick(active(&state).await, provider_id.as_deref()).filter(|p| provider_id.is_none() || provider_id.as_deref() == Some(p.id.as_str())) else {
        return fail(jar, "sso_off", linking, None);
    };
    let pid = Some(p.id.as_str());
    if let Some(e) = &q.error {
        tracing::info!(error = %e.chars().take(100).collect::<String>(), "single sign-on: the provider refused or was cancelled");
        return fail(jar, "cancelled", linking, pid);
    }
    if q.state.as_deref() != Some(want_state.as_str()) {
        return fail(jar, "invalid_state", linking, pid);
    }
    let Some(code) = q.code.filter(|c| !c.is_empty()) else { return fail(jar, "invalid_state", linking, pid) };
    let d = match discover(&p.issuer).await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "single sign-on: provider unreachable");
            return fail(jar, "sso_unreachable", linking, pid);
        }
    };
    let claims = match exchange(&p, &d, &redirect_uri(&state), &code, &verifier, &nonce).await {
        Ok(c) => c,
        Err(code) => {
            crate::audit::log(&state, None, "sso_failed", link_user, Some(&client), json!({ "reason": code, "provider": p.label() })).await;
            return fail(jar, code, linking, pid);
        }
    };

    if let Some(uid) = link_user {
        return match connect(&state, uid, &p, &claims).await {
            Ok(()) => {
                crate::audit::log(&state, Some(uid), "sso_linked", Some(uid), Some(&client), json!({ "email": claims.email, "provider": p.label() })).await;
                (jar, Redirect::to(&format!("/profile?tab=security&sso=linked&provider={}", enc(&p.id)))).into_response()
            }
            Err(AppError::Conflict(code)) => fail(jar, code, true, pid),
            Err(e) => {
                tracing::warn!(error = %e, "single sign-on: could not connect");
                fail(jar, "sso_failed", true, pid)
            }
        };
    }

    let uid = match who(&state, &p, &claims, &client).await {
        Ok(uid) => uid,
        Err(code) => {
            if !matches!(code, "pending_approval" | "email_not_confirmed") {
                crate::audit::log(&state, None, "sso_failed", None, Some(&client), json!({ "reason": code, "email": claims.email, "provider": p.label() })).await;
            }
            return fail(jar, code, false, pid);
        }
    };
    state.throttle.clear(&format!("login-account:{uid}"));
    match crate::auth::start_session(&state, uid, &headers, jar, Some(&client), "sso").await {
        Ok((jar, _)) => (jar, Redirect::to("/")).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "single sign-on: could not start the session");
            to_login("sso_failed", pid)
        }
    }
}

/// Connects a provider account to `uid` (Profile → Connect). Conflict when it already belongs to someone else.
async fn connect(state: &AppState, uid: Uuid, p: &Provider, c: &Claims) -> AppResult<()> {
    let owner: Option<(Uuid,)> = sqlx::query_as("SELECT user_id FROM user_identities WHERE issuer = $1 AND subject = $2")
        .bind(&c.issuer)
        .bind(&c.subject)
        .fetch_optional(&state.db)
        .await?;
    match owner {
        Some((o,)) if o != uid => Err(AppError::Conflict("linked_elsewhere")),
        Some(_) => touch(state, p, c).await,
        None => insert_identity(state, uid, p, c).await,
    }
}

async fn insert_identity(state: &AppState, uid: Uuid, p: &Provider, c: &Claims) -> AppResult<()> {
    sqlx::query("INSERT INTO user_identities (id, user_id, issuer, subject, email, provider, last_used_at) VALUES ($1, $2, $3, $4, $5, $6, now())")
        .bind(Uuid::now_v7())
        .bind(uid)
        .bind(&c.issuer)
        .bind(&c.subject)
        .bind(&c.email)
        .bind(&p.id)
        .execute(&state.db)
        .await?;
    Ok(())
}

async fn touch(state: &AppState, p: &Provider, c: &Claims) -> AppResult<()> {
    sqlx::query("UPDATE user_identities SET email = COALESCE($3, email), provider = $4, last_used_at = now() WHERE issuer = $1 AND subject = $2")
        .bind(&c.issuer)
        .bind(&c.subject)
        .bind(&c.email)
        .bind(&p.id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Which account this sign-in is (see the module comment). Err: a code for the sign-in page.
async fn who(state: &AppState, p: &Provider, c: &Claims, client: &str) -> Result<Uuid, &'static str> {
    let db_err = |e: AppError| {
        tracing::warn!(error = %e, "single sign-on: database error");
        "sso_failed"
    };
    let known: Option<(Uuid,)> = sqlx::query_as("SELECT user_id FROM user_identities WHERE issuer = $1 AND subject = $2")
        .bind(&c.issuer)
        .bind(&c.subject)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| db_err(e.into()))?;
    if let Some((uid,)) = known {
        touch(state, p, c).await.map_err(db_err)?;
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
            insert_identity(state, uid, p, c).await.map_err(db_err)?;
            crate::audit::log(state, Some(uid), "sso_linked", Some(uid), Some(client), json!({ "email": email, "by": "email", "provider": p.label() })).await;
            return usable(state, uid).await;
        }
    }
    create(state, p, c, client).await
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
async fn create(state: &AppState, p: &Provider, c: &Claims, client: &str) -> Result<Uuid, &'static str> {
    if !state.config.allow_signup || crate::setup::needs_setup(&state.db).await.unwrap_or(true) {
        return Err("no_account");
    }
    let Some(email) = c.email.clone().filter(|_| c.email_verified) else { return Err("email_unverified") };
    let domain = email.rsplit_once('@').map(|(_, d)| d.to_lowercase()).unwrap_or_default();
    if !p.allowed_domains.is_empty() && !p.allowed_domains.iter().any(|d| *d == domain) {
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
    let _ = insert_identity(state, user.id, p, c).await;
    crate::audit::log(state, None, "signed_up", Some(user.id), Some(client), json!({ "username": user.username, "via": "sso", "provider": p.label() })).await;
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

#[derive(sqlx::FromRow)]
struct IdentityRow {
    id: Uuid,
    email: Option<String>,
    issuer: String,
    provider: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    last_used_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// The provider an identity came from, for its label: by id, else by issuer; None once that provider was removed.
fn provider_of<'a>(all: &'a [Provider], row: &IdentityRow) -> Option<&'a Provider> {
    row.provider
        .as_deref()
        .and_then(|id| all.iter().find(|p| p.id == id))
        .or_else(|| all.iter().find(|p| same_issuer(&p.issuer, &row.issuer) && !p.issuer.contains("{tenantid}")))
}

/// GET /me/sso
pub async fn mine(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    let rows: Vec<IdentityRow> =
        sqlx::query_as("SELECT id, email, issuer, provider, created_at, last_used_at FROM user_identities WHERE user_id = $1 ORDER BY created_at")
            .bind(u.id)
            .fetch_all(&state.db)
            .await?;
    let s = load(&state).await?;
    let ready: Vec<&Provider> = s.providers.iter().filter(|p| p.ready()).collect();
    let identities: Vec<Value> = rows
        .iter()
        .map(|r| {
            let p = provider_of(&s.providers, r);
            // a provider that was removed: its host, so people still know what it was
            let label = p.map(Provider::label).unwrap_or_else(|| reqwest::Url::parse(&r.issuer).ok().and_then(|x| x.host_str().map(str::to_string)).unwrap_or_default());
            json!({ "id": r.id, "email": r.email, "provider": p.map(|p| p.id.clone()), "label": label, "created_at": r.created_at, "last_used_at": r.last_used_at })
        })
        .collect();
    let connected: Vec<String> = rows.iter().filter_map(|r| provider_of(&s.providers, r).map(|p| p.id.clone())).collect();
    Ok(Json(json!({
        "available": !ready.is_empty(),
        "required": s.require_sso && !ready.is_empty(),
        // providers that can be connected: every ready one, and whether this account already is
        "providers": ready.iter().map(|p| json!({ "id": p.id, "label": p.label(), "connected": connected.contains(&p.id) })).collect::<Vec<_>>(),
        "identities": identities,
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
pub struct ProviderView {
    #[serde(flatten)]
    provider: Provider,
    has_secret: bool,
    /// accounts connected through it
    connected: i64,
    /// serves every organisation (Microsoft "common"), as far as its last discovery showed
    multi_tenant: bool,
}

#[derive(Serialize)]
pub struct View {
    providers: Vec<ProviderView>,
    require_sso: bool,
    redirect_uri: String,
    /// ALLOW_SIGNUP: whether people a provider knows can get a new account
    signup: bool,
    /// accounts connected to any provider
    connected: i64,
    /// active accounts (not super admins) that couldn't sign in if single sign-on were required: no email address
    /// to match and no connected provider account
    stranded: i64,
}

pub async fn admin_get(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<View>> {
    let s = load(&state).await?;
    let rows: Vec<IdentityRow> =
        sqlx::query_as("SELECT id, email, issuer, provider, created_at, last_used_at FROM user_identities").fetch_all(&state.db).await?;
    let providers = s
        .providers
        .iter()
        .map(|p| ProviderView {
            has_secret: !p.client_secret.is_empty(),
            multi_tenant: DISCOVERY.lock().unwrap().as_ref().and_then(|m| m.get(p.issuer.trim())).is_some_and(|(_, d)| d.multi_tenant()),
            connected: rows.iter().filter(|r| provider_of(&s.providers, r).is_some_and(|x| x.id == p.id)).count() as i64,
            provider: Provider { client_secret: String::new(), ..p.clone() }, // never sent back to the browser
        })
        .collect();
    let (connected,): (i64,) = sqlx::query_as("SELECT count(DISTINCT user_id) FROM user_identities").fetch_one(&state.db).await?;
    let (stranded,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM users u WHERE u.is_active AND u.deleted_at IS NULL AND u.signup IS NULL AND NOT u.is_super_admin
           AND u.email IS NULL AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id)",
    )
    .fetch_one(&state.db)
    .await?;
    Ok(Json(View {
        providers,
        require_sso: s.require_sso && s.providers.iter().any(Provider::ready),
        redirect_uri: redirect_uri(&state),
        signup: state.config.allow_signup,
        connected,
        stranded,
    }))
}

#[derive(Deserialize)]
pub struct ProviderReq {
    #[serde(default = "yes")]
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
}
fn yes() -> bool {
    true
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

/// A provider from the form (`old`: its saved version, for the secret), checked: complete when switched on, the
/// provider reachable, and "trust email" refused where any tenant could claim any address.
async fn provider_from(r: ProviderReq, id: String, old: Option<&Provider>) -> AppResult<Provider> {
    let secret = r.client_secret.filter(|x| !x.is_empty()).or_else(|| old.map(|o| o.client_secret.clone())).unwrap_or_default();
    let p = Provider {
        id,
        enabled: r.enabled,
        issuer: r.issuer.trim().into(),
        client_id: r.client_id.trim().into(),
        client_secret: secret,
        label: r.label.trim().chars().take(40).collect(),
        allowed_domains: domains(&r.allowed_domains)?,
        trust_email: r.trust_email,
    };
    if !p.issuer.is_empty() {
        check_url(&p.issuer).map_err(|_| AppError::BadRequest("sso_issuer_https"))?;
    }
    if p.enabled {
        if !p.ready() {
            return Err(AppError::BadRequest("sso_incomplete"));
        }
        forget(&p.issuer);
        let d = discover(&p.issuer).await.map_err(|e| {
            tracing::warn!(error = %e, "single sign-on: provider check failed");
            AppError::BadRequest("sso_unreachable")
        })?;
        if p.trust_email && d.multi_tenant() {
            return Err(AppError::BadRequest("sso_trust_multitenant"));
        }
    }
    Ok(p)
}

async fn saved(state: &AppState, me: Uuid, ip: Option<&str>, old: &Settings, new: &Settings, what: Value) -> AppResult<()> {
    store(state, new).await?;
    crate::audit::log(state, Some(me), "settings_changed", None, ip, json!({ "area": "sso", "fields": [what] })).await;
    // "require single sign-on" just took effect: password sessions and API tokens end, except super admins'
    let was = old.require_sso && old.providers.iter().any(Provider::ready);
    let is = new.require_sso && new.providers.iter().any(Provider::ready);
    if is && !was {
        let r = sqlx::query("DELETE FROM sessions WHERE method <> 'sso' AND user_id IN (SELECT id FROM users WHERE NOT is_super_admin)").execute(&state.db).await?;
        // and API tokens: someone removed at a provider mustn't keep script access
        let t = sqlx::query("DELETE FROM api_tokens WHERE user_id IN (SELECT id FROM users WHERE NOT is_super_admin)").execute(&state.db).await?;
        tracing::info!(ended = r.rows_affected(), tokens = t.rows_affected(), "single sign-on required: password sessions and API tokens ended");
    }
    Ok(())
}

/// No provider left to sign in with: "require" can't stay on (it would lock out everyone but super admins).
fn keep_require_sane(s: &mut Settings) {
    if !s.providers.iter().any(Provider::ready) {
        s.require_sso = false;
    }
}

/// POST /admin/sso/providers
pub async fn admin_create(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, ClientIp(ip): ClientIp, Json(r): Json<ProviderReq>) -> AppResult<Json<View>> {
    let old = load(&state).await?;
    if old.providers.len() >= MAX_PROVIDERS {
        return Err(AppError::BadRequest("too_many_providers"));
    }
    let p = provider_from(r, Uuid::now_v7().simple().to_string()[..12].to_string(), None).await?;
    let mut s = old.clone();
    let label = p.label();
    s.providers.push(p);
    saved(&state, me.id, ip.as_deref(), &old, &s, json!({ "added": label })).await?;
    admin_get(State(state), SuperAdmin(me)).await
}

/// PUT /admin/sso/providers/{id}
pub async fn admin_update(
    State(state): State<AppState>,
    SuperAdmin(me): SuperAdmin,
    ClientIp(ip): ClientIp,
    Path(id): Path<String>,
    Json(r): Json<ProviderReq>,
) -> AppResult<Json<View>> {
    let old = load(&state).await?;
    let i = old.providers.iter().position(|p| p.id == id).ok_or(AppError::NotFound)?;
    let p = provider_from(r, id, Some(&old.providers[i])).await?;
    let fields = crate::audit::changed_fields(&serde_json::to_value(&old.providers[i]).unwrap_or_default(), &serde_json::to_value(&p).unwrap_or_default());
    let mut s = old.clone();
    let label = p.label();
    s.providers[i] = p;
    keep_require_sane(&mut s);
    saved(&state, me.id, ip.as_deref(), &old, &s, json!({ "changed": label, "fields": fields })).await?;
    admin_get(State(state), SuperAdmin(me)).await
}

/// DELETE /admin/sso/providers/{id}: its button goes; accounts connected through it keep the (unused) link, which
/// works again if the same provider is added back.
pub async fn admin_delete(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, ClientIp(ip): ClientIp, Path(id): Path<String>) -> AppResult<Json<View>> {
    let old = load(&state).await?;
    let mut s = old.clone();
    let p = s.providers.iter().position(|p| p.id == id).map(|i| s.providers.remove(i)).ok_or(AppError::NotFound)?;
    keep_require_sane(&mut s);
    saved(&state, me.id, ip.as_deref(), &old, &s, json!({ "removed": p.label() })).await?;
    admin_get(State(state), SuperAdmin(me)).await
}

#[derive(Deserialize)]
pub struct RequireReq {
    require_sso: bool,
}

/// PUT /admin/sso {require_sso}
pub async fn admin_save(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, ClientIp(ip): ClientIp, Json(r): Json<RequireReq>) -> AppResult<Json<View>> {
    let old = load(&state).await?;
    if r.require_sso && !old.providers.iter().any(Provider::ready) {
        return Err(AppError::BadRequest("sso_no_provider"));
    }
    let s = Settings { require_sso: r.require_sso, ..old.clone() };
    saved(&state, me.id, ip.as_deref(), &old, &s, json!({ "require_sso": r.require_sso })).await?;
    admin_get(State(state), SuperAdmin(me)).await
}

/// POST /admin/sso/test: can this provider be reached (unsaved settings)? Answers the problem in words.
pub async fn admin_test(State(state): State<AppState>, _a: SuperAdmin, Json(r): Json<ProviderReq>) -> AppResult<Json<Value>> {
    let _ = &state;
    let issuer = r.issuer.trim().to_string();
    if issuer.is_empty() {
        return Err(AppError::BadRequest("sso_incomplete"));
    }
    check_url(&issuer).map_err(|_| AppError::BadRequest("sso_issuer_https"))?;
    forget(&issuer);
    Ok(Json(match discover(&issuer).await {
        Ok(d) => json!({ "ok": true, "issuer": d.issuer, "authorization_endpoint": d.authorization_endpoint, "multi_tenant": d.multi_tenant() }),
        Err(e) => json!({ "ok": false, "error": e }),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disc(issuer: &str) -> Discovery {
        Discovery {
            issuer: issuer.into(),
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
        let d = disc("https://idp.example.com");
        let ok = json!({ "iss": "https://idp.example.com", "aud": "kanb", "exp": 2000, "nonce": "n1", "sub": "123" });
        assert!(id_token_claims(&token(ok.clone()), &d, "kanb", "n1", 1000).is_ok());
        let with = |k: &str, v: Value| {
            let mut t = ok.clone();
            t[k] = v;
            id_token_claims(&token(t), &d, "kanb", "n1", 1000)
        };
        assert_eq!(with("iss", json!("https://evil.example.com")).unwrap_err(), "wrong_issuer");
        assert_eq!(with("aud", json!("other")).unwrap_err(), "wrong_audience");
        assert!(with("aud", json!(["kanb"])).is_ok());
        // several audiences: the token must have been issued to us (azp)
        assert_eq!(with("aud", json!(["kanb", "other"])).unwrap_err(), "wrong_audience");
        let mut multi = ok.clone();
        multi["aud"] = json!(["kanb", "other"]);
        multi["azp"] = json!("kanb");
        assert!(id_token_claims(&token(multi), &d, "kanb", "n1", 1000).is_ok());
        assert_eq!(with("exp", json!(900)).unwrap_err(), "expired_token");
        assert_eq!(with("nonce", json!("n2")).unwrap_err(), "bad_nonce");
        assert_eq!(with("sub", json!("")).unwrap_err(), "bad_token");
        assert_eq!(id_token_claims("not-a-token", &d, "kanb", "n1", 1000).unwrap_err(), "bad_token");
    }

    /// Microsoft's "common" endpoint: issuer https://login.microsoftonline.com/{tenantid}/v2.0, filled in from `tid`.
    #[test]
    fn multi_tenant_issuers() {
        let d = disc("https://login.microsoftonline.com/{tenantid}/v2.0");
        assert!(d.multi_tenant());
        let tid = "9188040d-6c67-4c5b-b112-36a304b66dad";
        let t = |iss: &str, tid: Value| {
            token(json!({ "iss": iss, "tid": tid, "aud": "kanb", "exp": 2000, "nonce": "n", "sub": "s" }))
        };
        let good = format!("https://login.microsoftonline.com/{tid}/v2.0");
        assert!(id_token_claims(&t(&good, json!(tid)), &d, "kanb", "n", 1000).is_ok());
        // the tenant in iss must be the token's own tid
        let other = "72f988bf-86f1-41af-91ab-2d7cd011db47";
        assert_eq!(id_token_claims(&t(&good, json!(other)), &d, "kanb", "n", 1000).unwrap_err(), "wrong_issuer");
        // no tid, a tid that isn't a GUID, the template itself, another host
        assert_eq!(id_token_claims(&t(&good, Value::Null), &d, "kanb", "n", 1000).unwrap_err(), "wrong_issuer");
        let evil = "x/../evil";
        assert_eq!(id_token_claims(&t(&format!("https://login.microsoftonline.com/{evil}/v2.0"), json!(evil)), &d, "kanb", "n", 1000).unwrap_err(), "wrong_issuer");
        assert_eq!(id_token_claims(&t("https://login.microsoftonline.com/{tenantid}/v2.0", json!(tid)), &d, "kanb", "n", 1000).unwrap_err(), "wrong_issuer");
        assert_eq!(id_token_claims(&t(&format!("https://evil.example.com/{tid}/v2.0"), json!(tid)), &d, "kanb", "n", 1000).unwrap_err(), "wrong_issuer");
    }

    #[test]
    fn issuer_aliases_on_the_same_host() {
        // Microsoft reports the tenant id for "consumers" or a domain name
        assert!(same_issuer("https://login.microsoftonline.com/consumers/v2.0", "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0"));
        assert!(same_issuer("https://accounts.google.com/", "https://accounts.google.com"));
        assert!(!same_issuer("https://login.microsoftonline.com/common/v2.0", "https://evil.example.com/common/v2.0"));
        assert!(!same_issuer("https://idp.example.com", "http://idp.example.com"));
    }

    #[test]
    fn old_settings_become_a_list_of_one() {
        let s = parse(json!({ "enabled": true, "issuer": "https://accounts.google.com", "client_id": "c", "client_secret": "enc:v1:abc",
                               "label": "Google", "allowed_domains": [], "trust_email": false, "require_sso": true }));
        assert_eq!(s.providers.len(), 1);
        assert_eq!(s.providers[0].id, "default");
        assert_eq!(s.providers[0].client_secret, "enc:v1:abc", "the sealed secret is kept as it is");
        assert!(s.require_sso);
        let empty = parse(json!({ "enabled": false, "issuer": "", "client_id": "", "client_secret": "", "require_sso": false }));
        assert!(empty.providers.is_empty());
        let new = parse(json!({ "providers": [{ "id": "a", "enabled": true, "issuer": "https://x.example.com" }], "require_sso": false }));
        assert_eq!(new.providers[0].id, "a");
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
