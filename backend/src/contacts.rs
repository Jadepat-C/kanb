//! Personal notification channels ("contact points", like Grafana's): each user can send their notifications to
//! Discord, Slack, Microsoft Teams, Google Chat, Telegram, LINE, ntfy, Gotify or any JSON webhook.
//! Plus the system switches a super admin controls (Admin → Notifications).
//!
//! Safety: the server makes requests to addresses users type in, so by default only public internet addresses are
//! allowed (no localhost, LAN, Tailscale 100.64/10 …), checked after DNS and pinned for the request; redirects are
//! not followed. Secrets (webhook URLs, tokens) never go back to the browser.

use std::net::{IpAddr, SocketAddr};

use axum::{
    Json,
    extract::{Path, State},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{CurrentUser, SuperAdmin},
    error::{AppError, AppResult},
    notify::Message,
};

// ---------- system switches ----------

#[derive(Serialize, Deserialize, Clone)]
pub struct System {
    /// email notifications (users still choose for themselves in Profile)
    #[serde(default)]
    pub email: bool,
    /// contact points (Discord, Slack, …)
    #[serde(default)]
    pub push: bool,
    /// let contact points reach private addresses (a self-hosted ntfy/Gotify on the LAN or tailnet)
    #[serde(default)]
    pub allow_private: bool,
    /// browser (Web Push) notifications; each person still turns them on in their own browser
    #[serde(default = "yes")]
    pub browser: bool,
}

fn yes() -> bool {
    true
}

impl Default for System {
    fn default() -> Self {
        Self { email: false, push: false, allow_private: false, browser: true }
    }
}

const KEY: &str = "notifications";

pub async fn system(state: &AppState) -> System {
    let row: Option<(Value,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = $1").bind(KEY).fetch_optional(&state.db).await.ok().flatten();
    row.and_then(|(v,)| serde_json::from_value(v).ok()).unwrap_or_default()
}

pub async fn admin_get(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<Value>> {
    let smtp = crate::mail::load(&state).await?;
    Ok(Json(json!({ "settings": system(&state).await, "smtp_ready": crate::mail::ready(&smtp) })))
}

pub async fn admin_save(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, Json(s): Json<System>) -> AppResult<Json<Value>> {
    sqlx::query(
        "INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(KEY)
    .bind(serde_json::to_value(&s).map_err(|e| anyhow::anyhow!(e))?)
    .execute(&state.db)
    .await?;
    tracing::info!(by = %me.username, email = s.email, push = s.push, allow_private = s.allow_private, "notification settings saved");
    Ok(Json(json!({ "settings": s })))
}

// ---------- kinds ----------

struct FieldSpec {
    name: &'static str,
    secret: bool,
    required: bool,
}
const fn f(name: &'static str, secret: bool, required: bool) -> FieldSpec {
    FieldSpec { name, secret, required }
}

const URL: &[FieldSpec] = &[f("url", true, true)];
const TELEGRAM: &[FieldSpec] = &[f("bot_token", true, true), f("chat_id", false, true)];
const LINE: &[FieldSpec] = &[f("token", true, true), f("to", false, true)];
// the topic name is the only protection on a public ntfy server, so the URL is treated as a secret
const NTFY: &[FieldSpec] = &[f("url", true, true), f("token", true, false)];
const GOTIFY: &[FieldSpec] = &[f("url", false, true), f("token", true, true)];
const WEBHOOK: &[FieldSpec] = &[f("url", true, true), f("secret", true, false)];

fn spec(kind: &str) -> Option<&'static [FieldSpec]> {
    Some(match kind {
        "discord" | "slack" | "teams" | "googlechat" => URL,
        "telegram" => TELEGRAM,
        "line" => LINE,
        "ntfy" => NTFY,
        "gotify" => GOTIFY,
        "webhook" => WEBHOOK,
        _ => return None,
    })
}

/// Encrypts the kind's secret fields for storage.
pub(crate) fn seal_cfg(kind: &str, mut cfg: Map<String, Value>) -> Map<String, Value> {
    for fs in spec(kind).unwrap_or(&[]) {
        if fs.secret
            && let Some(Value::String(v)) = cfg.get(fs.name)
        {
            let sealed = crate::crypto::seal(v);
            cfg.insert(fs.name.into(), sealed.into());
        }
    }
    cfg
}

/// Decrypts the kind's secret fields (plain old values pass through).
pub(crate) fn open_cfg(kind: &str, mut cfg: Map<String, Value>) -> Map<String, Value> {
    for fs in spec(kind).unwrap_or(&[]) {
        if fs.secret
            && let Some(Value::String(v)) = cfg.get(fs.name)
        {
            match crate::crypto::open(v) {
                Ok(p) => {
                    cfg.insert(fs.name.into(), p.into());
                }
                Err(e) => {
                    tracing::warn!(error = %e, "can't decrypt a contact point secret");
                    cfg.insert(fs.name.into(), "".into());
                }
            }
        }
    }
    cfg
}

const EVENTS: [&str; 5] = ["assigned", "mentioned", "commented", "due_soon", "overdue"];

fn get<'a>(cfg: &'a Map<String, Value>, k: &str) -> &'a str {
    cfg.get(k).and_then(|v| v.as_str()).map(str::trim).unwrap_or("")
}

fn parse_url(s: &str) -> Result<reqwest::Url, &'static str> {
    let u = reqwest::Url::parse(s).map_err(|_| "invalid_contact_url")?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none_or(str::is_empty) {
        return Err("invalid_contact_url");
    }
    Ok(u)
}

/// Format checks. The fixed services must point at their real hosts (so a "Discord" contact can't be aimed elsewhere).
pub(crate) fn validate(kind: &str, cfg: &Map<String, Value>) -> Result<(), &'static str> {
    let fields = spec(kind).ok_or("invalid_contact_kind")?;
    for fs in fields {
        let v = get(cfg, fs.name);
        if fs.required && v.is_empty() {
            return Err("contact_field_required");
        }
        if v.len() > 2000 {
            return Err("contact_field_too_long");
        }
    }
    let https_host = |allowed: &dyn Fn(&str) -> bool| -> Result<reqwest::Url, &'static str> {
        let u = parse_url(get(cfg, "url"))?;
        if u.scheme() != "https" || !allowed(u.host_str().unwrap_or("")) {
            return Err("invalid_contact_url");
        }
        Ok(u)
    };
    match kind {
        "discord" => {
            let u = https_host(&|h| matches!(h, "discord.com" | "discordapp.com" | "ptb.discord.com" | "canary.discord.com"))?;
            if !u.path().starts_with("/api/webhooks/") {
                return Err("invalid_contact_url");
            }
        }
        "slack" => {
            https_host(&|h| h == "hooks.slack.com")?;
        }
        "teams" => {
            https_host(&|h| [".webhook.office.com", ".logic.azure.com", ".powerplatform.com"].iter().any(|s| h.ends_with(s)))?;
        }
        "googlechat" => {
            https_host(&|h| h == "chat.googleapis.com")?;
        }
        "telegram" => {
            let t = get(cfg, "bot_token");
            let ok_token = t.split_once(':').is_some_and(|(id, rest)| {
                !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) && !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            });
            let c = get(cfg, "chat_id");
            let ok_chat = c.strip_prefix('-').unwrap_or(c).chars().all(|c| c.is_ascii_digit()) && !c.is_empty() && c != "-"
                || c.strip_prefix('@').is_some_and(|n| n.len() >= 4 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
            if !ok_token {
                return Err("invalid_telegram_token");
            }
            if !ok_chat {
                return Err("invalid_telegram_chat");
            }
        }
        "line" => {
            let to = get(cfg, "to");
            if !(to.len() == 33 && matches!(&to[..1], "U" | "C" | "R") && to[1..].chars().all(|c| c.is_ascii_hexdigit())) {
                return Err("invalid_line_to");
            }
            if !get(cfg, "token").chars().all(|c| c.is_ascii_alphanumeric() || "+/=._-".contains(c)) {
                return Err("invalid_contact_token");
            }
        }
        "ntfy" => {
            let u = parse_url(get(cfg, "url"))?;
            if u.path_segments().and_then(|mut s| s.next_back()).is_none_or(str::is_empty) {
                return Err("invalid_ntfy_topic");
            }
        }
        _ => {
            parse_url(get(cfg, "url"))?;
        }
    }
    Ok(())
}

// ---------- CRUD (Profile) ----------

#[derive(sqlx::FromRow)]
pub(crate) struct Row {
    pub id: Uuid,
    pub kind: String,
    pub name: String,
    pub config: Value,
    pub events: Vec<String>,
    pub enabled: bool,
    pub last_sent_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
}

pub(crate) const COLS: &str = "id, kind, name, config, events, enabled, last_sent_at, last_error";

/// What the browser sees: non-secret fields, which secrets are set, and a hint like "discord.com/…".
pub(crate) fn view(r: &Row) -> Value {
    let cfg = open_cfg(&r.kind, r.config.as_object().cloned().unwrap_or_default());
    let mut public = Map::new();
    let mut set = Vec::new();
    for fs in spec(&r.kind).unwrap_or(&[]) {
        let v = get(&cfg, fs.name);
        if fs.secret {
            if !v.is_empty() {
                set.push(fs.name);
            }
        } else {
            public.insert(fs.name.into(), v.into());
        }
    }
    let summary = match r.kind.as_str() {
        "telegram" => format!("chat {}", get(&cfg, "chat_id")),
        "line" => format!("{}…", &get(&cfg, "to").chars().take(9).collect::<String>()),
        _ => parse_url(get(&cfg, "url")).ok().and_then(|u| u.host_str().map(|h| format!("{h}/…"))).unwrap_or_default(),
    };
    json!({
        "id": r.id, "kind": r.kind, "name": r.name, "config": public, "secrets_set": set, "summary": summary,
        "events": r.events, "enabled": r.enabled, "last_sent_at": r.last_sent_at, "last_error": r.last_error,
    })
}

pub async fn list(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    let rows: Vec<Row> = sqlx::query_as(sqlf!("SELECT {COLS} FROM contact_points WHERE user_id = $1 ORDER BY created_at"))
        .bind(u.id)
        .fetch_all(&state.db)
        .await?;
    let sys = system(&state).await;
    let smtp = crate::mail::load(&state).await?;
    Ok(Json(json!({
        "system": { "email": sys.email && crate::mail::ready(&smtp), "push": sys.push },
        "items": rows.iter().map(view).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct ContactReq {
    kind: Option<String>,
    name: Option<String>,
    /// secret fields left empty keep their saved value
    config: Option<Map<String, Value>>,
    events: Option<Vec<String>>,
    enabled: Option<bool>,
    /// test only: the saved contact point whose secrets fill the blanks
    id: Option<Uuid>,
}

async fn owned(state: &AppState, user_id: Uuid, id: Uuid) -> AppResult<Row> {
    sqlx::query_as(sqlf!("SELECT {COLS} FROM contact_points WHERE id = $1 AND user_id = $2"))
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)
}

/// New config = only the kind's fields; empty secrets fall back to the saved ones (when the kind didn't change).
pub(crate) fn merge(kind: &str, incoming: &Map<String, Value>, saved: Option<&Row>) -> AppResult<Map<String, Value>> {
    let fields = spec(kind).ok_or(AppError::BadRequest("invalid_contact_kind"))?;
    let old = open_cfg(kind, saved.filter(|r| r.kind == kind).and_then(|r| r.config.as_object().cloned()).unwrap_or_default());
    let mut out = Map::new();
    for fs in fields {
        let mut v = get(incoming, fs.name).to_string();
        if fs.secret && v.is_empty() {
            v = get(&old, fs.name).to_string();
        }
        if !v.is_empty() {
            out.insert(fs.name.into(), v.into());
        }
    }
    Ok(out)
}

/// Known event names only; "all of them" is stored as empty (so future kinds are included too).
pub(crate) fn clean_events(e: Option<Vec<String>>, allowed: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = e.unwrap_or_default().into_iter().filter(|k| allowed.contains(&k.as_str())).collect();
    v.sort();
    v.dedup();
    if v.len() == allowed.len() { Vec::new() } else { v }
}

pub async fn create(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<ContactReq>) -> AppResult<Json<Value>> {
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM contact_points WHERE user_id = $1").bind(u.id).fetch_one(&state.db).await?;
    if n >= 20 {
        return Err(AppError::BadRequest("too_many_contacts"));
    }
    let kind = r.kind.unwrap_or_default();
    let cfg = merge(&kind, &r.config.unwrap_or_default(), None)?;
    validate(&kind, &cfg).map_err(AppError::BadRequest)?;
    let name = r.name.map(|s| s.trim().chars().take(80).collect::<String>()).filter(|s| !s.is_empty()).ok_or(AppError::BadRequest("name_required"))?;
    let row: Row = sqlx::query_as(sqlf!(
        "INSERT INTO contact_points (id, user_id, kind, name, config, events, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING {COLS}"
    ))
    .bind(Uuid::now_v7())
    .bind(u.id)
    .bind(&kind)
    .bind(name)
    .bind(Value::Object(seal_cfg(&kind, cfg)))
    .bind(clean_events(r.events, &EVENTS))
    .bind(r.enabled.unwrap_or(true))
    .fetch_one(&state.db)
    .await?;
    Ok(Json(view(&row)))
}

pub async fn update(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, Json(r): Json<ContactReq>) -> AppResult<Json<Value>> {
    let old = owned(&state, u.id, id).await?;
    let kind = r.kind.clone().unwrap_or_else(|| old.kind.clone());
    let cfg = match &r.config {
        Some(c) => merge(&kind, c, Some(&old))?,
        None if kind == old.kind => open_cfg(&kind, old.config.as_object().cloned().unwrap_or_default()),
        None => return Err(AppError::BadRequest("contact_field_required")),
    };
    validate(&kind, &cfg).map_err(AppError::BadRequest)?;
    let name = match r.name {
        Some(n) => Some(n.trim().chars().take(80).collect::<String>()).filter(|s| !s.is_empty()).ok_or(AppError::BadRequest("name_required"))?,
        None => old.name.clone(),
    };
    let row: Row = sqlx::query_as(sqlf!(
        "UPDATE contact_points SET kind = $2, name = $3, config = $4, events = $5, enabled = $6,
                last_error = CASE WHEN config = $4 THEN last_error END
         WHERE id = $1 RETURNING {COLS}"
    ))
    .bind(id)
    .bind(&kind)
    .bind(name)
    .bind(Value::Object(seal_cfg(&kind, cfg)))
    .bind(match r.events {
        Some(e) => clean_events(Some(e), &EVENTS),
        None => old.events.clone(),
    })
    .bind(r.enabled.unwrap_or(old.enabled))
    .fetch_one(&state.db)
    .await?;
    Ok(Json(view(&row)))
}

pub async fn delete(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    owned(&state, u.id, id).await?;
    sqlx::query("DELETE FROM contact_points WHERE id = $1").bind(id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

/// "Send test": works on unsaved settings too (secrets left blank come from the saved contact point).
pub async fn test(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<ContactReq>) -> AppResult<Json<Value>> {
    let sys = system(&state).await;
    if !sys.push {
        return Err(AppError::BadRequest("push_disabled"));
    }
    let saved = match r.id {
        Some(id) => Some(owned(&state, u.id, id).await?),
        None => None,
    };
    let kind = r.kind.clone().or_else(|| saved.as_ref().map(|s| s.kind.clone())).unwrap_or_default();
    let cfg = match &r.config {
        Some(c) => merge(&kind, c, saved.as_ref())?,
        None => open_cfg(&kind, saved.as_ref().and_then(|s| s.config.as_object().cloned()).unwrap_or_default()),
    };
    validate(&kind, &cfg).map_err(AppError::BadRequest)?;
    let name = r.name.clone().or_else(|| saved.as_ref().map(|s| s.name.clone())).unwrap_or_default();
    let th = u.locale == "th";
    let base = crate::notify::base_url(&state).await;
    let msg = Message {
        user_id: u.id,
        kind: "test".into(),
        th,
        to_email: None,
        to_name: u.display_name.clone(),
        actor: None,
        subject: if th { "ทดสอบการแจ้งเตือนจาก Kanb".into() } else { "Test notification from Kanb".into() },
        line: if th {
            format!("ถ้าคุณเห็นข้อความนี้ แสดงว่า “{name}” ใช้งานได้แล้ว")
        } else {
            format!("If you can read this, “{name}” works.")
        },
        snippet: String::new(),
        link: base,
        open_label: if th { "เปิด Kanb" } else { "Open Kanb" },
        board_id: Uuid::nil(),
        board_name: "Kanb".into(),
        card_id: None,
        card_number: None,
        card_title: None,
        created_at: Utc::now(),
        changes: Vec::new(),
        scope: "user",
    };
    let res = send(&state, &sys, &kind, &cfg, &msg).await;
    if let Some(s) = &saved {
        record(&state, s.id, &res).await;
    }
    Ok(Json(match res {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }))
}

async fn record(state: &AppState, id: Uuid, res: &Result<(), String>) {
    record_in(state, "contact_points", id, res).await
}

/// Remembers the last delivery result on a contact point (personal or board).
pub(crate) async fn record_in(state: &AppState, table: &'static str, id: Uuid, res: &Result<(), String>) {
    let _ = match res {
        Ok(()) => sqlx::query(sqlf!("UPDATE {table} SET last_sent_at = now(), last_error = NULL WHERE id = $1")).bind(id).execute(&state.db).await,
        Err(e) => sqlx::query(sqlf!("UPDATE {table} SET last_error = $2 WHERE id = $1")).bind(id).bind(e).execute(&state.db).await,
    };
}

// ---------- delivery ----------

/// Sends a notification to the recipient's enabled contact points that want this kind.
pub async fn deliver(state: &AppState, m: &Message) {
    let sys = system(state).await;
    if !sys.push {
        return;
    }
    let rows: Vec<Row> = match sqlx::query_as(sqlf!(
        "SELECT {COLS} FROM contact_points WHERE user_id = $1 AND enabled AND (events = '{{}}' OR $2 = ANY(events))"
    ))
    .bind(m.user_id)
    .bind(&m.kind)
    .fetch_all(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return tracing::warn!(error = %e, "loading contact points failed"),
    };
    for r in rows {
        let cfg = r.config.as_object().cloned().unwrap_or_default();
        let res = send(state, &sys, &r.kind, &cfg, m).await;
        if let Err(e) = &res {
            tracing::warn!(contact = %r.id, kind = %r.kind, error = %e, "contact point delivery failed");
        }
        record(state, r.id, &res).await;
    }
}

fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { s.chars().take(n - 1).collect::<String>() + "…" }
}

fn html_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Builds the platform's request and sends it.
pub(crate) async fn send(state: &AppState, sys: &System, kind: &str, cfg: &Map<String, Value>, m: &Message) -> Result<(), String> {
    let cfg = &open_cfg(kind, cfg.clone());
    let quote = |pre: &str, post: &str| if m.snippet.is_empty() { String::new() } else { format!("{pre}{}{post}", m.snippet) };
    let mut headers: Vec<(&str, String)> = Vec::new();
    let (url, body): (String, Value) = match kind {
        "discord" => {
            let mut u = parse_url(get(cfg, "url")).map_err(str::to_string)?;
            u.query_pairs_mut().append_pair("wait", "true"); // so errors come back
            let desc = format!("{}{}", m.line, quote("\n> ", "")).trim().to_string();
            let body = json!({
                "username": "Kanb",
                "allowed_mentions": { "parse": [] }, // a comment containing @everyone must not ping the server
                "embeds": [{
                    "title": trunc(&m.subject, 256), "url": m.link, "description": trunc(&desc, 4000), "color": 0x2f5bd3,
                    "footer": { "text": trunc(&m.board_name, 2048) }, "timestamp": m.created_at.to_rfc3339(),
                }],
            });
            (u.to_string(), body)
        }
        "slack" => {
            let e = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
            let text = format!("*<{}|{}>*\n{}{}", m.link, e(&m.subject), e(&m.line), if m.snippet.is_empty() { String::new() } else { format!("\n>{}", e(&m.snippet)) });
            (get(cfg, "url").into(), json!({ "text": m.subject, "blocks": [{ "type": "section", "text": { "type": "mrkdwn", "text": trunc(&text, 3000) } }] }))
        }
        "teams" => {
            let mut blocks = vec![
                json!({ "type": "TextBlock", "text": m.subject, "weight": "Bolder", "size": "Medium", "wrap": true }),
                json!({ "type": "TextBlock", "text": m.line, "wrap": true }),
            ];
            if !m.snippet.is_empty() {
                blocks.push(json!({ "type": "TextBlock", "text": format!("“{}”", m.snippet), "wrap": true, "isSubtle": true }));
            }
            let card = json!({
                "$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.4",
                "body": blocks, "actions": [{ "type": "Action.OpenUrl", "title": m.open_label, "url": m.link }],
            });
            (get(cfg, "url").into(), json!({ "type": "message", "attachments": [{ "contentType": "application/vnd.microsoft.card.adaptive", "content": card }] }))
        }
        "googlechat" => {
            let text = format!("*{}*\n{}{}\n<{}|{}>", m.subject, m.line, quote("\n_", "_"), m.link, m.open_label);
            (get(cfg, "url").into(), json!({ "text": trunc(&text, 4000) }))
        }
        "telegram" => {
            let text = format!(
                "<b>{}</b>\n{}{}\n<a href=\"{}\">{}</a>",
                html_esc(&m.subject),
                html_esc(&m.line),
                if m.snippet.is_empty() { String::new() } else { format!("\n<blockquote>{}</blockquote>", html_esc(&m.snippet)) },
                html_esc(&m.link),
                m.open_label
            );
            let chat = get(cfg, "chat_id");
            let chat: Value = chat.parse::<i64>().map(Value::from).unwrap_or_else(|_| chat.into());
            (
                format!("https://api.telegram.org/bot{}/sendMessage", get(cfg, "bot_token")),
                json!({ "chat_id": chat, "text": text, "parse_mode": "HTML", "link_preview_options": { "is_disabled": true } }),
            )
        }
        "line" => {
            headers.push(("Authorization", format!("Bearer {}", get(cfg, "token"))));
            let text = format!("{}\n{}{}\n{}", m.subject, m.line, quote("\n「", "」"), m.link);
            ("https://api.line.me/v2/bot/message/push".into(), json!({ "to": get(cfg, "to"), "messages": [{ "type": "text", "text": trunc(&text, 5000) }] }))
        }
        "ntfy" => {
            // JSON publishing (POST to the server root with the topic inside) keeps Thai titles intact
            let mut u = parse_url(get(cfg, "url")).map_err(str::to_string)?;
            let topic = u.path_segments().and_then(|mut s| s.next_back()).unwrap_or("").to_string();
            u.path_segments_mut().map_err(|_| "invalid_contact_url")?.pop();
            if !get(cfg, "token").is_empty() {
                headers.push(("Authorization", format!("Bearer {}", get(cfg, "token"))));
            }
            let tag = match m.kind.as_str() {
                "due_soon" | "overdue" | "due" => "alarm_clock",
                "commented" => "speech_balloon",
                "mentioned" => "speech_balloon",
                _ => "bell",
            };
            let msg = format!("{}{}", m.line, quote("\n“", "”")).trim().to_string();
            let body = json!({ "topic": topic, "title": m.subject, "message": if msg.is_empty() { m.subject.clone() } else { msg }, "click": m.link, "tags": [tag] });
            (u.to_string(), body)
        }
        "gotify" => {
            headers.push(("X-Gotify-Key", get(cfg, "token").into()));
            let body = json!({
                "title": m.subject, "message": format!("{}{}\n{}", m.line, quote("\n“", "”"), m.link).trim().to_string(), "priority": 5,
                "extras": { "client::notification": { "click": { "url": m.link } } },
            });
            (format!("{}/message", get(cfg, "url").trim_end_matches('/')), body)
        }
        "webhook" => {
            let body = json!({
                "scope": m.scope, "event": m.kind, "test": m.kind == "test", "changes": m.changes, "title": m.subject, "message": m.line, "snippet": m.snippet, "url": m.link,
                "actor": m.actor, "created_at": m.created_at,
                "board": if m.board_id.is_nil() { Value::Null } else { json!({ "id": m.board_id, "name": m.board_name }) },
                "card": m.card_id.map(|id| json!({ "id": id, "number": m.card_number, "title": m.card_title })),
            });
            headers.push(("X-Kanb-Event", m.kind.clone()));
            (get(cfg, "url").into(), body)
        }
        _ => return Err("unknown contact point type".into()),
    };
    let bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    if kind == "webhook" && !get(cfg, "secret").is_empty() {
        headers.push(("X-Kanb-Signature", format!("sha256={}", hex::encode(hmac_sha256(get(cfg, "secret").as_bytes(), &bytes)))));
    }
    post(state, sys, &url, headers, bytes).await
}

/// Public internet only (unless the admin allows private addresses).
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_broadcast()
                || v.is_documentation()
                || v.is_unspecified()
                || v.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10: carrier-grade NAT, Tailscale
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (o[1] & 0xfe) == 18)
                || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let s = v.segments();
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80)
        }
    }
}

async fn post(state: &AppState, sys: &System, url: &str, headers: Vec<(&str, String)>, body: Vec<u8>) -> Result<(), String> {
    let mut h: Vec<(String, String)> = vec![("Content-Type".into(), "application/json".into())];
    h.extend(headers.into_iter().map(|(k, v)| (k.to_string(), v)));
    let (status, text) = http_post(state, sys.allow_private, url, h, body).await?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    Err(format!("HTTP {status}: {}", trunc(text.trim(), 300)))
}

/// POST to a user-supplied URL safely: public addresses only (unless allowed), DNS pinned, no redirects, 10 s.
/// Returns the status and body; Err only when the request couldn't be made.
pub(crate) async fn http_post(state: &AppState, allow_private: bool, url: &str, headers: Vec<(String, String)>, body: Vec<u8>) -> Result<(u16, String), String> {
    let target = reqwest::Url::parse(url).map_err(|_| "invalid URL".to_string())?;
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Kanb-notifications");
    let final_url = if let Some(base) = state.config.webhook_redirect.as_deref() {
        // dev/test: everything goes to the local catcher
        let mut u = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
        u.set_path(target.path());
        u.set_query(target.query());
        u
    } else {
        let host = target.host_str().ok_or("invalid URL")?.to_string();
        let port = target.port_or_known_default().unwrap_or(443);
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.trim_matches(['[', ']']), port))
            .await
            .map_err(|_| format!("can't resolve {host}"))?
            .collect();
        let addr = *addrs.first().ok_or_else(|| format!("can't resolve {host}"))?;
        if !allow_private && addrs.iter().any(|a| !is_public(a.ip())) {
            return Err(format!("{host} is a private/internal address (an admin can allow these in Admin → Notifications)"));
        }
        // pin the checked address so DNS can't change between the check and the request
        builder = builder.resolve(&host, addr);
        target.clone()
    };
    let client = builder.build().map_err(|e| e.to_string())?;
    let mut req = client.post(final_url).body(body);
    if state.config.webhook_redirect.is_some() {
        req = req.header("X-Original-Url", target.as_str());
    }
    for (k, v) in headers {
        req = req.header(k, v);
    }
    // without_url: the URL may contain a token
    let res = req.send().await.map_err(|e| e.without_url().to_string())?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    Ok((status, text))
}

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(msg);
    let ih = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(ih);
    outer.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_rfc4231() {
        assert_eq!(
            hex::encode(hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn private_addresses() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.16.0.1", "100.64.12.34", "169.254.169.254", "0.0.0.0", "::1", "fd7a:115c:a1e0::1", "::ffff:192.168.1.1"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "162.159.135.232", "2606:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn validation() {
        let c = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), Value::from(*v))).collect::<Map<_, _>>();
        assert!(validate("discord", &c(&[("url", "https://discord.com/api/webhooks/1/abc")])).is_ok());
        assert!(validate("discord", &c(&[("url", "https://evil.example/api/webhooks/1/abc")])).is_err());
        assert!(validate("discord", &c(&[("url", "http://discord.com/api/webhooks/1/abc")])).is_err());
        assert!(validate("telegram", &c(&[("bot_token", "123:AA-b_c"), ("chat_id", "-1001234")])).is_ok());
        assert!(validate("telegram", &c(&[("bot_token", "123:AA/../x"), ("chat_id", "1")])).is_err());
        assert!(validate("line", &c(&[("token", "abc+/="), ("to", "U0123456789abcdef0123456789abcdef")])).is_ok());
        assert!(validate("ntfy", &c(&[("url", "https://ntfy.sh/")])).is_err());
        assert!(validate("ntfy", &c(&[("url", "https://ntfy.sh/my-topic")])).is_ok());
        assert!(validate("nope", &c(&[])).is_err());
    }
}
