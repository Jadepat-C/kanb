//! Browser notifications (Web Push, RFC 8030/8291/8292). Each person turns them on per browser in Profile; the
//! browser hands us a push-service URL (Google, Mozilla, Apple…) and keys, and we post encrypted notifications there.
//! Our VAPID key is generated once and stored (encrypted) in app_settings.

use axum::{Json, extract::State, http::HeaderMap};
use base64ct::{Base64UrlUnpadded, Encoding};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;
use web_push_native::{
    Auth, WebPushBuilder,
    jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair},
    p256::PublicKey,
};

use crate::{
    AppState,
    auth::CurrentUser,
    error::{AppError, AppResult},
    notify::Message,
};

const KEY: &str = "vapid";

/// Our VAPID key pair (created on first use).
async fn keypair(state: &AppState) -> AppResult<ES256KeyPair> {
    let row: Option<(Value,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = $1").bind(KEY).fetch_optional(&state.db).await?;
    if let Some(stored) = row.and_then(|(v,)| v.get("private").and_then(|p| p.as_str()).map(str::to_string)) {
        let raw = crate::crypto::open(&stored).map_err(AppError::Internal)?;
        let bytes = Base64UrlUnpadded::decode_vec(&raw).map_err(|e| anyhow::anyhow!("vapid key: {e}"))?;
        return ES256KeyPair::from_bytes(&bytes).map_err(|e| AppError::Internal(anyhow::anyhow!("vapid key: {e}")));
    }
    let kp = ES256KeyPair::generate();
    let private = Base64UrlUnpadded::encode_string(&kp.to_bytes());
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING")
        .bind(KEY)
        .bind(json!({ "private": crate::crypto::seal(&private) }))
        .execute(&state.db)
        .await?;
    // another server may have won the race: use whatever is stored now
    Box::pin(keypair(state)).await
}

fn public_b64(kp: &ES256KeyPair) -> String {
    Base64UrlUnpadded::encode_string(&kp.public_key().public_key().to_bytes_uncompressed())
}

/// What the browser needs to subscribe.
pub async fn info(State(state): State<AppState>, CurrentUser(_u): CurrentUser) -> AppResult<Json<Value>> {
    let kp = keypair(&state).await?;
    Ok(Json(json!({ "public_key": public_b64(&kp), "enabled": crate::contacts::system(&state).await.browser })))
}

#[derive(Deserialize)]
pub struct Keys {
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
pub struct SubReq {
    endpoint: String,
    keys: Option<Keys>,
}

fn valid_endpoint(e: &str) -> bool {
    reqwest::Url::parse(e).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some()) && e.len() < 2000
}

pub async fn subscribe(State(state): State<AppState>, CurrentUser(u): CurrentUser, headers: HeaderMap, Json(r): Json<SubReq>) -> AppResult<Json<Value>> {
    let keys = r.keys.ok_or(AppError::BadRequest("invalid_subscription"))?;
    if !valid_endpoint(&r.endpoint)
        || Base64UrlUnpadded::decode_vec(&keys.p256dh).ok().and_then(|b| PublicKey::from_sec1_bytes(&b).ok()).is_none()
        || Base64UrlUnpadded::decode_vec(&keys.auth).map(|b| b.len()).unwrap_or(0) != 16
    {
        return Err(AppError::BadRequest("invalid_subscription"));
    }
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM push_subscriptions WHERE user_id = $1").bind(u.id).fetch_one(&state.db).await?;
    if n >= 20 {
        // keep the newest 19
        sqlx::query("DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at LIMIT $2)")
            .bind(u.id)
            .bind(n - 19)
            .execute(&state.db)
            .await?;
    }
    let ua = headers.get(axum::http::header::USER_AGENT).and_then(|v| v.to_str().ok()).map(|s| s.chars().take(200).collect::<String>());
    sqlx::query(
        "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent",
    )
    .bind(Uuid::now_v7())
    .bind(u.id)
    .bind(&r.endpoint)
    .bind(&keys.p256dh)
    .bind(&keys.auth)
    .bind(ua)
    .execute(&state.db)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn unsubscribe(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<SubReq>) -> AppResult<Json<Value>> {
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2").bind(&r.endpoint).bind(u.id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn test(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    let th = u.locale == "th";
    let base = crate::notify::base_url(&state).await;
    let payload = json!({
        "title": if th { "ทดสอบการแจ้งเตือน" } else { "Test notification" },
        "body": if th { "การแจ้งเตือนบนเบราว์เซอร์ใช้งานได้แล้ว" } else { "Browser notifications work." },
        "url": base, "tag": "kanban-test",
    });
    let (sent, failed) = send_to_user(&state, u.id, &payload).await;
    Ok(Json(json!({ "sent": sent, "failed": failed })))
}

/// A stored notification → every browser of its recipient.
pub async fn deliver(state: &AppState, m: &Message) {
    if !crate::contacts::system(state).await.browser {
        return;
    }
    let body = if m.snippet.is_empty() { m.line.clone() } else { format!("{}\n“{}”", m.line, m.snippet) };
    let payload = json!({ "title": m.subject, "body": body, "url": m.link, "tag": m.card_id.map(|c| c.to_string()).unwrap_or_default() });
    send_to_user(state, m.user_id, &payload).await;
}

async fn send_to_user(state: &AppState, user_id: Uuid, payload: &Value) -> (usize, usize) {
    let subs: Vec<(Uuid, String, String, String)> =
        match sqlx::query_as("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1").bind(user_id).fetch_all(&state.db).await {
            Ok(s) => s,
            Err(_) => return (0, 0),
        };
    if subs.is_empty() {
        return (0, 0);
    }
    let kp = match keypair(state).await {
        Ok(k) => k,
        Err(e) => {
            tracing::warn!(error = %e, "web push: no VAPID key");
            return (0, subs.len());
        }
    };
    let contact = contact(state).await;
    let body = serde_json::to_vec(payload).unwrap_or_default();
    let (mut ok, mut failed) = (0, 0);
    for (id, endpoint, p256dh, auth) in subs {
        match push_one(state, &kp, &contact, &endpoint, &p256dh, &auth, &body).await {
            Ok(()) => {
                ok += 1;
                crate::metrics::delivery("browser_push", true);
                let _ = sqlx::query("UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1").bind(id).execute(&state.db).await;
            }
            Err(Gone) => {
                failed += 1;
                crate::metrics::delivery("browser_push", false);
                // the browser unsubscribed or the subscription expired
                let _ = sqlx::query("DELETE FROM push_subscriptions WHERE id = $1").bind(id).execute(&state.db).await;
            }
        }
    }
    (ok, failed)
}

struct Gone;

async fn push_one(state: &AppState, kp: &ES256KeyPair, contact: &str, endpoint: &str, p256dh: &str, auth: &str, body: &[u8]) -> Result<(), Gone> {
    let build = || -> anyhow::Result<axum::http::Request<Vec<u8>>> {
        let ua_public = PublicKey::from_sec1_bytes(&Base64UrlUnpadded::decode_vec(p256dh)?)?;
        let ua_auth = Auth::from(<[u8; 16]>::try_from(Base64UrlUnpadded::decode_vec(auth)?.as_slice())?);
        let req = WebPushBuilder::new(endpoint.parse()?, ua_public, ua_auth)
            .with_valid_duration(std::time::Duration::from_secs(24 * 3600))
            .with_vapid(kp, contact)
            .build(body.to_vec())?;
        Ok(req)
    };
    let req = match build() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "web push: bad subscription");
            return Err(Gone);
        }
    };
    let headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .filter(|(k, _)| *k != axum::http::header::CONTENT_LENGTH)
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
        .collect();
    // push services are on the public internet; never follow a subscription to a private address
    match crate::contacts::http_post(state, false, endpoint, headers, req.into_body()).await {
        Ok((s, _)) if (200..300).contains(&s) => Ok(()),
        Ok((404 | 410, _)) => Err(Gone),
        Ok((s, text)) => {
            tracing::warn!(status = s, body = %text.chars().take(200).collect::<String>(), "web push rejected");
            Ok(()) // temporary trouble: keep the subscription
        }
        Err(e) => {
            tracing::warn!(error = %e, "web push failed");
            if e.contains("private/internal") { Err(Gone) } else { Ok(()) }
        }
    }
}

/// VAPID "sub": a mailto: or https: contact for push services.
async fn contact(state: &AppState) -> String {
    let base = crate::notify::base_url(state).await;
    if base.starts_with("https://") {
        return base;
    }
    match crate::mail::load(state).await {
        Ok(s) if !s.from_email.trim().is_empty() => format!("mailto:{}", s.from_email.trim()),
        _ => "mailto:admin@localhost".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_push_native::p256::SecretKey;

    #[test]
    fn encrypts_for_the_browser() {
        // a fake browser subscription
        let mut raw = [0u8; 32];
        getrandom::fill(&mut raw).unwrap();
        let ua_secret = SecretKey::from_slice(&raw).unwrap();
        let ua_public = ua_secret.public_key();
        let auth = Auth::from([7u8; 16]);
        let kp = ES256KeyPair::generate();
        let req = WebPushBuilder::new("https://push.example.com/abc".parse().unwrap(), ua_public, auth)
            .with_vapid(&kp, "mailto:a@b.c")
            .build(br#"{"title":"hi"}"#.to_vec())
            .unwrap();
        assert_eq!(req.headers()["content-encoding"], "aes128gcm");
        assert!(req.headers()["authorization"].to_str().unwrap().starts_with("vapid t="));
        let plain = web_push_native::decrypt(req.into_body(), &ua_secret, &auth).unwrap();
        assert_eq!(plain, br#"{"title":"hi"}"#);
    }
}
