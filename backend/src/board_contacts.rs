//! Board channels: a board's activity posted to a shared Discord / Slack / Teams / … channel, so a team that already
//! lives in one chat server gets one feed instead of everyone wiring up personal notifications.
//! Managed in Board settings → Notifications (permission `notifications.manage`).
//!
//! Activity comes from `card_events` (an ordered log): a background sender reads it every few seconds and bundles a
//! person's quick successive changes on one card into a single post. Comments are posted right away, due/overdue
//! reminders by the due job.

use std::collections::{HashMap, HashSet};

use axum::{
    Json,
    extract::{Path, State},
};
use chrono::{DateTime, Datelike, Local, Utc};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::CurrentUser,
    contacts::{self, Row},
    error::{AppError, AppResult},
    notify::Message,
    perms::{self, board_access},
};

/// What a board channel can post, as shown in its settings.
pub const EVENTS: [&str; 9] = ["card_created", "card_moved", "status", "assigned", "commented", "due", "card_updated", "attachments", "archived"];

/// card_events.kind → channel event
pub(crate) fn category(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "created" | "duplicated" => "card_created",
        "moved" => "card_moved",
        "status" => "status",
        "assignees" => "assigned",
        "title" | "description" | "priority" | "color" | "due" | "start" | "labels" | "dependencies" => "card_updated",
        "attachment_added" | "attachment_removed" => "attachments",
        "archived" | "restored" => "archived",
        _ => return None,
    })
}

const TABLE: &str = "board_contact_points";

// ---------- settings API ----------

#[derive(sqlx::FromRow)]
struct BRow {
    #[sqlx(flatten)]
    base: Row,
    locale: String,
}

fn bview(r: &BRow) -> Value {
    let mut v = contacts::view(&r.base);
    v["locale"] = r.locale.clone().into();
    v
}

async fn manage(state: &AppState, u: &crate::auth::User, board_id: Uuid) -> AppResult<()> {
    board_access(&state.db, u, board_id).await?.require(perms::NOTIFICATIONS_MANAGE)
}

async fn load(state: &AppState, id: Uuid) -> AppResult<(Uuid, BRow)> {
    let (board_id,): (Uuid,) = sqlx::query_as("SELECT board_id FROM board_contact_points WHERE id = $1").bind(id).fetch_one(&state.db).await?;
    let r: BRow = sqlx::query_as(sqlf!("SELECT {cols}, locale FROM {TABLE} WHERE id = $1", cols = contacts::COLS)).bind(id).fetch_one(&state.db).await?;
    Ok((board_id, r))
}

pub async fn list(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(board_id): Path<Uuid>) -> AppResult<Json<Value>> {
    manage(&state, &u, board_id).await?;
    let rows: Vec<BRow> = sqlx::query_as(sqlf!("SELECT {cols}, locale FROM {TABLE} WHERE board_id = $1 ORDER BY created_at", cols = contacts::COLS))
        .bind(board_id)
        .fetch_all(&state.db)
        .await?;
    Ok(Json(json!({ "system": { "push": contacts::system(&state).await.push }, "items": rows.iter().map(bview).collect::<Vec<_>>() })))
}

#[derive(Deserialize)]
pub struct Req {
    kind: Option<String>,
    name: Option<String>,
    config: Option<Map<String, Value>>,
    events: Option<Vec<String>>,
    enabled: Option<bool>,
    locale: Option<String>,
    /// test only
    id: Option<Uuid>,
}

fn locale(l: Option<&str>) -> String {
    if l == Some("th") { "th".into() } else { "en".into() }
}

fn name_of(n: Option<String>) -> AppResult<String> {
    n.map(|s| s.trim().chars().take(80).collect::<String>()).filter(|s| !s.is_empty()).ok_or(AppError::BadRequest("name_required"))
}

pub async fn create(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(board_id): Path<Uuid>, Json(r): Json<Req>) -> AppResult<Json<Value>> {
    manage(&state, &u, board_id).await?;
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM board_contact_points WHERE board_id = $1").bind(board_id).fetch_one(&state.db).await?;
    if n >= 20 {
        return Err(AppError::BadRequest("too_many_contacts"));
    }
    let kind = r.kind.unwrap_or_default();
    let cfg = contacts::merge(&kind, &r.config.unwrap_or_default(), None)?;
    contacts::validate(&kind, &cfg).map_err(AppError::BadRequest)?;
    let row: BRow = sqlx::query_as(sqlf!(
        "INSERT INTO {TABLE} (id, board_id, kind, name, config, events, enabled, locale, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING {cols}, locale",
        cols = contacts::COLS
    ))
    .bind(Uuid::now_v7())
    .bind(board_id)
    .bind(&kind)
    .bind(name_of(r.name)?)
    .bind(Value::Object(contacts::seal_cfg(&kind, cfg)))
    .bind(contacts::clean_events(r.events, &EVENTS))
    .bind(r.enabled.unwrap_or(true))
    .bind(locale(r.locale.as_deref().or(Some(u.locale.as_str()))))
    .bind(u.id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(bview(&row)))
}

pub async fn update(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, Json(r): Json<Req>) -> AppResult<Json<Value>> {
    let (board_id, old) = load(&state, id).await?;
    manage(&state, &u, board_id).await?;
    let kind = r.kind.clone().unwrap_or_else(|| old.base.kind.clone());
    let cfg = match &r.config {
        Some(c) => contacts::merge(&kind, c, Some(&old.base))?,
        None if kind == old.base.kind => contacts::open_cfg(&kind, old.base.config.as_object().cloned().unwrap_or_default()),
        None => return Err(AppError::BadRequest("contact_field_required")),
    };
    contacts::validate(&kind, &cfg).map_err(AppError::BadRequest)?;
    let row: BRow = sqlx::query_as(sqlf!(
        "UPDATE {TABLE} SET kind = $2, name = $3, config = $4, events = $5, enabled = $6, locale = $7,
                last_error = CASE WHEN config = $4 THEN last_error END
         WHERE id = $1 RETURNING {cols}, locale",
        cols = contacts::COLS
    ))
    .bind(id)
    .bind(&kind)
    .bind(match r.name {
        Some(n) => name_of(Some(n))?,
        None => old.base.name.clone(),
    })
    .bind(Value::Object(contacts::seal_cfg(&kind, cfg)))
    .bind(match r.events {
        Some(e) => contacts::clean_events(Some(e), &EVENTS),
        None => old.base.events.clone(),
    })
    .bind(r.enabled.unwrap_or(old.base.enabled))
    .bind(locale(Some(r.locale.as_deref().unwrap_or(&old.locale))))
    .fetch_one(&state.db)
    .await?;
    Ok(Json(bview(&row)))
}

pub async fn delete(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let (board_id, _) = load(&state, id).await?;
    manage(&state, &u, board_id).await?;
    sqlx::query(sqlf!("DELETE FROM {TABLE} WHERE id = $1")).bind(id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn test(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(board_id): Path<Uuid>, Json(r): Json<Req>) -> AppResult<Json<Value>> {
    manage(&state, &u, board_id).await?;
    let sys = contacts::system(&state).await;
    if !sys.push {
        return Err(AppError::BadRequest("push_disabled"));
    }
    let saved = match r.id {
        Some(id) => {
            let (b, row) = load(&state, id).await?;
            if b != board_id {
                return Err(AppError::NotFound);
            }
            Some(row)
        }
        None => None,
    };
    let kind = r.kind.clone().or_else(|| saved.as_ref().map(|s| s.base.kind.clone())).unwrap_or_default();
    let cfg = match &r.config {
        Some(c) => contacts::merge(&kind, c, saved.as_ref().map(|s| &s.base))?,
        None => contacts::open_cfg(&kind, saved.as_ref().and_then(|s| s.base.config.as_object().cloned()).unwrap_or_default()),
    };
    contacts::validate(&kind, &cfg).map_err(AppError::BadRequest)?;
    let th = locale(r.locale.as_deref().or(saved.as_ref().map(|s| s.locale.as_str()))) == "th";
    let (board_name,): (String,) = sqlx::query_as("SELECT name FROM boards WHERE id = $1").bind(board_id).fetch_one(&state.db).await?;
    let base = crate::notify::base_url(&state).await;
    let mut m = message(&base, th, "test", board_id, &board_name, None, None);
    m.subject = if th { format!("ทดสอบช่องทางของบอร์ด {board_name}") } else { format!("Test from the board “{board_name}”") };
    m.line = if th {
        "ถ้าคุณเห็นข้อความนี้ กิจกรรมของบอร์ดจะถูกส่งมาที่นี่".into()
    } else {
        "If you can read this, the board’s activity will be posted here.".into()
    };
    let res = contacts::send(&state, &sys, &kind, &cfg, &m).await;
    if let Some(s) = &saved {
        contacts::record_in(&state, TABLE, s.base.id, &res).await;
    }
    Ok(Json(match res {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }))
}

// ---------- wording ----------

struct Card {
    id: Uuid,
    number: i32,
    title: String,
}

fn message(base: &str, th: bool, kind: &str, board_id: Uuid, board_name: &str, card: Option<&Card>, actor: Option<&str>) -> Message {
    Message {
        user_id: Uuid::nil(),
        kind: kind.into(),
        th,
        to_email: None,
        to_name: String::new(),
        actor: actor.map(str::to_string),
        subject: String::new(),
        line: String::new(),
        snippet: String::new(),
        link: match card {
            Some(c) => format!("{base}/b/{board_id}?card={}", c.id),
            None => format!("{base}/b/{board_id}"),
        },
        open_label: if th { "เปิดการ์ด" } else { "Open the card" },
        board_id,
        board_name: board_name.into(),
        card_id: card.map(|c| c.id),
        card_number: card.map(|c| c.number),
        card_title: card.map(|c| c.title.clone()),
        created_at: Utc::now(),
        changes: Vec::new(),
        scope: "board",
    }
}

/// dd/mm/yyyy HH:mm in server-local time (set TZ for the container, e.g. Asia/Bangkok). Thai uses the Buddhist year.
pub(crate) fn fmt_date(th: bool, d: DateTime<Utc>) -> String {
    let l = d.with_timezone(&Local);
    format!("{:02}/{:02}/{} {}", l.day(), l.month(), l.year() + if th { 543 } else { 0 }, l.format("%H:%M"))
}

fn stars(p: Option<i64>, th: bool) -> String {
    match p.unwrap_or(0) {
        n if n > 0 => "★".repeat(n as usize),
        _ => (if th { "ไม่มี" } else { "none" }).into(),
    }
}

/// One change as a short line, in the channel's language.
pub(crate) fn phrase(th: bool, kind: &str, d: &Value) -> Vec<String> {
    let s = |k: &str| d.get(k).and_then(|v| v.as_str()).unwrap_or("—").to_string();
    let list = |k: &str| d.get(k).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    let tr = |en: String, thai: String| if th { thai } else { en };
    match kind {
        "created" => vec![tr(format!("Created in {}", s("list")), format!("สร้างในคอลัมน์ {}", s("list")))],
        "duplicated" => {
            let n = d.get("from").map(|v| v.to_string()).unwrap_or_default();
            vec![tr(format!("Duplicated from #{n}"), format!("ทำสำเนาจาก #{n}"))]
        }
        "moved" => vec![tr(format!("Moved: {} → {}", s("from"), s("to")), format!("ย้าย: {} → {}", s("from"), s("to")))],
        "status" => vec![tr(format!("Status: {} → {}", s("from"), s("to")), format!("สถานะ: {} → {}", s("from"), s("to")))],
        "assignees" | "labels" => {
            let (add, rem) = (list("added"), list("removed"));
            let mut v = Vec::new();
            if kind == "assignees" {
                if !add.is_empty() {
                    v.push(tr(format!("Assigned: {add}"), format!("มอบหมาย: {add}")));
                }
                if !rem.is_empty() {
                    v.push(tr(format!("Unassigned: {rem}"), format!("ยกเลิกการมอบหมาย: {rem}")));
                }
            } else {
                let parts: Vec<String> = add.split(", ").filter(|x| !x.is_empty()).map(|x| format!("+{x}")).chain(rem.split(", ").filter(|x| !x.is_empty()).map(|x| format!("−{x}"))).collect();
                v.push(tr(format!("Labels: {}", parts.join(", ")), format!("ป้ายกำกับ: {}", parts.join(", "))));
            }
            v
        }
        "title" => vec![tr(format!("Renamed from “{}”", s("from")), format!("เปลี่ยนชื่อจาก “{}”", s("from")))],
        "description" => vec![tr("Description edited".into(), "แก้ไขรายละเอียด".into())],
        "priority" => {
            let (f, t) = (stars(d.get("from").and_then(|v| v.as_i64()), th), stars(d.get("to").and_then(|v| v.as_i64()), th));
            vec![tr(format!("Priority: {f} → {t}"), format!("ความสำคัญ: {f} → {t}"))]
        }
        "color" => vec![tr("Colour changed".into(), "เปลี่ยนสี".into())],
        "due" => match d.get("to").and_then(|v| v.as_str()).and_then(|v| v.parse::<DateTime<Utc>>().ok()) {
            Some(t) => vec![tr(format!("Due: {}", fmt_date(false, t)), format!("กำหนดส่ง: {}", fmt_date(true, t)))],
            None => vec![tr("Due date removed".into(), "ลบกำหนดส่ง".into())],
        },
        "start" => match d.get("to").and_then(|v| v.as_str()).and_then(|v| v.parse::<DateTime<Utc>>().ok()) {
            Some(t) => vec![tr(format!("Start: {}", fmt_date(false, t)), format!("เริ่ม: {}", fmt_date(true, t)))],
            None => vec![tr("Start date removed".into(), "ลบวันเริ่ม".into())],
        },
        "dependencies" => {
            let (add, rem) = (list("added"), list("removed"));
            let mut v = Vec::new();
            if !add.is_empty() {
                v.push(tr(format!("Now waits for: {add}"), format!("รอ: {add}")));
            }
            if !rem.is_empty() {
                v.push(tr(format!("No longer waits for: {rem}"), format!("ไม่ต้องรอ: {rem}")));
            }
            v
        }
        "archived" => vec![tr("Archived".into(), "เก็บเข้าที่เก็บ".into())],
        "restored" => vec![tr("Restored from the archive".into(), "กู้คืนจากที่เก็บ".into())],
        "attachment_added" => vec![tr(format!("Attached {}", s("filename")), format!("แนบไฟล์ {}", s("filename")))],
        "attachment_removed" => vec![tr(format!("Removed attachment {}", s("filename")), format!("ลบไฟล์แนบ {}", s("filename")))],
        _ => Vec::new(),
    }
}

// ---------- delivery ----------

/// Enabled channels of a board that want `event`.
async fn channels(state: &AppState, board_id: Uuid) -> Vec<BRow> {
    sqlx::query_as(sqlf!("SELECT {cols}, locale FROM {TABLE} WHERE board_id = $1 AND enabled", cols = contacts::COLS))
        .bind(board_id)
        .fetch_all(&state.db)
        .await
        .unwrap_or_default()
}

fn wants(c: &BRow, event: &str) -> bool {
    c.base.events.is_empty() || c.base.events.iter().any(|e| e == event)
}

async fn post(state: &AppState, sys: &contacts::System, c: &BRow, m: &Message) {
    let cfg = c.base.config.as_object().cloned().unwrap_or_default();
    let res = contacts::send(state, sys, &c.base.kind, &cfg, m).await;
    if let Err(e) = &res {
        tracing::warn!(channel = %c.base.id, kind = %c.base.kind, error = %e, "board channel delivery failed");
    }
    crate::metrics::delivery("board_channel", res.is_ok());
    contacts::record_in(state, TABLE, c.base.id, &res).await;
}

/// New comment → board channels (right away; comments are what people wait for).
pub fn comment(state: &AppState, board_id: Uuid, card_id: Uuid, actor_id: Uuid, snippet: String) {
    let st = state.clone();
    tokio::spawn(async move {
        let sys = contacts::system(&st).await;
        if !sys.push {
            return;
        }
        let chans: Vec<BRow> = channels(&st, board_id).await.into_iter().filter(|c| wants(c, "commented")).collect();
        if chans.is_empty() {
            return;
        }
        let Ok((board_name, number, title, actor)): Result<(String, i32, String, Option<String>), _> = sqlx::query_as(sqlf!(
            "SELECT b.name, c.number, c.title, (SELECT {dn} FROM users u WHERE u.id = $2)
             FROM cards c JOIN boards b ON b.id = c.board_id WHERE c.id = $1",
            dn = crate::auth::DISPLAY_NAME_SQL
        ))
        .bind(card_id)
        .bind(actor_id)
        .fetch_one(&st.db)
        .await
        else {
            return;
        };
        let base = crate::notify::base_url(&st).await;
        let card = Card { id: card_id, number, title };
        let actor = actor.unwrap_or_default();
        for c in chans {
            let th = c.locale == "th";
            let mut m = message(&base, th, "commented", board_id, &board_name, Some(&card), Some(&actor));
            m.subject = if th { format!("{actor} แสดงความคิดเห็นใน #{} {}", card.number, card.title) } else { format!("{actor} commented on #{} {}", card.number, card.title) };
            m.snippet = snippet.clone();
            post(&st, &sys, &c, &m).await;
        }
    });
}

/// Called by the due job: one post per card, kind and due date (due soon by the card's reminder time / overdue up to
/// 7 days).
pub async fn due_pass(state: &AppState) {
    let sys = contacts::system(state).await;
    if !sys.push {
        return;
    }
    let soon = crate::notify::due_soon_sql();
    for (kind, window) in [("due_soon", soon.as_str()), ("overdue", crate::notify::OVERDUE_SQL)] {
        let rows: Vec<(Uuid, Uuid, String, i32, String, DateTime<Utc>)> = match sqlx::query_as(sqlf!(
            "INSERT INTO board_due_posts (card_id, kind, due_at)
             SELECT c.id, '{kind}', c.due_at FROM cards c
             JOIN lists l ON l.id = c.list_id JOIN boards b ON b.id = c.board_id
             WHERE {window} AND c.archived_at IS NULL AND l.archived_at IS NULL AND b.archived_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM board_statuses s WHERE s.id = c.status_id AND s.is_done)
               AND EXISTS (SELECT 1 FROM {TABLE} p WHERE p.board_id = c.board_id AND p.enabled AND (p.events = '{{}}' OR 'due' = ANY(p.events)))
             ON CONFLICT DO NOTHING
             RETURNING card_id, (SELECT board_id FROM cards WHERE id = card_id),
                       (SELECT b.name FROM cards x JOIN boards b ON b.id = x.board_id WHERE x.id = card_id),
                       (SELECT number FROM cards WHERE id = card_id), (SELECT title FROM cards WHERE id = card_id), due_at"
        ))
        .fetch_all(&state.db)
        .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "board due pass failed");
                crate::metrics::job_failed("board_due");
                continue;
            }
        };
        let base = crate::notify::base_url(state).await;
        for (card_id, board_id, board_name, number, title, due) in rows {
            let card = Card { id: card_id, number, title };
            for c in channels(state, board_id).await.into_iter().filter(|c| wants(c, "due")) {
                let th = c.locale == "th";
                let mut m = message(&base, th, kind, board_id, &board_name, Some(&card), None);
                let name = format!("#{} {}", card.number, card.title);
                (m.subject, m.line) = match (kind, th) {
                    ("due_soon", false) => (format!("Due soon: {name}"), format!("Due {}", fmt_date(false, due))),
                    ("due_soon", true) => (format!("ใกล้ครบกำหนด: {name}"), format!("ครบกำหนด {}", fmt_date(true, due))),
                    (_, false) => (format!("Overdue: {name}"), format!("Was due {}", fmt_date(false, due))),
                    (_, true) => (format!("เลยกำหนด: {name}"), format!("ครบกำหนดเมื่อ {}", fmt_date(true, due))),
                };
                post(state, &sys, &c, &m).await;
            }
        }
    }
}

#[derive(sqlx::FromRow)]
struct Ev {
    id: i64,
    card_id: Uuid,
    board_id: Uuid,
    actor_id: Option<Uuid>,
    kind: String,
    data: Value,
    created_at: DateTime<Utc>,
    actor: Option<String>,
    number: i32,
    title: String,
    board_name: String,
}

/// Reads new activity every 5 s and posts it (bundled per person and card).
pub fn spawn_dispatch(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
        loop {
            tick.tick().await;
            if let Err(e) = dispatch(&state).await {
                tracing::warn!(error = %e, "board activity dispatch failed");
                crate::metrics::job_failed("board_activity");
            }
        }
    });
}

async fn dispatch(state: &AppState) -> anyhow::Result<()> {
    let (cursor,): (i64,) =
        sqlx::query_as("SELECT COALESCE((value->>'last')::bigint, 0) FROM app_settings WHERE key = 'board_events_cursor'").fetch_one(&state.db).await?;
    // wait until an event is 8 s old so a burst of edits lands in one post (and its transaction has surely committed)
    let evs: Vec<Ev> = sqlx::query_as(sqlf!(
        "SELECT e.id, e.card_id, e.board_id, e.actor_id, e.kind, e.data, e.created_at,
                (SELECT {dn} FROM users u WHERE u.id = e.actor_id) AS actor, c.number, c.title, b.name AS board_name
         FROM card_events e JOIN cards c ON c.id = e.card_id JOIN boards b ON b.id = e.board_id
         WHERE e.id > $1 AND e.created_at < now() - interval '8 seconds'
         ORDER BY e.id LIMIT 1000",
        dn = crate::auth::DISPLAY_NAME_SQL
    ))
    .bind(cursor)
    .fetch_all(&state.db)
    .await?;
    let Some(last) = evs.last().map(|e| e.id) else { return Ok(()) };
    // claim the batch first: if two servers share the database, only one posts it
    let claimed = sqlx::query(
        "UPDATE app_settings SET value = jsonb_build_object('last', $2::bigint), updated_at = now()
         WHERE key = 'board_events_cursor' AND COALESCE((value->>'last')::bigint, 0) = $1",
    )
    .bind(cursor)
    .bind(last)
    .execute(&state.db)
    .await?
    .rows_affected()
        == 1;
    let sys = contacts::system(state).await;
    if !claimed || !sys.push {
        return Ok(());
    }
    // after downtime don't flood channels with old news
    let fresh: Vec<&Ev> = evs.iter().filter(|e| e.created_at > Utc::now() - chrono::Duration::hours(1) && category(&e.kind).is_some()).collect();
    let boards: HashSet<Uuid> = fresh.iter().map(|e| e.board_id).collect();
    let mut chans: HashMap<Uuid, Vec<BRow>> = HashMap::new();
    for b in boards {
        let c = channels(state, b).await;
        if !c.is_empty() {
            chans.insert(b, c);
        }
    }
    if chans.is_empty() {
        return Ok(());
    }
    // bundle: (board, card, person) in order of first appearance
    let mut order: Vec<(Uuid, Uuid, Option<Uuid>)> = Vec::new();
    let mut groups: HashMap<(Uuid, Uuid, Option<Uuid>), Vec<&Ev>> = HashMap::new();
    for e in fresh.into_iter().filter(|e| chans.contains_key(&e.board_id)) {
        let k = (e.board_id, e.card_id, e.actor_id);
        if !groups.contains_key(&k) {
            order.push(k);
        }
        groups.entry(k).or_default().push(e);
    }
    let base = crate::notify::base_url(state).await;
    for k in order {
        let evs = &groups[&k];
        let first = evs[0];
        let card = Card { id: first.card_id, number: first.number, title: first.title.clone() };
        let actor = first.actor.clone().unwrap_or_else(|| "Kanb".into());
        for c in &chans[&k.0] {
            let mine: Vec<&&Ev> = evs.iter().filter(|e| category(&e.kind).is_some_and(|cat| wants(c, cat))).collect();
            if mine.is_empty() {
                continue;
            }
            let th = c.locale == "th";
            let kinds: HashSet<&str> = mine.iter().map(|e| e.kind.as_str()).collect();
            let main = if kinds.contains("created") || kinds.contains("duplicated") {
                "card_created"
            } else if kinds.len() == 1 {
                category(&mine[0].kind).unwrap_or("card_updated")
            } else {
                "card_updated"
            };
            let mut m = message(&base, th, main, k.0, &first.board_name, Some(&card), Some(&actor));
            m.created_at = mine.last().unwrap().created_at;
            m.changes = mine.iter().flat_map(|e| phrase(th, &e.kind, &e.data)).collect();
            let name = format!("#{} {}", card.number, card.title);
            let moved_to = mine.iter().rev().find(|e| e.kind == "moved").and_then(|e| e.data.get("to")).and_then(|v| v.as_str()).unwrap_or("");
            m.subject = match (main, th) {
                ("card_created", false) => format!("{actor} created {name}"),
                ("card_created", true) => format!("{actor} สร้าง {name}"),
                ("card_moved", false) => format!("{actor} moved {name} to {moved_to}"),
                ("card_moved", true) => format!("{actor} ย้าย {name} ไปที่ {moved_to}"),
                ("status", false) => format!("{actor} changed the status of {name}"),
                ("status", true) => format!("{actor} เปลี่ยนสถานะของ {name}"),
                ("assigned", false) => format!("{actor} changed who’s assigned to {name}"),
                ("assigned", true) => format!("{actor} เปลี่ยนผู้รับผิดชอบ {name}"),
                ("attachments", false) => format!("{actor} changed attachments on {name}"),
                ("attachments", true) => format!("{actor} เปลี่ยนไฟล์แนบใน {name}"),
                ("archived", false) if kinds.contains("archived") => format!("{actor} archived {name}"),
                ("archived", true) if kinds.contains("archived") => format!("{actor} เก็บ {name} เข้าที่เก็บ"),
                (_, false) => format!("{actor} updated {name}"),
                (_, true) => format!("{actor} อัปเดต {name}"),
            };
            m.line = m.changes.iter().map(|c| format!("• {c}")).collect::<Vec<_>>().join("\n");
            post(state, &sys, c, &m).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phrases() {
        assert_eq!(phrase(false, "moved", &json!({"from": "To Do", "to": "Doing"})), vec!["Moved: To Do → Doing"]);
        assert_eq!(phrase(true, "priority", &json!({"from": 0, "to": 2})), vec!["ความสำคัญ: ไม่มี → ★★"]);
        assert_eq!(phrase(false, "labels", &json!({"added": ["bug"], "removed": ["ui"]})), vec!["Labels: +bug, −ui"]);
        assert_eq!(phrase(false, "assignees", &json!({"added": ["Ann"], "removed": []})), vec!["Assigned: Ann"]);
        assert!(EVENTS.iter().all(|e| ["card_created", "card_moved", "status", "assigned", "commented", "due", "card_updated", "attachments", "archived"].contains(e)));
    }
}
