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

/// Everything a person can choose to be notified about (Profile → Notifications), in display order.
/// The first five are on for everyone by default; the card-activity ones start off.
pub const KINDS: [&str; 11] =
    ["assigned", "mentioned", "commented", "due_soon", "overdue", "card_created", "card_moved", "status", "card_updated", "attachments", "archived"];

/// Due-soon reminder of a card when it doesn't set one: 1 day before.
pub const DEFAULT_REMIND_MINUTES: i32 = 1440;

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
               AND EXISTS (SELECT 1 FROM users WHERE id = $1 AND $2 = ANY(notify_events))
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
            crate::metrics::delivery("email", false);
        }
        crate::contacts::deliver(&st, &msg).await;
        crate::push::deliver(&st, &msg).await;
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
    board_id: Option<Uuid>,
    board_name: Option<String>,
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
         FROM notifications n JOIN users u ON u.id = n.user_id LEFT JOIN boards b ON b.id = n.board_id
         LEFT JOIN cards c ON c.id = n.card_id WHERE n.id = $1",
        dn = crate::auth::DISPLAY_NAME_SQL
    ))
    .bind(id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    let th = r.locale == "th";
    let actor = r.actor.clone().unwrap_or_else(|| "Kanb".into());
    let card = match (r.card_number, &r.card_title) {
        (Some(n), Some(t)) => format!("#{n} {t}"),
        _ => String::new(),
    };
    let due = r
        .data
        .get("due_at")
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<DateTime<Utc>>().ok())
        .map(|d| crate::board_contacts::fmt_date(th, d))
        .unwrap_or_default();
    let to = r.data.get("to").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let restored = r.data.get("restored").and_then(|v| v.as_bool()).unwrap_or(false);
    let board_name = r.board_name.clone().unwrap_or_else(|| "Kanb".into());
    let count = r.data.get("count").and_then(|v| v.as_i64()).unwrap_or(1);
    let names = r.data.get("names").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let (subject, line) = match (r.kind.as_str(), th) {
        ("signup", false) => (
            if count == 1 { "1 sign-up is waiting for approval".to_string() } else { format!("{count} sign-ups are waiting for approval") },
            format!("Newest: {names}. Approve or reject them in Admin → Users."),
        ),
        ("signup", true) => (format!("มีผู้สมัคร {count} คนรอการอนุมัติ"), format!("ล่าสุด: {names} อนุมัติหรือปฏิเสธได้ที่ ผู้ดูแลระบบ → ผู้ใช้")),
        ("assigned", false) => (format!("{actor} assigned you: {card}"), format!("{actor} assigned you to {card} on {}.", board_name)),
        ("assigned", true) => (format!("{actor} มอบหมายงานให้คุณ: {card}"), format!("{actor} มอบหมาย {card} ในบอร์ด {} ให้คุณ", board_name)),
        ("mentioned", false) => (format!("{actor} mentioned you in {card}"), format!("{actor} mentioned you in {card} on {}.", board_name)),
        ("mentioned", true) => (format!("{actor} กล่าวถึงคุณใน {card}"), format!("{actor} กล่าวถึงคุณใน {card} (บอร์ด {})", board_name)),
        ("commented", false) => (format!("{actor} commented on {card}"), format!("{actor} commented on {card} on {}.", board_name)),
        ("commented", true) => (format!("{actor} แสดงความคิดเห็นใน {card}"), format!("{actor} แสดงความคิดเห็นใน {card} (บอร์ด {})", board_name)),
        ("due_soon", false) => (format!("Due soon: {card}"), format!("{card} on {} is due {due}.", board_name)),
        ("due_soon", true) => (format!("ใกล้ครบกำหนด: {card}"), format!("{card} (บอร์ด {}) จะครบกำหนด {due}", board_name)),
        ("overdue", false) => (format!("Overdue: {card}"), format!("{card} on {} is past its due date.", board_name)),
        ("overdue", true) => (format!("เลยกำหนด: {card}"), format!("{card} (บอร์ด {}) เลยกำหนดส่งแล้ว", board_name)),
        ("card_created", false) => (format!("{actor} created {card}"), format!("{actor} created {card} on {}.", board_name)),
        ("card_created", true) => (format!("{actor} สร้าง {card}"), format!("{actor} สร้าง {card} ในบอร์ด {}", board_name)),
        ("card_moved", false) => (format!("{actor} moved {card} to {to}"), format!("{actor} moved {card} on {} to {to}.", board_name)),
        ("card_moved", true) => (format!("{actor} ย้าย {card} ไปที่ {to}"), format!("{actor} ย้าย {card} (บอร์ด {}) ไปที่ {to}", board_name)),
        ("status", false) => (format!("{actor} changed the status of {card}"), format!("{actor} changed the status of {card} on {}.", board_name)),
        ("status", true) => (format!("{actor} เปลี่ยนสถานะของ {card}"), format!("{actor} เปลี่ยนสถานะของ {card} (บอร์ด {})", board_name)),
        ("card_updated", false) => (format!("{actor} updated {card}"), format!("{actor} updated {card} on {}.", board_name)),
        ("card_updated", true) => (format!("{actor} อัปเดต {card}"), format!("{actor} อัปเดต {card} (บอร์ด {})", board_name)),
        ("attachments", false) => (format!("{actor} changed attachments on {card}"), format!("{actor} changed the attachments of {card} on {}.", board_name)),
        ("attachments", true) => (format!("{actor} เปลี่ยนไฟล์แนบใน {card}"), format!("{actor} เปลี่ยนไฟล์แนบใน {card} (บอร์ด {})", board_name)),
        ("archived", false) if restored => (format!("{actor} restored {card}"), format!("{actor} restored {card} on {} from the archive.", board_name)),
        ("archived", true) if restored => (format!("{actor} กู้คืน {card}"), format!("{actor} กู้คืน {card} (บอร์ด {}) จากที่เก็บ", board_name)),
        ("archived", false) => (format!("{actor} archived {card}"), format!("{actor} archived {card} on {}.", board_name)),
        ("archived", true) => (format!("{actor} เก็บ {card} เข้าที่เก็บ"), format!("{actor} เก็บ {card} (บอร์ด {}) เข้าที่เก็บ", board_name)),
        _ => return Ok(None),
    };
    // card activity: the individual changes, in the recipient's language
    let changes = r.data.pointer(if th { "/changes/th" } else { "/changes/en" }).and_then(|v| v.as_array()).map(|a| {
        a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" · ")
    });
    let base = base_url(state).await;
    let link = match (r.kind.as_str(), r.board_id, r.card_id) {
        ("signup", ..) => format!("{base}/admin?tab=users"),
        (_, Some(b), Some(c)) => format!("{base}/b/{b}?card={c}"),
        (_, Some(b), None) => format!("{base}/b/{b}"),
        _ => base.clone(),
    };
    let open_label = match (r.kind.as_str(), th) {
        ("signup", true) => "ดูผู้สมัคร",
        ("signup", false) => "Review sign-ups",
        (_, true) => "เปิดการ์ด",
        _ => "Open the card",
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
        snippet: changes.unwrap_or_else(|| r.data.get("snippet").and_then(|v| v.as_str()).unwrap_or("").to_string()),
        link,
        open_label,
        board_id: r.board_id.unwrap_or(Uuid::nil()),
        board_name,
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
        r#"<div style="font-family:system-ui,'Anuphan',sans-serif;max-width:520px;margin:auto;color:#18181b;line-height:1.6">
<p>{}</p><p>{}</p>{quote_html}
<p style="margin:20px 0"><a href="{}" style="background:#2f5bd3;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600">{}</a></p>
<p style="color:#a1a1aa;font-size:12px">{off}</p></div>"#,
        esc(&hello),
        esc(&m.line),
        esc(&m.link),
        m.open_label
    );
    let res = crate::mail::send(&s, to, &m.to_name, &m.subject, text, html).await;
    if res.is_ok() {
        crate::metrics::delivery("email", true);
    }
    res
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
    board_id: Option<Uuid>,
    board_name: Option<String>,
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
         FROM notifications n LEFT JOIN boards b ON b.id = n.board_id
         LEFT JOIN cards c ON c.id = n.card_id LEFT JOIN users u ON u.id = n.actor_id
         WHERE n.user_id = $1 AND n.cleared_at IS NULL AND ($2 = false OR n.read_at IS NULL)
         ORDER BY n.id DESC LIMIT 50",
        dn = crate::auth::DISPLAY_NAME_SQL
    ))
    .bind(u.id)
    .bind(q.unread_only)
    .fetch_all(&state.db)
    .await?;
    let (unread,): (i64,) = sqlx::query_as("SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL AND cleared_at IS NULL")
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

#[derive(Deserialize)]
pub struct ClearReq {
    #[serde(default)]
    ids: Vec<i64>,
    #[serde(default)]
    all: bool,
}

/// "Clear" in the bell: hides notifications (and marks them read). They aren't deleted, so a due reminder that was
/// cleared isn't sent again.
pub async fn clear(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<ClearReq>) -> AppResult<Json<Value>> {
    let res = sqlx::query(
        "UPDATE notifications SET cleared_at = now(), read_at = COALESCE(read_at, now())
         WHERE user_id = $1 AND cleared_at IS NULL AND ($2 OR id = ANY($3))",
    )
    .bind(u.id)
    .bind(r.all)
    .bind(&r.ids)
    .execute(&state.db)
    .await?;
    if res.rows_affected() > 0 {
        state.hub.notify_user(u.id);
    }
    Ok(Json(json!({ "cleared": res.rows_affected() })))
}

// ---------- sign-ups waiting for approval (super admins) ----------

/// Keeps each super admin's "sign-ups waiting" notification current, as one bundled notification however many
/// people sign up: `new` = someone just joined the queue (the bundle moves to the top as unread and lists the newest
/// names); otherwise (approved / rejected) the count is updated in place, and the bundle leaves the bell once nothing
/// is waiting. There is never more than one in the bell.
/// Email, push and chat go out at most once an hour per admin; the bell always updates.
pub async fn signups_changed(state: &AppState, new: bool) {
    if let Err(e) = signups_inner(state, new).await {
        tracing::warn!(error = %e, "sign-up notification failed");
    }
}

async fn signups_inner(state: &AppState, new: bool) -> anyhow::Result<()> {
    let mut tx = state.db.begin().await?;
    // one at a time, so two sign-ups at the same moment don't make two bundles
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('kanb-signup-notify'))").execute(&mut *tx).await?;
    let (count, names): (i64, Vec<String>) = sqlx::query_as(
        "SELECT count(*), COALESCE((SELECT array_agg(n) FROM (SELECT display_name || ' (@' || username || ')' AS n FROM users
                  WHERE signup = 'review' AND deleted_at IS NULL ORDER BY signed_up_at DESC LIMIT 5) x), '{}')
         FROM users WHERE signup = 'review' AND deleted_at IS NULL",
    )
    .fetch_one(&mut *tx)
    .await?;
    let admins: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE is_super_admin AND is_active AND deleted_at IS NULL AND signup IS NULL")
        .fetch_all(&mut *tx)
        .await?;
    let data = json!({ "count": count, "names": names });
    let mut deliver = Vec::new();
    for (uid,) in &admins {
        if count == 0 {
            sqlx::query(
                "UPDATE notifications SET read_at = COALESCE(read_at, now()), cleared_at = now()
                 WHERE user_id = $1 AND kind = 'signup' AND cleared_at IS NULL",
            )
            .bind(uid)
            .execute(&mut *tx)
            .await?;
            continue;
        }
        if !new {
            sqlx::query("UPDATE notifications SET data = data || $2 WHERE user_id = $1 AND kind = 'signup' AND cleared_at IS NULL")
                .bind(uid)
                .bind(&data)
                .execute(&mut *tx)
                .await?;
            continue;
        }
        sqlx::query(
            "UPDATE notifications SET read_at = COALESCE(read_at, now()), cleared_at = now()
             WHERE user_id = $1 AND kind = 'signup' AND cleared_at IS NULL",
        )
            .bind(uid)
            .execute(&mut *tx)
            .await?;
        let (recent,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'signup' AND (data->>'sent')::boolean
                             AND created_at > now() - interval '1 hour')",
        )
        .bind(uid)
        .fetch_one(&mut *tx)
        .await?;
        let mut d = data.clone();
        d["sent"] = (!recent).into();
        let (id,): (i64,) = sqlx::query_as("INSERT INTO notifications (user_id, kind, data) VALUES ($1, 'signup', $2) RETURNING id")
            .bind(uid)
            .bind(&d)
            .fetch_one(&mut *tx)
            .await?;
        deliver.push((*uid, id, !recent));
    }
    tx.commit().await?;
    for (uid,) in &admins {
        state.hub.notify_user(*uid);
    }
    for (uid, id, send) in deliver {
        if send {
            delivered(state, uid, id);
        }
    }
    Ok(())
}

// ---------- due-date reminders ----------

/// Cards whose "due soon" reminder is due: within the card's reminder time (default 1 day) of the due date.
/// Use with the cards table aliased as `c`.
/// An imported card is only reminded about times after it arrived (its old due dates are history).
pub fn due_soon_sql() -> String {
    format!(
        "c.due_at > now() AND COALESCE(c.remind_minutes, {d}) > 0 AND c.due_at <= now() + make_interval(mins => COALESCE(c.remind_minutes, {d}))
         AND (c.imported_at IS NULL OR c.due_at - make_interval(mins => COALESCE(c.remind_minutes, {d})) > c.imported_at)",
        d = DEFAULT_REMIND_MINUTES
    )
}

/// Cards that became overdue in the last 7 days (and, if imported, after they arrived).
pub const OVERDUE_SQL: &str = "c.due_at <= now() AND c.due_at > now() - interval '7 days' AND (c.imported_at IS NULL OR c.due_at > c.imported_at)";

/// Every 10 minutes: "due soon" (the card's reminder time before the due date) and "overdue" (each sent once per
/// card, person, due date and reminder time). Overdue reminders only cover the last 7 days, so old forgotten cards
/// don't flood anyone.
pub fn spawn_due_job(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(600));
        loop {
            tick.tick().await;
            let soon = due_soon_sql();
            for (kind, window, data) in [
                (
                    "due_soon",
                    soon.as_str(),
                    format!("jsonb_build_object('due_at', c.due_at, 'remind', COALESCE(c.remind_minutes, {DEFAULT_REMIND_MINUTES}))"),
                ),
                ("overdue", OVERDUE_SQL, "jsonb_build_object('due_at', c.due_at)".to_string()),
            ] {
                let rows: Result<Vec<(i64, Uuid)>, sqlx::Error> = sqlx::query_as(sqlf!(
                    // the assignees; a card nobody is assigned to reminds whoever created it (still on the board)
                    "INSERT INTO notifications (user_id, kind, board_id, card_id, data)
                     SELECT r.user_id, '{kind}', c.board_id, c.id, {data}
                     FROM cards c
                     CROSS JOIN LATERAL (
                         SELECT a.user_id FROM card_assignees a WHERE a.card_id = c.id
                         UNION ALL
                         SELECT c.created_by WHERE c.created_by IS NOT NULL
                           AND NOT EXISTS (SELECT 1 FROM card_assignees a WHERE a.card_id = c.id)
                           AND EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = c.board_id AND m.user_id = c.created_by)
                     ) r
                     JOIN lists l ON l.id = c.list_id
                     JOIN boards b ON b.id = c.board_id
                     JOIN users u ON u.id = r.user_id AND u.is_active AND '{kind}' = ANY(u.notify_events)
                     WHERE {window} AND c.archived_at IS NULL AND l.archived_at IS NULL AND b.archived_at IS NULL
                       AND NOT EXISTS (SELECT 1 FROM board_statuses s WHERE s.id = c.status_id AND s.is_done)
                     ON CONFLICT (user_id, card_id, kind, (data->>'due_at'), (COALESCE(data->>'remind', '1440')))
                         WHERE kind IN ('due_soon', 'overdue') DO NOTHING
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
                    Err(e) => {
                        tracing::warn!(error = %e, kind, "due reminder job failed");
                        crate::metrics::job_failed("due_reminders");
                    }
                }
            }
            crate::board_contacts::due_pass(&state).await;
        }
    });
}

// ---------- card activity (moved, status, edits, files, archive) ----------

#[derive(sqlx::FromRow)]
struct Act {
    id: i64,
    card_id: Uuid,
    board_id: Uuid,
    actor_id: Option<Uuid>,
    kind: String,
    data: Value,
    created_at: DateTime<Utc>,
}

/// When one bundle holds several kinds of change, the notification is named after the first one the person wants.
const ACTIVITY_ORDER: [&str; 6] = ["card_created", "card_moved", "status", "archived", "attachments", "card_updated"];

/// Every 5 s: card activity → personal notifications for people who chose those kinds (Profile → Notifications).
/// Who hears about a card: its assignees and whoever created it; "card created" goes to every board member who wants
/// it. A person's quick successive changes to one card are bundled into one notification.
pub fn spawn_activity(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tick.tick().await;
            if let Err(e) = activity(&state).await {
                tracing::warn!(error = %e, "card activity notifications failed");
                crate::metrics::job_failed("personal_activity");
            }
        }
    });
}

async fn activity(state: &AppState) -> anyhow::Result<()> {
    let (cursor,): (i64,) =
        sqlx::query_as("SELECT COALESCE((value->>'last')::bigint, 0) FROM app_settings WHERE key = 'personal_events_cursor'").fetch_one(&state.db).await?;
    // 8 s old: a burst of edits becomes one notification (and its transaction has surely committed)
    let evs: Vec<Act> = sqlx::query_as(
        "SELECT id, card_id, board_id, actor_id, kind, data, created_at FROM card_events
         WHERE id > $1 AND created_at < now() - interval '8 seconds' ORDER BY id LIMIT 1000",
    )
    .bind(cursor)
    .fetch_all(&state.db)
    .await?;
    let Some(last) = evs.last().map(|e| e.id) else { return Ok(()) };
    // claim the batch first: if two servers share the database, only one sends it
    let claimed = sqlx::query(
        "UPDATE app_settings SET value = jsonb_build_object('last', $2::bigint), updated_at = now()
         WHERE key = 'personal_events_cursor' AND COALESCE((value->>'last')::bigint, 0) = $1",
    )
    .bind(cursor)
    .bind(last)
    .execute(&state.db)
    .await?
    .rows_affected()
        == 1;
    if !claimed {
        return Ok(());
    }
    // assignee changes are already "assigned" notifications; old news after downtime isn't sent
    let cat = |e: &Act| crate::board_contacts::category(&e.kind).filter(|c| *c != "assigned");
    let fresh = evs.iter().filter(|e| e.created_at > Utc::now() - chrono::Duration::hours(1) && cat(e).is_some());
    let mut order: Vec<(Uuid, Option<Uuid>)> = Vec::new();
    let mut groups: std::collections::HashMap<(Uuid, Option<Uuid>), Vec<&Act>> = Default::default();
    for e in fresh {
        let k = (e.card_id, e.actor_id);
        if !groups.contains_key(&k) {
            order.push(k);
        }
        groups.entry(k).or_default().push(e);
    }
    for k in order {
        let evs = &groups[&k];
        let (card_id, actor) = k;
        let board_id = evs[0].board_id;
        let cats: Vec<String> = evs.iter().filter_map(|e| cat(e)).map(str::to_string).collect::<HashSet<_>>().into_iter().collect();
        let created = cats.iter().any(|c| c == "card_created");
        let people: Vec<(Uuid, Vec<String>)> = sqlx::query_as(
            "SELECT u.id, u.notify_events FROM users u
             WHERE u.is_active AND u.deleted_at IS NULL AND u.id IS DISTINCT FROM $3 AND u.notify_events && $4
               AND (u.id IN (SELECT user_id FROM card_assignees WHERE card_id = $1)
                    OR u.id = (SELECT created_by FROM cards WHERE id = $1)
                    OR ($5 AND u.id IN (SELECT user_id FROM board_members WHERE board_id = $2)))",
        )
        .bind(card_id)
        .bind(board_id)
        .bind(actor)
        .bind(&cats)
        .bind(created)
        .fetch_all(&state.db)
        .await?;
        for (uid, wants) in people {
            let mine: Vec<&&Act> = evs.iter().filter(|e| cat(e).is_some_and(|c| wants.iter().any(|w| w == c))).collect();
            let Some(kind) = ACTIVITY_ORDER.iter().find(|k| mine.iter().any(|e| cat(e) == Some(**k))) else { continue };
            let lines = |th: bool| -> Vec<String> {
                mine.iter().flat_map(|e| crate::board_contacts::phrase(th, &e.kind, &e.data)).take(10).collect()
            };
            let to = mine.iter().rev().find(|e| e.kind == "moved").and_then(|e| e.data.get("to")).cloned().unwrap_or(Value::Null);
            let restored = *kind == "archived" && mine.iter().rev().find(|e| matches!(e.kind.as_str(), "archived" | "restored")).is_some_and(|e| e.kind == "restored");
            let data = json!({ "changes": { "en": lines(false), "th": lines(true) }, "to": to, "restored": restored });
            send(state, &[uid], kind, board_id, Some(card_id), actor, data).await;
        }
    }
    Ok(())
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
