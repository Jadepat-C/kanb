//! Time tracking: a timer (one running per person, across all boards) or time entered by hand, logged against a
//! card. Logging needs the role permission "time.log"; people edit and delete their own entries, and those who may
//! manage the board can fix anyone's. Durations are always measured by the server's clock.

use axum::{
    Json,
    extract::{Path, State},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    auth::CurrentUser,
    error::{AppError, AppResult},
    perms::{self, board_access, board_of_card},
};

/// one entry can't be longer than a week
const MAX_MINUTES: i32 = 7 * 24 * 60;

#[derive(Serialize, sqlx::FromRow)]
pub struct Entry {
    id: Uuid,
    user_id: Uuid,
    user_name: Option<String>,
    started_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
    /// finished: as logged; running: so far
    minutes: i32,
    note: String,
}

/// Stops `user`'s running timer (only on that board, when given), rounding to whole minutes (at least 1).
pub async fn stop_running(db: &PgPool, user: Uuid, board: Option<Uuid>) -> AppResult<Option<(Uuid, Uuid, i32)>> {
    let row: Option<(Uuid, Uuid, i32)> = sqlx::query_as(
        "UPDATE time_entries SET ended_at = now(),
                minutes = GREATEST(1, LEAST($3, round(extract(epoch FROM now() - started_at) / 60)::int))
         WHERE user_id = $1 AND ended_at IS NULL AND ($2::uuid IS NULL OR board_id = $2)
         RETURNING id, card_id, minutes",
    )
    .bind(user)
    .bind(board)
    .bind(MAX_MINUTES)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

async fn entries(db: &PgPool, card_id: Uuid) -> AppResult<Vec<Entry>> {
    Ok(sqlx::query_as(sqlf!(
        "SELECT t.id, t.user_id, {DN} AS user_name, t.started_at, t.ended_at,
                CASE WHEN t.ended_at IS NULL THEN GREATEST(0, (extract(epoch FROM now() - t.started_at) / 60)::int) ELSE t.minutes END AS minutes,
                t.note
         FROM time_entries t LEFT JOIN users u ON u.id = t.user_id
         WHERE t.card_id = $1 ORDER BY t.started_at DESC",
        DN = crate::auth::DISPLAY_NAME_SQL
    ))
    .bind(card_id)
    .fetch_all(db)
    .await?)
}

/// GET /cards/{id}/time
pub async fn list(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(card_id): Path<Uuid>) -> AppResult<Json<Value>> {
    let board_id = board_of_card(&state.db, card_id).await?;
    let access = board_access(&state.db, &u, board_id).await?;
    let items = entries(&state.db, card_id).await?;
    let (estimate,): (Option<i32>,) = sqlx::query_as("SELECT estimate_minutes FROM cards WHERE id = $1").bind(card_id).fetch_one(&state.db).await?;
    let total: i64 = items.iter().filter(|e| e.ended_at.is_some()).map(|e| e.minutes as i64).sum();
    Ok(Json(json!({
        "entries": items,
        "total_minutes": total,
        "estimate_minutes": estimate,
        "can_log": access.can(perms::TIME_LOG),
        // fix anyone's entries
        "can_manage": access.can(perms::BOARD_MANAGE),
    })))
}

/// The card is on a board where `u` may log time.
async fn loggable(state: &AppState, u: &crate::auth::User, card_id: Uuid) -> AppResult<Uuid> {
    let board_id = board_of_card(&state.db, card_id).await?;
    board_access(&state.db, u, board_id).await?.require(perms::TIME_LOG)?;
    Ok(board_id)
}

/// POST /cards/{id}/time/start: start a timer here (a timer running elsewhere is stopped and logged first).
pub async fn start(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(card_id): Path<Uuid>) -> AppResult<Json<Value>> {
    let board_id = loggable(&state, &u, card_id).await?;
    let stopped = stop_running(&state.db, u.id, None).await?;
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO time_entries (id, card_id, board_id, user_id, started_at) VALUES ($1, $2, $3, $4, now())")
        .bind(id)
        .bind(card_id)
        .bind(board_id)
        .bind(u.id)
        .execute(&state.db)
        .await
        // two quick clicks: the other one already started it
        .map_err(|e| match AppError::from(e) {
            AppError::Conflict(_) => AppError::Conflict("timer_running"),
            e => e,
        })?;
    if let Some((_, other_card, _)) = stopped {
        notify_card(&state, other_card, u.id).await;
    }
    state.hub.notify(board_id, "card", Some(card_id), u.id);
    Ok(Json(json!({ "id": id, "stopped": stopped.map(|s| json!({ "card_id": s.1, "minutes": s.2 })) })))
}

#[derive(Deserialize)]
pub struct StopReq {
    /// the real duration, when the timer ran on by mistake (e.g. forgotten overnight)
    minutes: Option<i32>,
    note: Option<String>,
}

/// POST /me/timer/stop
pub async fn stop(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<StopReq>) -> AppResult<Json<Value>> {
    if r.minutes.is_some_and(|m| !(1..=MAX_MINUTES).contains(&m)) {
        return Err(AppError::BadRequest("invalid_minutes"));
    }
    let Some((id, card_id, minutes)) = stop_running(&state.db, u.id, None).await? else {
        return Err(AppError::BadRequest("no_timer"));
    };
    let minutes = r.minutes.unwrap_or(minutes);
    sqlx::query("UPDATE time_entries SET minutes = $2, note = COALESCE($3, note) WHERE id = $1")
        .bind(id)
        .bind(minutes)
        .bind(r.note.map(|n| n.trim().chars().take(500).collect::<String>()))
        .execute(&state.db)
        .await?;
    notify_card(&state, card_id, u.id).await;
    Ok(Json(json!({ "id": id, "card_id": card_id, "minutes": minutes })))
}

async fn notify_card(state: &AppState, card_id: Uuid, actor: Uuid) {
    if let Ok(board_id) = board_of_card(&state.db, card_id).await {
        state.hub.notify(board_id, "card", Some(card_id), actor);
    }
}

/// GET /me/timer: my running timer, for the header.
pub async fn mine(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    let row: Option<(Uuid, Uuid, i32, String, Uuid, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT t.id, c.id, c.number, c.title, b.id, b.name, t.started_at
         FROM time_entries t JOIN cards c ON c.id = t.card_id JOIN boards b ON b.id = t.board_id
         WHERE t.user_id = $1 AND t.ended_at IS NULL",
    )
    .bind(u.id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(json!({
        "running": row.map(|(id, card_id, number, title, board_id, board_name, started_at)| json!({
            "id": id, "card_id": card_id, "card_number": number, "card_title": title, "board_id": board_id, "board_name": board_name,
            "started_at": started_at,
        })),
    })))
}

#[derive(Deserialize)]
pub struct LogReq {
    minutes: i32,
    /// when the work started (default: `minutes` before now)
    started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    note: String,
}

/// POST /cards/{id}/time: time entered by hand.
pub async fn log(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(card_id): Path<Uuid>, Json(r): Json<LogReq>) -> AppResult<Json<Value>> {
    let board_id = loggable(&state, &u, card_id).await?;
    if !(1..=MAX_MINUTES).contains(&r.minutes) {
        return Err(AppError::BadRequest("invalid_minutes"));
    }
    let started = r.started_at.unwrap_or_else(|| Utc::now() - Duration::minutes(r.minutes as i64));
    if started > Utc::now() + Duration::days(1) {
        return Err(AppError::BadRequest("invalid_date"));
    }
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO time_entries (id, card_id, board_id, user_id, started_at, ended_at, minutes, note)
         VALUES ($1, $2, $3, $4, $5, $5 + make_interval(mins => $6), $6, $7)",
    )
    .bind(id)
    .bind(card_id)
    .bind(board_id)
    .bind(u.id)
    .bind(started)
    .bind(r.minutes)
    .bind(r.note.trim().chars().take(500).collect::<String>())
    .execute(&state.db)
    .await?;
    state.hub.notify(board_id, "card", Some(card_id), u.id);
    Ok(Json(json!({ "id": id })))
}

/// An entry `u` may change: their own (while they may still log time there), or anyone's for board managers.
async fn editable(state: &AppState, u: &crate::auth::User, id: Uuid) -> AppResult<(Uuid, Uuid, bool)> {
    let row: Option<(Uuid, Uuid, Uuid, bool)> =
        sqlx::query_as("SELECT card_id, board_id, user_id, ended_at IS NULL FROM time_entries WHERE id = $1").bind(id).fetch_optional(&state.db).await?;
    let (card_id, board_id, owner, running) = row.ok_or(AppError::NotFound)?;
    let access = board_access(&state.db, u, board_id).await?;
    if !(access.can(perms::BOARD_MANAGE) || (owner == u.id && access.can(perms::TIME_LOG))) {
        return Err(AppError::Forbidden);
    }
    Ok((card_id, board_id, running))
}

#[derive(Deserialize)]
pub struct EditReq {
    minutes: Option<i32>,
    started_at: Option<DateTime<Utc>>,
    note: Option<String>,
}

/// PATCH /time/{id}
pub async fn edit(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, Json(r): Json<EditReq>) -> AppResult<Json<Value>> {
    let (card_id, board_id, running) = editable(&state, &u, id).await?;
    if running && (r.minutes.is_some() || r.started_at.is_some()) {
        return Err(AppError::BadRequest("timer_running"));
    }
    if r.minutes.is_some_and(|m| !(1..=MAX_MINUTES).contains(&m)) {
        return Err(AppError::BadRequest("invalid_minutes"));
    }
    sqlx::query(
        "UPDATE time_entries SET minutes = COALESCE($2, minutes), started_at = COALESCE($3, started_at), note = COALESCE($4, note),
                ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE COALESCE($3, started_at) + make_interval(mins => COALESCE($2, minutes)) END
         WHERE id = $1",
    )
    .bind(id)
    .bind(r.minutes)
    .bind(r.started_at)
    .bind(r.note.map(|n| n.trim().chars().take(500).collect::<String>()))
    .execute(&state.db)
    .await?;
    state.hub.notify(board_id, "card", Some(card_id), u.id);
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /time/{id}
pub async fn delete(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let (card_id, board_id, _) = editable(&state, &u, id).await?;
    sqlx::query("DELETE FROM time_entries WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(board_id, "card", Some(card_id), u.id);
    Ok(Json(json!({ "ok": true })))
}
