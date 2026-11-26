//! Board analytics (the board's Analytics view; permission `analytics.view`).
//!
//! Definitions, so the numbers mean the same thing everywhere:
//! - **open**: not archived, in a column that isn't archived, and its status isn't a "done" status
//! - **finished**: its status is a "done" status; *when* is `done_at` (set when it got that status). Finished cards
//!   that were archived afterwards still count as finished.
//! - **lead time**: created → finished. **Cycle time**: started → finished, where "started" is the first time the
//!   card was moved or got another status after it was made. Imported cards have no such history, so they count for
//!   lead time only.
//! - **on time**: finished on or before its due date (only cards that had one).
//! - **stale**: open and not changed for 14 days. **Blocked**: open and waiting for a card that isn't finished.
//! - Weeks start on Monday in the server's time zone (TZ).

use std::sync::OnceLock;

use axum::{
    extract::{Path, Query, State},
    response::Response,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::CurrentUser,
    error::AppResult,
    perms::{self, board_access},
};

static TZ: OnceLock<String> = OnceLock::new();

/// The server's time zone (TZ) as Postgres knows it, or UTC.
async fn tz(db: &sqlx::PgPool) -> String {
    if let Some(t) = TZ.get() {
        return t.clone();
    }
    let want = std::env::var("TZ").unwrap_or_default();
    let known: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)").bind(&want).fetch_one(db).await.unwrap_or(false);
    let t = if known { want } else { "UTC".to_string() };
    let _ = TZ.set(t.clone());
    t
}

#[derive(Deserialize)]
pub struct AnalyticsQuery {
    /// period in days: 30, 90 (default), 180 or 365
    days: Option<i32>,
}

#[derive(Serialize, sqlx::FromRow)]
struct Overview {
    open: i64,
    created: i64,
    finished: i64,
    overdue: i64,
    due_week: i64,
    no_due: i64,
    unassigned: i64,
    blocked: i64,
    stale: i64,
    finished_with_due: i64,
    on_time: i64,
    archived_in_period: i64,
}

#[derive(Serialize, sqlx::FromRow)]
struct Week {
    week: NaiveDate,
    created: i64,
    finished: i64,
}

#[derive(Serialize, sqlx::FromRow)]
struct Times {
    lead_n: i64,
    lead_median: Option<f64>,
    lead_p85: Option<f64>,
    cycle_n: i64,
    cycle_median: Option<f64>,
    cycle_p85: Option<f64>,
}

#[derive(Serialize, sqlx::FromRow)]
struct Column {
    id: Uuid,
    name: String,
    color: Option<String>,
    wip_limit: Option<i32>,
    cards: i64,
    open: i64,
    avg_age_days: Option<f64>,
}

#[derive(Serialize, sqlx::FromRow)]
struct CardRef {
    id: Uuid,
    number: i32,
    title: String,
    list: String,
    age_days: f64,
    idle_days: f64,
    due_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, sqlx::FromRow)]
struct PersonRow {
    user_id: Uuid,
    name: String,
    color: String,
    avatar_id: Option<Uuid>,
    open: i64,
    overdue: i64,
    finished: i64,
}

#[derive(Serialize, sqlx::FromRow)]
struct LabelRow {
    id: Uuid,
    name: String,
    color: String,
    open: i64,
    finished: i64,
}

#[derive(Serialize, sqlx::FromRow)]
struct Bucket {
    key: Option<String>,
    name: Option<String>,
    color: Option<String>,
    open: i64,
}

#[derive(Serialize, sqlx::FromRow)]
struct FlowPoint {
    day: NaiveDate,
    list_id: Uuid,
    cards: i32,
}

/// Every card of the board with the facts the queries need: `open`, `fin` (finished), and `done_at`.
const BASE: &str = "WITH c AS (
    SELECT c.*, l.name AS list_name, l.archived_at AS list_archived,
           COALESCE(s.is_done, false) AS fin,
           (c.archived_at IS NULL AND l.archived_at IS NULL AND NOT COALESCE(s.is_done, false)) AS open
    FROM cards c JOIN lists l ON l.id = c.list_id LEFT JOIN board_statuses s ON s.id = c.status_id
    WHERE c.board_id = $1)";

pub async fn board(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(board_id): Path<Uuid>, Query(q): Query<AnalyticsQuery>) -> AppResult<Response> {
    board_access(&state.db, &u, board_id).await?.require(perms::ANALYTICS_VIEW)?;
    let days = match q.days.unwrap_or(90) {
        d @ (7 | 30 | 90 | 180 | 365) => d,
        _ => 90,
    };
    let tz = tz(&state.db).await;
    let _slot = crate::heavy(&state).await;
    let db = &state.db;
    let since: DateTime<Utc> = Utc::now() - chrono::Duration::days(days as i64);

    let overview: Overview = sqlx::query_as(sqlf!(
        "{BASE} SELECT
            count(*) FILTER (WHERE open) AS open,
            count(*) FILTER (WHERE created_at >= $2) AS created,
            count(*) FILTER (WHERE fin AND done_at >= $2) AS finished,
            count(*) FILTER (WHERE open AND due_at < now()) AS overdue,
            count(*) FILTER (WHERE open AND due_at >= now() AND due_at < now() + interval '7 days') AS due_week,
            count(*) FILTER (WHERE open AND due_at IS NULL) AS no_due,
            count(*) FILTER (WHERE open AND NOT EXISTS (SELECT 1 FROM card_assignees a WHERE a.card_id = c.id)) AS unassigned,
            count(*) FILTER (WHERE open AND EXISTS (
                SELECT 1 FROM card_dependencies d JOIN cards p ON p.id = d.depends_on LEFT JOIN board_statuses ps ON ps.id = p.status_id
                WHERE d.card_id = c.id AND p.archived_at IS NULL AND NOT COALESCE(ps.is_done, false))) AS blocked,
            count(*) FILTER (WHERE open AND updated_at < now() - interval '14 days') AS stale,
            count(*) FILTER (WHERE fin AND done_at >= $2 AND due_at IS NOT NULL) AS finished_with_due,
            count(*) FILTER (WHERE fin AND done_at >= $2 AND due_at IS NOT NULL AND done_at <= due_at) AS on_time,
            count(*) FILTER (WHERE archived_at >= $2) AS archived_in_period
         FROM c"
    ))
    .bind(board_id)
    .bind(since)
    .fetch_one(db)
    .await?;

    // weeks (Monday start, server time zone): created and finished per week
    let weeks_back = ((days + 6) / 7).min(53);
    let weeks: Vec<Week> = sqlx::query_as(sqlf!(
        "{BASE}, w AS (
            SELECT generate_series(date_trunc('week', now() AT TIME ZONE $3) - make_interval(weeks => $4 - 1),
                                   date_trunc('week', now() AT TIME ZONE $3), interval '1 week')::date AS week)
         SELECT w.week,
                (SELECT count(*) FROM c WHERE date_trunc('week', c.created_at AT TIME ZONE $3)::date = w.week) AS created,
                (SELECT count(*) FROM c WHERE c.fin AND date_trunc('week', c.done_at AT TIME ZONE $3)::date = w.week) AS finished
         FROM w ORDER BY w.week"
    ))
    .bind(board_id)
    .bind(since)
    .bind(&tz)
    .bind(weeks_back)
    .fetch_all(db)
    .await?;
    // totals before the first week, so the chart can show running totals
    let first = weeks.first().map(|w| w.week);
    let (created_before, finished_before): (i64, i64) = sqlx::query_as(sqlf!(
        "{BASE} SELECT count(*) FILTER (WHERE (created_at AT TIME ZONE $3)::date < $4),
                       count(*) FILTER (WHERE fin AND (done_at AT TIME ZONE $3)::date < $4) FROM c"
    ))
    .bind(board_id)
    .bind(since)
    .bind(&tz)
    .bind(first)
    .fetch_one(db)
    .await?;

    let times: Times = sqlx::query_as(sqlf!(
        "{BASE}, f AS (
            SELECT EXTRACT(EPOCH FROM (done_at - created_at))::float8 / 86400 AS lead,
                   EXTRACT(EPOCH FROM (done_at - (SELECT min(e.created_at) FROM card_events e
                        WHERE e.card_id = c.id AND e.kind IN ('moved', 'status') AND e.created_at > c.created_at + interval '1 second'
                          AND e.created_at < c.done_at)))::float8 / 86400 AS cycle
            FROM c WHERE fin AND done_at >= $2 AND done_at >= created_at)
         SELECT count(lead) AS lead_n,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY lead) AS lead_median,
                percentile_cont(0.85) WITHIN GROUP (ORDER BY lead) AS lead_p85,
                count(cycle) FILTER (WHERE cycle >= 0) AS cycle_n,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY cycle) FILTER (WHERE cycle >= 0) AS cycle_median,
                percentile_cont(0.85) WITHIN GROUP (ORDER BY cycle) FILTER (WHERE cycle >= 0) AS cycle_p85
         FROM f"
    ))
    .bind(board_id)
    .bind(since)
    .fetch_one(db)
    .await?;

    let columns: Vec<Column> = sqlx::query_as(sqlf!(
        r#"{BASE} SELECT l.id, l.name, l.color, l.wip_limit,
                count(c.id) FILTER (WHERE c.archived_at IS NULL) AS cards,
                count(c.id) FILTER (WHERE c.open) AS open,
                avg(EXTRACT(EPOCH FROM now() - c.created_at)::float8 / 86400) FILTER (WHERE c.open) AS avg_age_days
         FROM lists l LEFT JOIN c ON c.list_id = l.id
         WHERE l.board_id = $1 AND l.archived_at IS NULL AND $2::timestamptz IS NOT NULL
         GROUP BY l.id ORDER BY l.position COLLATE "C""#
    ))
    .bind(board_id)
    .bind(since)
    .fetch_all(db)
    .await?;

    let card_cols = "c.id, c.number, c.title, c.list_name AS list,
                     EXTRACT(EPOCH FROM now() - c.created_at)::float8 / 86400 AS age_days,
                     EXTRACT(EPOCH FROM now() - c.updated_at)::float8 / 86400 AS idle_days, c.due_at";
    let stale: Vec<CardRef> = sqlx::query_as(sqlf!("{BASE} SELECT {card_cols} FROM c WHERE open AND $2::timestamptz IS NOT NULL ORDER BY updated_at LIMIT 10"))
        .bind(board_id)
        .bind(since)
        .fetch_all(db)
        .await?;
    let blocked: Vec<CardRef> = sqlx::query_as(sqlf!(
        "{BASE} SELECT {card_cols} FROM c WHERE open AND $2::timestamptz IS NOT NULL AND EXISTS (
            SELECT 1 FROM card_dependencies d JOIN cards p ON p.id = d.depends_on LEFT JOIN board_statuses ps ON ps.id = p.status_id
            WHERE d.card_id = c.id AND p.archived_at IS NULL AND NOT COALESCE(ps.is_done, false))
         ORDER BY c.created_at LIMIT 10"
    ))
    .bind(board_id)
    .bind(since)
    .fetch_all(db)
    .await?;

    // people: everyone on the board, and anyone still assigned to its cards
    let people: Vec<PersonRow> = sqlx::query_as(sqlf!(
        "{BASE} SELECT u.id AS user_id, u.display_name AS name, u.avatar_color AS color, u.avatar_id,
                count(c.id) FILTER (WHERE c.open) AS open,
                count(c.id) FILTER (WHERE c.open AND c.due_at < now()) AS overdue,
                count(c.id) FILTER (WHERE c.fin AND c.done_at >= $2) AS finished
         FROM users u
         LEFT JOIN card_assignees a ON a.user_id = u.id
         LEFT JOIN c ON c.id = a.card_id
         WHERE u.id IN (SELECT user_id FROM board_members WHERE board_id = $1
                        UNION SELECT a2.user_id FROM card_assignees a2 JOIN cards x ON x.id = a2.card_id WHERE x.board_id = $1)
         GROUP BY u.id
         HAVING count(c.id) > 0 OR bool_or(u.id IN (SELECT user_id FROM board_members WHERE board_id = $1))
         ORDER BY count(c.id) FILTER (WHERE c.open) DESC, lower(u.display_name)"
    ))
    .bind(board_id)
    .bind(since)
    .fetch_all(db)
    .await?;
    let labels: Vec<LabelRow> = sqlx::query_as(sqlf!(
        "{BASE} SELECT x.id, x.name, x.color,
                count(c.id) FILTER (WHERE c.open) AS open,
                count(c.id) FILTER (WHERE c.fin AND c.done_at >= $2) AS finished
         FROM labels x LEFT JOIN card_labels cl ON cl.label_id = x.id LEFT JOIN c ON c.id = cl.card_id
         WHERE x.board_id = $1 GROUP BY x.id ORDER BY count(c.id) FILTER (WHERE c.open) DESC, x.name"
    ))
    .bind(board_id)
    .bind(since)
    .fetch_all(db)
    .await?;
    let priority: Vec<Bucket> = sqlx::query_as(sqlf!(
        "{BASE} SELECT priority::text AS key, NULL::text AS name, NULL::text AS color, count(*) AS open
         FROM c WHERE open AND $2::timestamptz IS NOT NULL GROUP BY priority ORDER BY priority DESC"
    ))
    .bind(board_id)
    .bind(since)
    .fetch_all(db)
    .await?;
    let statuses: Vec<Bucket> = sqlx::query_as(sqlf!(
        "{BASE} SELECT s.id::text AS key, s.name, s.color, count(c.id) FILTER (WHERE c.archived_at IS NULL AND c.list_archived IS NULL) AS open
         FROM board_statuses s LEFT JOIN c ON c.status_id = s.id
         WHERE s.board_id = $1 AND $2::timestamptz IS NOT NULL GROUP BY s.id ORDER BY s.position, s.name"
    ))
    .bind(board_id)
    .bind(since)
    .fetch_all(db)
    .await?;
    let flow: Vec<FlowPoint> = sqlx::query_as(
        "SELECT f.day, f.list_id, f.cards FROM board_daily_columns f JOIN lists l ON l.id = f.list_id
         WHERE f.board_id = $1 AND f.day >= ($2 AT TIME ZONE $3)::date AND l.archived_at IS NULL ORDER BY f.day",
    )
    .bind(board_id)
    .bind(since)
    .bind(&tz)
    .fetch_all(db)
    .await?;
    crate::json_now(&json!({
        "days": days, "tz": tz, "generated_at": Utc::now(),
        "overview": overview,
        "weeks": weeks, "created_before": created_before, "finished_before": finished_before,
        "times": times,
        "columns": columns,
        "stale": stale, "blocked": blocked,
        "people": people, "labels": labels, "priority": priority, "statuses": statuses,
        "flow": flow,
    }))
}

/// Hourly: today's number of cards in each column of every active board (for the cumulative flow chart). Kept for
/// two years.
pub fn spawn_snapshots(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            tick.tick().await;
            let tz = tz(&state.db).await;
            let res = sqlx::query(
                "INSERT INTO board_daily_columns (board_id, day, list_id, cards)
                 SELECT l.board_id, (now() AT TIME ZONE $1)::date, l.id, count(c.id)
                 FROM lists l JOIN boards b ON b.id = l.board_id AND b.archived_at IS NULL
                 LEFT JOIN cards c ON c.list_id = l.id AND c.archived_at IS NULL
                 WHERE l.archived_at IS NULL
                 GROUP BY l.board_id, l.id
                 ON CONFLICT (board_id, day, list_id) DO UPDATE SET cards = EXCLUDED.cards",
            )
            .bind(&tz)
            .execute(&state.db)
            .await;
            if let Err(e) = res {
                tracing::warn!(error = %e, "column snapshot failed");
                crate::metrics::job_failed("column_snapshots");
            }
            let _ = sqlx::query("DELETE FROM board_daily_columns WHERE day < (now() - interval '2 years')::date").execute(&state.db).await;
        }
    });
}
