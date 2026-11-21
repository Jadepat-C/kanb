//! Private calendar feed (iCalendar / .ics): subscribe in Google, Outlook or Apple Calendar.
//! The link carries a random token (only its hash is stored); resetting makes a new one.
//! What it contains is chosen in Profile: the entire app (all my boards), or only chosen boards plus individually
//! picked cards; at app/board level optionally only cards assigned to me. Picked cards are always included.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Local, Timelike, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{CurrentUser, new_token, token_hash},
    error::{AppError, AppResult},
};

/// My feed settings (the link itself is only shown when created).
pub async fn status(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    let (has, all, only_mine): (bool, bool, bool) =
        sqlx::query_as("SELECT calendar_token_hash IS NOT NULL, calendar_all, calendar_only_mine FROM users WHERE id = $1").bind(u.id).fetch_one(&state.db).await?;
    let boards: Vec<(Uuid,)> = sqlx::query_as("SELECT board_id FROM calendar_feed_boards WHERE user_id = $1").bind(u.id).fetch_all(&state.db).await?;
    let cards: Vec<(Uuid, Uuid, i32, String, String)> = sqlx::query_as(
        "SELECT c.id, c.board_id, c.number, c.title, b.name FROM calendar_feed_cards f
         JOIN cards c ON c.id = f.card_id JOIN boards b ON b.id = c.board_id
         WHERE f.user_id = $1 AND c.archived_at IS NULL AND b.archived_at IS NULL ORDER BY lower(b.name), c.number",
    )
    .bind(u.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({
        "enabled": has, "all": all, "only_mine": only_mine,
        "board_ids": boards.into_iter().map(|b| b.0).collect::<Vec<_>>(),
        "cards": cards.into_iter().map(|(id, board_id, number, title, board_name)| json!({ "id": id, "board_id": board_id, "number": number, "title": title, "board_name": board_name })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct SettingsReq {
    all: Option<bool>,
    only_mine: Option<bool>,
    board_ids: Option<Vec<Uuid>>,
}

pub async fn update(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<SettingsReq>) -> AppResult<Json<Value>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET calendar_all = COALESCE($2, calendar_all), calendar_only_mine = COALESCE($3, calendar_only_mine) WHERE id = $1")
        .bind(u.id)
        .bind(r.all)
        .bind(r.only_mine)
        .execute(&mut *tx)
        .await?;
    if let Some(ids) = r.board_ids {
        sqlx::query("DELETE FROM calendar_feed_boards WHERE user_id = $1").bind(u.id).execute(&mut *tx).await?;
        // only boards I can see
        sqlx::query(
            "INSERT INTO calendar_feed_boards (user_id, board_id)
             SELECT $1, b.id FROM boards b WHERE b.id = ANY($2)
               AND ($3 OR EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $1))",
        )
        .bind(u.id)
        .bind(&ids)
        .bind(u.is_super_admin)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    status(State(state), CurrentUser(u)).await
}

#[derive(Deserialize)]
pub struct PickReq {
    on: bool,
}

/// "Add to my calendar" on a single card.
pub async fn pick(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(card_id): Path<Uuid>, Json(r): Json<PickReq>) -> AppResult<Json<Value>> {
    let board_id = crate::perms::board_of_card(&state.db, card_id).await?;
    crate::perms::board_access(&state.db, &u, board_id).await?;
    if r.on {
        sqlx::query("INSERT INTO calendar_feed_cards (user_id, card_id) VALUES ($1, $2) ON CONFLICT DO NOTHING").bind(u.id).bind(card_id).execute(&state.db).await?;
    } else {
        sqlx::query("DELETE FROM calendar_feed_cards WHERE user_id = $1 AND card_id = $2").bind(u.id).bind(card_id).execute(&state.db).await?;
    }
    Ok(Json(json!({ "on": r.on })))
}

/// Creates (or replaces) my feed link; the old one stops working.
pub async fn reset(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    let token = new_token();
    sqlx::query("UPDATE users SET calendar_token_hash = $2 WHERE id = $1").bind(u.id).bind(token_hash(&token)).execute(&state.db).await?;
    let base = crate::notify::base_url(&state).await;
    Ok(Json(json!({ "url": format!("{base}/api/calendar/{token}.ics") })))
}

pub async fn disable(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    sqlx::query("UPDATE users SET calendar_token_hash = NULL WHERE id = $1").bind(u.id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct FeedQuery {
    scope: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Item {
    id: Uuid,
    board_id: Uuid,
    number: i32,
    title: String,
    board_name: String,
    list_name: String,
    status: Option<String>,
    done: bool,
    start_at: Option<DateTime<Utc>>,
    due_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

/// RFC 5545 text escaping.
fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace(';', "\\;").replace(',', "\\,").replace('\r', "").replace('\n', "\\n")
}

/// Lines longer than 75 bytes are folded (continuation lines start with a space), never inside a UTF-8 character.
fn fold(line: &str, out: &mut String) {
    let mut len = 0;
    for ch in line.chars() {
        let w = ch.len_utf8();
        if len + w > 75 {
            out.push_str("\r\n ");
            len = 1;
        }
        out.push(ch);
        len += w;
    }
    out.push_str("\r\n");
}

fn utc(d: DateTime<Utc>) -> String {
    d.format("%Y%m%dT%H%M%SZ").to_string()
}

fn is_midnight(d: DateTime<Utc>) -> bool {
    let l = d.with_timezone(&Local);
    l.hour() == 0 && l.minute() == 0
}

pub async fn feed(State(state): State<AppState>, Path(file): Path<String>, Query(q): Query<FeedQuery>) -> AppResult<Response> {
    let token = file.strip_suffix(".ics").unwrap_or(&file);
    let row: Option<(Uuid, bool, String)> =
        sqlx::query_as("SELECT id, is_super_admin, locale FROM users WHERE calendar_token_hash = $1 AND is_active AND deleted_at IS NULL")
            .bind(token_hash(token))
            .fetch_optional(&state.db)
            .await?;
    let (uid, superadmin, _locale) = row.ok_or(AppError::NotFound)?;
    let (mut all, mut only_mine): (bool, bool) =
        sqlx::query_as("SELECT calendar_all, calendar_only_mine FROM users WHERE id = $1").bind(uid).fetch_one(&state.db).await?;
    // links made before the settings existed carried ?scope=mine|all
    match q.scope.as_deref() {
        Some("all") => (all, only_mine) = (true, false),
        Some("mine") => (all, only_mine) = (true, true),
        _ => {}
    }
    let items: Vec<Item> = sqlx::query_as(
        "SELECT c.id, c.board_id, c.number, c.title, b.name AS board_name, l.name AS list_name, s.name AS status,
                COALESCE(s.is_done, false) AS done, c.start_at, c.due_at, c.updated_at
         FROM cards c JOIN boards b ON b.id = c.board_id JOIN lists l ON l.id = c.list_id
         LEFT JOIN board_statuses s ON s.id = c.status_id
         WHERE c.due_at IS NOT NULL AND c.archived_at IS NULL AND l.archived_at IS NULL AND b.archived_at IS NULL
           AND c.due_at > now() - interval '120 days'
           -- I must still be able to open the board
           AND ($3 OR EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $1))
           AND (
                -- cards I picked: always
                EXISTS (SELECT 1 FROM calendar_feed_cards f WHERE f.user_id = $1 AND f.card_id = c.id)
                -- entire app or a chosen board, optionally only my cards
                OR (($4 OR EXISTS (SELECT 1 FROM calendar_feed_boards fb WHERE fb.user_id = $1 AND fb.board_id = b.id))
                    AND (NOT $2 OR EXISTS (SELECT 1 FROM card_assignees a WHERE a.card_id = c.id AND a.user_id = $1)))
           )
         ORDER BY c.due_at LIMIT 2000",
    )
    .bind(uid)
    .bind(only_mine)
    .bind(superadmin)
    .bind(all)
    .fetch_all(&state.db)
    .await?;
    let base = crate::notify::base_url(&state).await;
    let mut out = String::new();
    let cal_name = "Kanban";
    for l in ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kanban//Cards//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"] {
        fold(l, &mut out);
    }
    fold(&format!("X-WR-CALNAME:{}", esc(cal_name)), &mut out);
    fold("REFRESH-INTERVAL;VALUE=DURATION:PT1H", &mut out);
    fold("X-PUBLISHED-TTL:PT1H", &mut out);
    for it in items {
        let link = format!("{base}/b/{}?card={}", it.board_id, it.id);
        fold("BEGIN:VEVENT", &mut out);
        fold(&format!("UID:{}@kanban", it.id), &mut out);
        fold(&format!("DTSTAMP:{}", utc(it.updated_at)), &mut out);
        let start = it.start_at.filter(|s| *s <= it.due_at);
        match start {
            // start → due: all-day span if both are at midnight, otherwise exact times
            Some(s) if is_midnight(s) && is_midnight(it.due_at) => {
                fold(&format!("DTSTART;VALUE=DATE:{}", s.with_timezone(&Local).format("%Y%m%d")), &mut out);
                fold(&format!("DTEND;VALUE=DATE:{}", (it.due_at.with_timezone(&Local) + chrono::Duration::days(1)).format("%Y%m%d")), &mut out);
            }
            Some(s) => {
                fold(&format!("DTSTART:{}", utc(s)), &mut out);
                fold(&format!("DTEND:{}", utc(it.due_at.max(s + chrono::Duration::minutes(30)))), &mut out);
            }
            // due only: all-day when due at midnight, otherwise a 30-minute slot at the due time
            None if is_midnight(it.due_at) => {
                let d = it.due_at.with_timezone(&Local);
                fold(&format!("DTSTART;VALUE=DATE:{}", d.format("%Y%m%d")), &mut out);
                fold(&format!("DTEND;VALUE=DATE:{}", (d + chrono::Duration::days(1)).format("%Y%m%d")), &mut out);
            }
            None => {
                fold(&format!("DTSTART:{}", utc(it.due_at)), &mut out);
                fold(&format!("DTEND:{}", utc(it.due_at + chrono::Duration::minutes(30))), &mut out);
            }
        }
        let summary = format!("{}#{} {}", if it.done { "✓ " } else { "" }, it.number, it.title);
        fold(&format!("SUMMARY:{}", esc(&summary)), &mut out);
        let desc = format!("{} · {}{}\n{}", it.board_name, it.list_name, it.status.map(|s| format!(" · {s}")).unwrap_or_default(), link);
        fold(&format!("DESCRIPTION:{}", esc(&desc)), &mut out);
        fold(&format!("URL:{link}"), &mut out);
        fold(&format!("CATEGORIES:{}", esc(&it.board_name)), &mut out);
        if it.done {
            fold("TRANSP:TRANSPARENT", &mut out);
        }
        fold("END:VEVENT", &mut out);
    }
    fold("END:VCALENDAR", &mut out);
    let mut resp = out.into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/calendar; charset=utf-8"));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("inline; filename=\"kanban.ics\""));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=300"));
    Ok(resp)
}

#[cfg(test)]
mod tests {
    #[test]
    fn folding_and_escaping() {
        let mut out = String::new();
        super::fold(&format!("SUMMARY:{}", super::esc(&"ทดสอบ, a;b\nc ".repeat(8))), &mut out);
        for line in out.split("\r\n").filter(|l| !l.is_empty()) {
            assert!(line.len() <= 75, "{} bytes", line.len());
        }
        assert!(out.contains("\\,") && out.contains("\\;") && out.contains("\\n"));
    }
}
