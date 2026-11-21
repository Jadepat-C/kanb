//! Notifications: assigned, @mentioned, comments on your cards, due-date reminders.
//! Shown in-app (bell + live push) and, if the person wants it and SMTP is set up, emailed.

use std::collections::HashSet;

use axum::{
    Json,
    extract::{Query, State},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{AppState, auth::CurrentUser, error::AppResult};

/// Usernames written as @name (letters, digits, . _ -), lowercased.
pub fn mentions(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let chars: Vec<char> = text.chars().collect();
    for i in 0..chars.len() {
        // "@" at the start or after a non-word character (so emails like a@b.com don't count)
        if chars[i] == '@' && (i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '.' || chars[i - 1] == '_')) {
            let name: String = chars[i + 1..].iter().take_while(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-')).collect();
            let name = name.trim_end_matches(['.', '-']).to_lowercase();
            if name.chars().count() >= 2 {
                out.insert(name);
            }
        }
    }
    out
}

/// Board members whose username is in `names` (never the actor).
pub async fn members_by_username(state: &AppState, board_id: Uuid, names: &HashSet<String>, actor: Uuid) -> AppResult<Vec<Uuid>> {
    if names.is_empty() {
        return Ok(vec![]);
    }
    let names: Vec<String> = names.iter().cloned().collect();
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT u.id FROM board_members m JOIN users u ON u.id = m.user_id
         WHERE m.board_id = $1 AND lower(u.username) = ANY($2) AND u.id <> $3 AND u.is_active",
    )
    .bind(board_id)
    .bind(&names)
    .bind(actor)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

/// Creates one notification per recipient (skipping the actor and non-members), pushes it live and
/// emails it in the background. Failures here never fail the action that caused them.
pub async fn send(state: &AppState, recipients: &[Uuid], kind: &str, board_id: Uuid, card_id: Option<Uuid>, actor: Option<Uuid>, data: Value) {
    let mut seen = HashSet::new();
    for &uid in recipients {
        if Some(uid) == actor || !seen.insert(uid) {
            continue;
        }
        let res: Result<Option<(i64,)>, sqlx::Error> = sqlx::query_as(
            "INSERT INTO notifications (user_id, kind, board_id, card_id, actor_id, data)
             SELECT $1, $2, $3, $4, $5, $6
             WHERE EXISTS (SELECT 1 FROM board_members WHERE board_id = $3 AND user_id = $1)
             RETURNING id",
        )
        .bind(uid)
        .bind(kind)
        .bind(board_id)
        .bind(card_id)
        .bind(actor)
        .bind(&data)
        .fetch_optional(&state.db)
        .await;
        match res {
            Ok(Some((id,))) => delivered(state, uid, id),
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e, "creating notification failed"),
        }
    }
}

/// Live push + (background) email and contact points for a stored notification.
fn delivered(state: &AppState, user_id: Uuid, id: i64) {
    state.hub.notify_user(user_id);
    let st = state.clone();
    tokio::spawn(async move {
        let msg = match render(&st, id).await {
            Ok(Some(m)) => m,
            Ok(None) => return,
            Err(e) => return tracing::warn!(error = %e, notification = id, "rendering notification failed"),
        };
        if let Err(e) = email(&st, &msg).await {
            tracing::warn!(error = %e, notification = id, "notification email failed");
        }
        crate::contacts::deliver(&st, &msg).await;
    });
}

#[derive(sqlx::FromRow)]
struct Row {
    user_id: Uuid,
    kind: String,
    data: Value,
    email: Option<String>,
    notify_email: bool,
    locale: String,
    name: String,
    actor: Option<String>,
    board_id: Uuid,
    board_name: String,
    card_id: Option<Uuid>,
    card_number: Option<i32>,
    card_title: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
}

/// One notification, worded for its recipient (their language), ready for email / chat / push.
pub struct Message {
    pub user_id: Uuid,
    pub kind: String,
    pub th: bool,
    pub to_email: Option<String>,
    pub to_name: String,
    pub actor: Option<String>,
    /// short headline, e.g. "Ann mentioned you in #12 Fix login"
    pub subject: String,
    /// full sentence including the board
    pub line: String,
    pub snippet: String,
    pub link: String,
    pub open_label: &'static str,
    pub board_id: Uuid,
    pub board_name: String,
    pub card_id: Option<Uuid>,
    pub card_number: Option<i32>,
    pub card_title: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// board channels: the individual changes ("Moved: To Do → Doing")
    pub changes: Vec<String>,
    /// "user" (personal notification) or "board" (board channel)
    pub scope: &'static str,
}

pub async fn base_url(state: &AppState) -> String {
    match crate::mail::load(state).await {
        Ok(s) => crate::mail::base_url(state, &s),
        Err(_) => crate::mail::base_url(state, &Default::default()),
    }
}

async fn render(state: &AppState, id: i64) -> Result<Option<Message>, String> {
    let r: Row = sqlx::query_as(sqlf!(
        "SELECT n.user_id, n.kind, n.data, u.email, u.notify_email, u.locale, u.display_name AS name,
                (SELECT {dn} FROM users u WHERE u.id = n.actor_id) AS actor,
                n.board_id, b.name AS board_name, n.card_id, c.number AS card_number, c.title AS card_title, n.created_at
         FROM notifications n JOIN users u ON u.id = n.user_id JOIN boards b ON b.id = n.board_id
         LEFT JOIN cards c ON c.id = n.card_id WHERE n.id = $1",
        dn = crate::auth::DISPLAY_NAME_SQL
    ))
    .bind(id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let th = r.locale == "th";
    let actor = r.actor.clone().unwrap_or_else(|| "Kanban".into());
    let card = match (r.card_number, &r.card_title) {
        (Some(n), Some(t)) => format!("#{n} {t}"),
        _ => String::new(),
    };
    let (subject, line) = match (r.kind.as_str(), th) {
        ("assigned", false) => (format!("{actor} assigned you: {card}"), format!("{actor} assigned you to {card} on {}.", r.board_name)),
        ("assigned", true) => (format!("{actor} มอบหมายงานให้คุณ: {card}"), format!("{actor} มอบหมาย {card} ในบอร์ด {} ให้คุณ", r.board_name)),
        ("mentioned", false) => (format!("{actor} mentioned you in {card}"), format!("{actor} mentioned you in {card} on {}.", r.board_name)),
        ("mentioned", true) => (format!("{actor} กล่าวถึงคุณใน {card}"), format!("{actor} กล่าวถึงคุณใน {card} (บอร์ด {})", r.board_name)),
        ("commented", false) => (format!("{actor} commented on {card}"), format!("{actor} commented on {card} on {}.", r.board_name)),
        ("commented", true) => (format!("{actor} แสดงความคิดเห็นใน {card}"), format!("{actor} แสดงความคิดเห็นใน {card} (บอร์ด {})", r.board_name)),
        ("due_soon", false) => (format!("Due soon: {card}"), format!("{card} on {} is due within 24 hours.", r.board_name)),
        ("due_soon", true) => (format!("ใกล้ครบกำหนด: {card}"), format!("{card} (บอร์ด {}) จะครบกำหนดภายใน 24 ชั่วโมง", r.board_name)),
        ("overdue", false) => (format!("Overdue: {card}"), format!("{card} on {} is past its due date.", r.board_name)),
        ("overdue", true) => (format!("เลยกำหนด: {card}"), format!("{card} (บอร์ด {}) เลยกำหนดส่งแล้ว", r.board_name)),
        _ => return Ok(None),
    };
    let base = base_url(state).await;
    let link = match r.card_id {
        Some(c) => format!("{base}/b/{}?card={c}", r.board_id),
        None => format!("{base}/b/{}", r.board_id),
    };
    Ok(Some(Message {
        user_id: r.user_id,
        kind: r.kind,
        th,
        to_email: r.email.filter(|_| r.notify_email),
        to_name: r.name,
        actor: r.actor,
        subject,
        line,
        snippet: r.data.get("snippet").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        link,
        open_label: if th { "เปิดการ์ด" } else { "Open the card" },
        board_id: r.board_id,
        board_name: r.board_name,
        card_id: r.card_id,
        card_number: r.card_number,
        card_title: r.card_title,
        created_at: r.created_at,
        changes: Vec::new(),
        scope: "user",
    }))
}

async fn email(state: &AppState, m: &Message) -> Result<(), String> {
    // the system switch (Admin → Notifications) comes first, then the user's own Profile switch
    if !crate::contacts::system(state).await.email {
        return Ok(());
    }
    let s = crate::mail::load(state).await.map_err(|e| e.to_string())?;
    if !crate::mail::ready(&s) {
        return Ok(());
    }
    let Some(to) = m.to_email.as_deref() else { return Ok(()) };
    let off = if m.th { "ปิดการแจ้งเตือนทางอีเมลได้ที่หน้าโปรไฟล์" } else { "You can turn off email notifications on your Profile page." };
    let hello = if m.th { format!("สวัสดีคุณ {}", m.to_name) } else { format!("Hello {},", m.to_name) };
    let quote_txt = if m.snippet.is_empty() { String::new() } else { format!("\n\n> {}", m.snippet) };
    let text = format!("{hello}\n\n{}{quote_txt}\n\n{}: {}\n\n{off}\n", m.line, m.open_label, m.link);
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    let quote_html = if m.snippet.is_empty() {
        String::new()
    } else {
        format!(r#"<blockquote style="border-left:3px solid #c7d2fe;margin:12px 0;padding:4px 12px;color:#52525b">{}</blockquote>"#, esc(&m.snippet))
    };
    let html = format!(
        r#"<div style="font-family:system-ui,'IBM Plex Sans Thai',sans-serif;max-width:520px;margin:auto;color:#18181b;line-height:1.6">
<p>{}</p><p>{}</p>{quote_html}
<p style="margin:20px 0"><a href="{}" style="background:#4f46e5;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600">{}</a></p>
<p style="color:#a1a1aa;font-size:12px">{off}</p></div>"#,
        esc(&hello),
        esc(&m.line),
        esc(&m.link),
        m.open_label
    );
    crate::mail::send(&s, to, &m.to_name, &m.subject, text, html).await
}

/// First ~140 characters of a comment/description, on one line.
pub fn snippet(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > 140 { format!("{}…", one.chars().take(140).collect::<String>()) } else { one }
}

// ---------- API ----------

#[derive(Serialize, sqlx::FromRow)]
pub struct Item {
    id: i64,
    kind: String,
    board_id: Uuid,
    board_name: String,
    card_id: Option<Uuid>,
    card_number: Option<i32>,
    card_title: Option<String>,
    actor_name: Option<String>,
    actor_color: Option<String>,
    actor_avatar: Option<Uuid>,
    data: Value,
    created_at: DateTime<Utc>,
    read_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    unread_only: bool,
}

pub async fn list(State(state): State<AppState>, CurrentUser(u): CurrentUser, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    let items: Vec<Item> = sqlx::query_as(sqlf!(
        "SELECT n.id, n.kind, n.board_id, b.name AS board_name, n.card_id, c.number AS card_number, c.title AS card_title,
                {dn} AS actor_name, u.avatar_color AS actor_color, u.avatar_id AS actor_avatar, n.data, n.created_at, n.read_at
         FROM notifications n JOIN boards b ON b.id = n.board_id
         LEFT JOIN cards c ON c.id = n.card_id LEFT JOIN users u ON u.id = n.actor_id
         WHERE n.user_id = $1 AND ($2 = false OR n.read_at IS NULL)
         ORDER BY n.id DESC LIMIT 50",
        dn = crate::auth::DISPLAY_NAME_SQL
    ))
    .bind(u.id)
    .bind(q.unread_only)
    .fetch_all(&state.db)
    .await?;
    let (unread,): (i64,) = sqlx::query_as("SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL")
        .bind(u.id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(json!({ "items": items, "unread": unread })))
}

#[derive(Deserialize)]
pub struct ReadReq {
    #[serde(default)]
    ids: Vec<i64>,
    #[serde(default)]
    all: bool,
    /// mark everything about this card read (opening a card counts as reading its notifications)
    card_id: Option<Uuid>,
}

pub async fn mark_read(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<ReadReq>) -> AppResult<Json<Value>> {
    let res = sqlx::query(
        "UPDATE notifications SET read_at = now()
         WHERE user_id = $1 AND read_at IS NULL AND ($2 OR id = ANY($3) OR ($4::uuid IS NOT NULL AND card_id = $4))",
    )
    .bind(u.id)
    .bind(r.all)
    .bind(&r.ids)
    .bind(r.card_id)
    .execute(&state.db)
    .await?;
    if res.rows_affected() > 0 {
        state.hub.notify_user(u.id);
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------- due-date reminders ----------

/// Every 10 minutes: "due within 24 h" and "overdue" (each sent once per card, person and due date).
/// Overdue reminders only cover the last 7 days, so old forgotten cards don't flood anyone.
pub fn spawn_due_job(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(600));
        loop {
            tick.tick().await;
            for (kind, window) in [
                ("due_soon", "c.due_at > now() AND c.due_at <= now() + interval '24 hours'"),
                ("overdue", "c.due_at <= now() AND c.due_at > now() - interval '7 days'"),
            ] {
                let rows: Result<Vec<(i64, Uuid)>, sqlx::Error> = sqlx::query_as(sqlf!(
                    "INSERT INTO notifications (user_id, kind, board_id, card_id, data)
                     SELECT a.user_id, '{kind}', c.board_id, c.id, jsonb_build_object('due_at', c.due_at)
                     FROM cards c
                     JOIN card_assignees a ON a.card_id = c.id
                     JOIN lists l ON l.id = c.list_id
                     JOIN boards b ON b.id = c.board_id
                     JOIN users u ON u.id = a.user_id AND u.is_active
                     WHERE {window} AND c.archived_at IS NULL AND l.archived_at IS NULL AND b.archived_at IS NULL
                     ON CONFLICT (user_id, card_id, kind, (data->>'due_at')) WHERE kind IN ('due_soon', 'overdue') DO NOTHING
                     RETURNING id, user_id"
                ))
                .fetch_all(&state.db)
                .await;
                match rows {
                    Ok(rows) => {
                        for (id, uid) in rows {
                            delivered(&state, uid, id);
                        }
                    }
                    Err(e) => tracing::warn!(error = %e, kind, "due reminder job failed"),
                }
            }
            crate::board_contacts::due_pass(&state).await;
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_mentions() {
        let m = super::mentions("hi @Somchai and @nok_2, mail me@example.com, @a, (@bob.smith). @ใจดี");
        assert!(m.contains("somchai") && m.contains("nok_2") && m.contains("bob.smith") && m.contains("ใจดี"));
        assert!(!m.contains("example.com") && !m.contains("a"));
    }
}
