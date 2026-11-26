//! Outgoing email (welcome / set-password and forgot-password links) over SMTP.
//! Configured by a super admin in the app (stored in `app_settings`), so no redeploy is needed.

use std::time::Duration;

use axum::{Json, extract::State};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, MultiPart},
    transport::smtp::authentication::Credentials,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    AppState,
    auth::SuperAdmin,
    error::{AppError, AppResult},
};

const KEY: &str = "smtp";

// Default is written out below: serde's `default = "…"` only applies when reading stored settings, so a derived
// Default gave a fresh install port 0 and an empty encryption, which the email settings form then failed to save.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmtpSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// starttls | tls | none
    #[serde(default = "default_security")]
    pub security: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub from_email: String,
    #[serde(default)]
    pub from_name: String,
    /// Base URL used in links, e.g. https://kanban.example.com (defaults to PUBLIC_ORIGIN)
    #[serde(default)]
    pub public_url: String,
}
impl Default for SmtpSettings {
    fn default() -> Self {
        // the same as an empty stored object: one source of truth for the defaults
        serde_json::from_value(serde_json::json!({})).expect("every field has a serde default")
    }
}

fn default_port() -> u16 {
    587
}
fn default_security() -> String {
    "starttls".into()
}

pub async fn load(state: &AppState) -> AppResult<SmtpSettings> {
    let row: Option<(serde_json::Value,)> =
        sqlx::query_as("SELECT value FROM app_settings WHERE key = $1").bind(KEY).fetch_optional(&state.db).await?;
    let mut s: SmtpSettings = row.and_then(|(v,)| serde_json::from_value(v).ok()).unwrap_or_default();
    s.password = crate::crypto::open(&s.password).map_err(AppError::Internal)?;
    if let Some(redirect) = state.config.mail_redirect.as_deref() {
        // dev/test safety valve: everything goes to the local catcher, whatever the saved settings say
        let (host, port) = redirect.rsplit_once(':').unwrap_or((redirect, "1025"));
        s.enabled = true;
        s.host = host.into();
        s.port = port.parse().unwrap_or(1025);
        s.security = "none".into();
        s.username.clear();
        s.password.clear();
        if s.from_email.is_empty() {
            s.from_email = "kanban@localhost".into();
        }
    }
    Ok(s)
}

/// Usable for sending right now?
pub fn ready(s: &SmtpSettings) -> bool {
    s.enabled && !s.host.trim().is_empty() && !s.from_email.trim().is_empty()
}

/// Base URL for links in emails.
pub fn base_url(state: &AppState, s: &SmtpSettings) -> String {
    let u = s.public_url.trim().trim_end_matches('/');
    if !u.is_empty() {
        return u.to_string();
    }
    state.origins.first().cloned().unwrap_or_else(|| "http://localhost:5173".into())
}

/// "Name <address>" built from its parts, so any display name works: parentheses, commas, quotes and Thai text in a
/// name are quoted or encoded as needed instead of being read as address syntax.
fn mailbox(name: &str, email: &str) -> Result<Mailbox, lettre::address::AddressError> {
    let name = name.trim();
    Ok(Mailbox::new((!name.is_empty()).then(|| name.to_string()), email.trim().parse()?))
}

/// The last send attempt since the server started (Admin → System): when, and the error if it failed.
static LAST_SEND: std::sync::Mutex<Option<(chrono::DateTime<chrono::Utc>, Option<String>)>> = std::sync::Mutex::new(None);

pub fn last_send() -> Option<(chrono::DateTime<chrono::Utc>, Option<String>)> {
    LAST_SEND.lock().ok().and_then(|g| g.clone())
}

pub async fn send(s: &SmtpSettings, to_email: &str, to_name: &str, subject: &str, text: String, html: String) -> Result<(), String> {
    let r = send_inner(s, to_email, to_name, subject, text, html).await;
    if let Ok(mut g) = LAST_SEND.lock() {
        *g = Some((chrono::Utc::now(), r.as_ref().err().cloned()));
    }
    r
}

async fn send_inner(s: &SmtpSettings, to_email: &str, to_name: &str, subject: &str, text: String, html: String) -> Result<(), String> {
    let from = mailbox(if s.from_name.trim().is_empty() { "Kanb" } else { s.from_name.trim() }, &s.from_email)
        .map_err(|e| format!("invalid sender address: {e}"))?;
    let to = mailbox(to_name, to_email).map_err(|e| format!("invalid recipient address: {e}"))?;
    let msg = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .multipart(MultiPart::alternative_plain_html(text, html))
        .map_err(|e| e.to_string())?;
    let host = s.host.trim();
    let builder = match s.security.as_str() {
        "tls" => AsyncSmtpTransport::<Tokio1Executor>::relay(host).map_err(|e| e.to_string())?,
        "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host),
        _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host).map_err(|e| e.to_string())?,
    }
    .port(s.port)
    .timeout(Some(Duration::from_secs(20)));
    let builder = if s.username.trim().is_empty() {
        builder
    } else {
        builder.credentials(Credentials::new(s.username.trim().to_string(), s.password.clone()))
    };
    builder.build().send(msg).await.map(|_| ()).map_err(|e| e.to_string())
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// (subject, text, html) for a link email. `kind` = invite | reset.
pub fn link_email(kind: &str, locale: &str, name: &str, username: &str, link: &str, sign_in: &str) -> (String, String, String) {
    let th = locale == "th";
    let (subject, intro, button, validity, outro) = match (kind, th) {
        ("invite", false) => (
            "Your Kanb account is ready".to_string(),
            format!("An account has been created for you. Your username is “{username}” (you can also sign in with this email address)."),
            "Set your password",
            "This link is valid for 3 days and can be used once.",
            format!("Afterwards, sign in at {sign_in}"),
        ),
        ("invite", true) => (
            "บัญชี Kanb ของคุณพร้อมใช้งานแล้ว".to_string(),
            format!("ผู้ดูแลระบบได้สร้างบัญชีให้คุณแล้ว ชื่อผู้ใช้ของคุณคือ “{username}” (เข้าสู่ระบบด้วยอีเมลนี้ได้เช่นกัน)"),
            "ตั้งรหัสผ่าน",
            "ลิงก์นี้ใช้ได้ 3 วัน และใช้ได้ครั้งเดียว",
            format!("จากนั้นเข้าสู่ระบบได้ที่ {sign_in}"),
        ),
        ("confirm", false) => (
            "Confirm your email for Kanb".to_string(),
            format!("Thanks for signing up as “{username}”. Please confirm that this is your email address."),
            "Confirm my email",
            "This link is valid for 24 hours. If you didn't sign up, ignore this email; the account is removed after a day.",
            format!("Afterwards, sign in at {sign_in}"),
        ),
        ("confirm", true) => (
            "ยืนยันอีเมลสำหรับ Kanb".to_string(),
            format!("ขอบคุณที่สมัครใช้งานด้วยชื่อผู้ใช้ “{username}” กรุณายืนยันว่านี่คืออีเมลของคุณ"),
            "ยืนยันอีเมล",
            "ลิงก์นี้ใช้ได้ 24 ชั่วโมง หากคุณไม่ได้สมัคร ไม่ต้องทำอะไร บัญชีจะถูกลบภายในหนึ่งวัน",
            format!("จากนั้นเข้าสู่ระบบได้ที่ {sign_in}"),
        ),
        ("approved", false) => (
            "Your Kanb account was approved".to_string(),
            format!("Good news: an administrator approved your account “{username}”. You can sign in now."),
            "Sign in",
            "",
            String::new(),
        ),
        ("approved", true) => (
            "บัญชี Kanb ของคุณได้รับการอนุมัติแล้ว".to_string(),
            format!("ผู้ดูแลระบบอนุมัติบัญชี “{username}” ของคุณแล้ว เข้าสู่ระบบได้เลย"),
            "เข้าสู่ระบบ",
            "",
            String::new(),
        ),
        (_, false) => (
            "Reset your Kanb password".to_string(),
            format!("Someone (hopefully you) asked to reset the password for “{username}”."),
            "Choose a new password",
            "This link is valid for 1 hour and can be used once. If you didn't ask for this, ignore this email; your password stays the same.",
            format!("Sign in at {sign_in}"),
        ),
        (_, true) => (
            "รีเซ็ตรหัสผ่าน Kanb".to_string(),
            format!("มีการขอรีเซ็ตรหัสผ่านของบัญชี “{username}”"),
            "ตั้งรหัสผ่านใหม่",
            "ลิงก์นี้ใช้ได้ 1 ชั่วโมง และใช้ได้ครั้งเดียว หากคุณไม่ได้ขอ ไม่ต้องทำอะไร รหัสผ่านเดิมยังใช้ได้",
            format!("เข้าสู่ระบบได้ที่ {sign_in}"),
        ),
    };
    let hello = if th { format!("สวัสดีคุณ {name}") } else { format!("Hello {name},") };
    let text = format!("{hello}\n\n{intro}\n\n{button}: {link}\n\n{validity}\n\n{outro}\n");
    let html = format!(
        r#"<div style="font-family:system-ui,'Anuphan',sans-serif;max-width:520px;margin:auto;color:#18181b;line-height:1.6">
<p>{h}</p><p>{i}</p>
<p style="margin:24px 0"><a href="{l}" style="background:#2f5bd3;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">{b}</a></p>
<p style="color:#71717a;font-size:13px">{v}<br>{o}</p>
<p style="color:#a1a1aa;font-size:12px;word-break:break-all">{l}</p></div>"#,
        h = esc(&hello),
        i = esc(&intro),
        l = esc(link),
        b = esc(button),
        v = esc(validity),
        o = esc(&outro),
    );
    (subject, text, html)
}

// ---------- super admin setup page ----------

#[derive(Serialize)]
pub struct SettingsView {
    #[serde(flatten)]
    settings: SmtpSettings,
    has_password: bool,
    default_public_url: String,
}

pub async fn get_settings(State(state): State<AppState>, _a: SuperAdmin) -> AppResult<Json<SettingsView>> {
    let mut s = load(&state).await?;
    let has_password = !s.password.is_empty();
    s.password = String::new(); // never sent back to the browser
    Ok(Json(SettingsView { settings: s, has_password, default_public_url: state.origins.first().cloned().unwrap_or_default() }))
}

#[derive(Deserialize)]
pub struct SaveSettings {
    enabled: bool,
    host: String,
    port: u16,
    security: String,
    username: String,
    /// None = keep the stored password
    password: Option<String>,
    from_email: String,
    from_name: String,
    public_url: String,
}

pub async fn save_settings(
    State(state): State<AppState>,
    SuperAdmin(me): SuperAdmin,
    crate::audit::ClientIp(ip): crate::audit::ClientIp,
    Json(r): Json<SaveSettings>,
) -> AppResult<Json<serde_json::Value>> {
    if !["starttls", "tls", "none"].contains(&r.security.as_str()) {
        return Err(AppError::BadRequest("invalid_security"));
    }
    if r.enabled && (r.host.trim().is_empty() || crate::auth::normalize_email(Some(r.from_email.clone()))?.flatten().is_none()) {
        return Err(AppError::BadRequest("smtp_incomplete"));
    }
    let old = load(&state).await?;
    let s = SmtpSettings {
        enabled: r.enabled,
        host: r.host.trim().into(),
        port: r.port,
        security: r.security,
        username: r.username.trim().into(),
        password: r.password.unwrap_or_else(|| old.password.clone()),
        from_email: r.from_email.trim().into(),
        from_name: r.from_name.trim().into(),
        public_url: r.public_url.trim().trim_end_matches('/').into(),
    };
    sqlx::query(
        "INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(KEY)
    .bind(serde_json::to_value(SmtpSettings { password: crate::crypto::seal(&s.password), ..s.clone() }).map_err(|e| anyhow::anyhow!(e))?)
    .execute(&state.db)
    .await?;
    // which fields changed, never their values (the password is compared in plain text here and not stored)
    let fields = crate::audit::changed_fields(
        &serde_json::to_value(&old).unwrap_or_default(),
        &serde_json::to_value(&s).unwrap_or_default(),
    );
    crate::audit::log(&state, Some(me.id), "settings_changed", None, ip.as_deref(), json!({ "area": "email", "fields": fields })).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct TestReq {
    to: String,
}

/// Sends a test email with the saved settings; returns the SMTP error text so the admin can fix it.
pub async fn test(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, Json(r): Json<TestReq>) -> AppResult<Json<serde_json::Value>> {
    let s = load(&state).await?;
    if s.host.trim().is_empty() || s.from_email.trim().is_empty() {
        return Err(AppError::BadRequest("smtp_incomplete"));
    }
    let to = crate::auth::normalize_email(Some(r.to))?.flatten().ok_or(AppError::BadRequest("invalid_email"))?;
    let url = base_url(&state, &s);
    let (subject, text, html) = if me.locale == "th" {
        ("ทดสอบอีเมลจาก Kanb".to_string(), format!("การตั้งค่าอีเมลใช้งานได้ ✓\n{url}"), format!("<p>การตั้งค่าอีเมลใช้งานได้ ✓</p><p>{}</p>", esc(&url)))
    } else {
        ("Kanb test email".to_string(), format!("Your email settings work ✓\n{url}"), format!("<p>Your email settings work ✓</p><p>{}</p>", esc(&url)))
    };
    match send(&s, &to, &me.display_name, &subject, text, html).await {
        Ok(()) => Ok(Json(json!({ "ok": true }))),
        Err(e) => Ok(Json(json!({ "ok": false, "error": e }))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_display_name_makes_a_valid_mailbox() {
        for name in ["Kanb (Jadepat)", "Doe, John", "Somchai \"Sales\" <x>", "สมชาย ใจดี", "a@b", ""] {
            let m = mailbox(name, " someone@example.com ").unwrap_or_else(|e| panic!("{name:?}: {e}"));
            assert_eq!(m.email.to_string(), "someone@example.com");
            assert_eq!(m.name.as_deref().unwrap_or(""), name);
        }
        assert!(mailbox("Kanb", "not an address").is_err());
    }

    #[test]
    fn a_display_name_cannot_add_headers() {
        let to = mailbox("Eve\r\nBcc: victim@example.com", "eve@example.com").unwrap();
        let msg = Message::builder().from(mailbox("Kanb", "noreply@example.com").unwrap()).to(to).subject("hi").body(String::from("x")).unwrap();
        let raw = String::from_utf8(msg.formatted()).unwrap();
        assert!(!raw.contains("\r\nBcc:"), "{raw}");
    }

    #[test]
    fn fresh_install_defaults_can_be_saved() {
        // a server without stored settings must offer values the save endpoint accepts
        let s = SmtpSettings::default();
        assert_eq!(s.port, 587);
        assert_eq!(s.security, "starttls");
        assert!(!s.enabled);
    }
}
