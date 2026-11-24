//! Recurring cards: "every Monday at 09:00, create a card from the template ‘Weekly report’ in To Do".
//! Daily / weekly (chosen weekdays) / monthly (day of month; 31 = last day of shorter months), every N periods,
//! at a server-local time. A background job checks every minute. Managed with "Manage card templates".

use axum::{
    Json,
    extract::{Path, State},
};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::CurrentUser,
    error::{AppError, AppResult},
    perms::{self, board_access},
};

#[derive(Serialize, sqlx::FromRow, Clone)]
pub struct Recurrence {
    pub id: Uuid,
    pub template_id: Uuid,
    pub list_id: Uuid,
    pub freq: String,
    pub every: i32,
    pub weekdays: Vec<i16>,
    pub month_day: Option<i16>,
    pub at_time: NaiveTime,
    pub anchor: NaiveDate,
    pub assignee_ids: Vec<Uuid>,
    pub enabled: bool,
    pub next_run_at: Option<DateTime<Utc>>,
    pub last_run_at: Option<DateTime<Utc>>,
}

const COLS: &str = "id, template_id, list_id, freq, every, weekdays, month_day, at_time, anchor, assignee_ids, enabled, next_run_at, last_run_at";

fn days_in_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1).unwrap().pred_opt().unwrap().day()
}

/// Does the rule fire on this day?
fn matches(r: &Recurrence, d: NaiveDate) -> bool {
    if d < r.anchor {
        return false;
    }
    let every = r.every.max(1) as i64;
    match r.freq.as_str() {
        "daily" => (d - r.anchor).num_days() % every == 0,
        "weekly" => {
            let wd = d.weekday().number_from_monday() as i16;
            let monday = r.anchor - Duration::days(r.anchor.weekday().num_days_from_monday() as i64);
            r.weekdays.contains(&wd) && ((d - monday).num_days() / 7) % every == 0
        }
        "monthly" => {
            let want = r.month_day.unwrap_or(1).clamp(1, 31) as u32;
            let months = (d.year() - r.anchor.year()) as i64 * 12 + d.month() as i64 - r.anchor.month() as i64;
            d.day() == want.min(days_in_month(d.year(), d.month())) && months % every == 0
        }
        _ => false,
    }
}

/// First firing strictly after `after` (server-local time), within ~3 years.
pub fn next_after(r: &Recurrence, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let start = after.with_timezone(&Local).date_naive().max(r.anchor);
    for i in 0..1200 {
        let d = start + Duration::days(i);
        if !matches(r, d) {
            continue;
        }
        let local = Local.from_local_datetime(&d.and_time(r.at_time)).earliest()?;
        let t = local.with_timezone(&Utc);
        if t > after {
            return Some(t);
        }
    }
    None
}

#[derive(Deserialize)]
pub struct Req {
    template_id: Option<Uuid>,
    list_id: Option<Uuid>,
    freq: Option<String>,
    every: Option<i32>,
    weekdays: Option<Vec<i16>>,
    month_day: Option<Option<i16>>,
    /// "HH:MM"
    at_time: Option<String>,
    assignee_ids: Option<Vec<Uuid>>,
    enabled: Option<bool>,
}

async fn manage(state: &AppState, u: &crate::auth::User, board_id: Uuid) -> AppResult<()> {
    board_access(&state.db, u, board_id).await?.require(perms::TEMPLATES_MANAGE)
}

/// Saving a rule: managing templates, plus being allowed to add cards to the column it fills.
async fn manage_rule(state: &AppState, u: &crate::auth::User, board_id: Uuid, list_id: Option<Uuid>) -> AppResult<()> {
    let access = board_access(&state.db, u, board_id).await?;
    access.require(perms::TEMPLATES_MANAGE)?;
    match list_id {
        Some(l) => access.require_create_in(l),
        None => Ok(()),
    }
}

pub async fn for_board(db: &sqlx::PgPool, board_id: Uuid) -> AppResult<Vec<Recurrence>> {
    Ok(sqlx::query_as(sqlf!("SELECT {COLS} FROM card_recurrences WHERE board_id = $1 ORDER BY created_at")).bind(board_id).fetch_all(db).await?)
}

pub async fn list(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(board_id): Path<Uuid>) -> AppResult<Json<Vec<Recurrence>>> {
    board_access(&state.db, &u, board_id).await?;
    Ok(Json(for_board(&state.db, board_id).await?))
}

/// Validates and fills a rule; returns it with the next run computed.
async fn build(state: &AppState, board_id: Uuid, mut r: Recurrence, req: Req) -> AppResult<Recurrence> {
    if let Some(t) = req.template_id {
        r.template_id = t;
    }
    if let Some(l) = req.list_id {
        r.list_id = l;
    }
    if let Some(f) = req.freq {
        r.freq = f;
    }
    if let Some(e) = req.every {
        r.every = e;
    }
    if let Some(w) = req.weekdays {
        r.weekdays = w;
    }
    if let Some(m) = req.month_day {
        r.month_day = m;
    }
    if let Some(t) = req.at_time {
        r.at_time = NaiveTime::parse_from_str(t.trim(), "%H:%M").map_err(|_| AppError::BadRequest("invalid_time"))?;
    }
    if let Some(a) = req.assignee_ids {
        r.assignee_ids = a;
    }
    if let Some(e) = req.enabled {
        r.enabled = e;
    }
    if !["daily", "weekly", "monthly"].contains(&r.freq.as_str()) || !(1..=99).contains(&r.every) {
        return Err(AppError::BadRequest("invalid_schedule"));
    }
    r.weekdays.retain(|d| (1..=7).contains(d));
    r.weekdays.sort();
    r.weekdays.dedup();
    if r.freq == "weekly" && r.weekdays.is_empty() {
        return Err(AppError::BadRequest("invalid_schedule"));
    }
    if r.freq == "monthly" && !r.month_day.is_some_and(|d| (1..=31).contains(&d)) {
        return Err(AppError::BadRequest("invalid_schedule"));
    }
    let ok: Option<(Uuid,)> = sqlx::query_as(
        "SELECT t.id FROM card_templates t JOIN lists l ON l.id = $2 AND l.board_id = t.board_id AND l.archived_at IS NULL
         WHERE t.id = $1 AND t.board_id = $3",
    )
    .bind(r.template_id)
    .bind(r.list_id)
    .bind(board_id)
    .fetch_optional(&state.db)
    .await?;
    if ok.is_none() {
        return Err(AppError::BadRequest("invalid_template"));
    }
    let members: Vec<(Uuid,)> = sqlx::query_as("SELECT user_id FROM board_members WHERE board_id = $1 AND user_id = ANY($2)")
        .bind(board_id)
        .bind(&r.assignee_ids)
        .fetch_all(&state.db)
        .await?;
    r.assignee_ids = members.into_iter().map(|m| m.0).collect();
    r.next_run_at = if r.enabled { next_after(&r, Utc::now()) } else { None };
    Ok(r)
}

pub async fn create(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(board_id): Path<Uuid>, Json(req): Json<Req>) -> AppResult<Json<Recurrence>> {
    manage_rule(&state, &u, board_id, req.list_id).await?;
    let blank = Recurrence {
        id: Uuid::now_v7(),
        template_id: Uuid::nil(),
        list_id: Uuid::nil(),
        freq: "weekly".into(),
        every: 1,
        weekdays: vec![],
        month_day: None,
        at_time: NaiveTime::from_hms_opt(9, 0, 0).unwrap(),
        anchor: Local::now().date_naive(),
        assignee_ids: vec![],
        enabled: true,
        next_run_at: None,
        last_run_at: None,
    };
    let r = build(&state, board_id, blank, req).await?;
    let saved: Recurrence = sqlx::query_as(sqlf!(
        "INSERT INTO card_recurrences (id, board_id, template_id, list_id, freq, every, weekdays, month_day, at_time, anchor, assignee_ids, enabled, next_run_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING {COLS}"
    ))
    .bind(r.id)
    .bind(board_id)
    .bind(r.template_id)
    .bind(r.list_id)
    .bind(&r.freq)
    .bind(r.every)
    .bind(&r.weekdays)
    .bind(r.month_day)
    .bind(r.at_time)
    .bind(r.anchor)
    .bind(&r.assignee_ids)
    .bind(r.enabled)
    .bind(r.next_run_at)
    .bind(u.id)
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(board_id, "template", None, u.id);
    Ok(Json(saved))
}

async fn load(state: &AppState, id: Uuid) -> AppResult<(Uuid, Recurrence)> {
    let (board_id,): (Uuid,) = sqlx::query_as("SELECT board_id FROM card_recurrences WHERE id = $1").bind(id).fetch_one(&state.db).await?;
    let r: Recurrence = sqlx::query_as(sqlf!("SELECT {COLS} FROM card_recurrences WHERE id = $1")).bind(id).fetch_one(&state.db).await?;
    Ok((board_id, r))
}

pub async fn update(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, Json(req): Json<Req>) -> AppResult<Json<Recurrence>> {
    let (board_id, old) = load(&state, id).await?;
    manage_rule(&state, &u, board_id, req.list_id).await?;
    let r = build(&state, board_id, old, req).await?;
    let saved: Recurrence = sqlx::query_as(sqlf!(
        "UPDATE card_recurrences SET template_id = $2, list_id = $3, freq = $4, every = $5, weekdays = $6, month_day = $7,
                at_time = $8, assignee_ids = $9, enabled = $10, next_run_at = $11
         WHERE id = $1 RETURNING {COLS}"
    ))
    .bind(id)
    .bind(r.template_id)
    .bind(r.list_id)
    .bind(&r.freq)
    .bind(r.every)
    .bind(&r.weekdays)
    .bind(r.month_day)
    .bind(r.at_time)
    .bind(&r.assignee_ids)
    .bind(r.enabled)
    .bind(r.next_run_at)
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(board_id, "template", None, u.id);
    Ok(Json(saved))
}

pub async fn delete(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let (board_id, _) = load(&state, id).await?;
    manage(&state, &u, board_id).await?;
    sqlx::query("DELETE FROM card_recurrences WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(board_id, "template", None, u.id);
    Ok(Json(json!({ "ok": true })))
}

// ---------- the job ----------

pub fn spawn_job(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tick.tick().await;
            if let Err(e) = run_due(&state).await {
                tracing::warn!(error = %e, "recurring cards job failed");
                crate::metrics::job_failed("recurring_cards");
            }
        }
    });
}

async fn run_due(state: &AppState) -> anyhow::Result<()> {
    // claim each due rule by moving its next run forward first, so two servers never create the same card twice
    let due: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT r.id FROM card_recurrences r JOIN boards b ON b.id = r.board_id
         WHERE r.enabled AND r.next_run_at <= now() AND b.archived_at IS NULL ORDER BY r.next_run_at LIMIT 100",
    )
    .fetch_all(&state.db)
    .await?;
    for (id,) in due {
        let row: Option<(Uuid, Option<Uuid>)> = sqlx::query_as("SELECT board_id, created_by FROM card_recurrences WHERE id = $1").bind(id).fetch_optional(&state.db).await?;
        let Some((board_id, created_by)) = row else { continue };
        let r: Recurrence = sqlx::query_as(sqlf!("SELECT {COLS} FROM card_recurrences WHERE id = $1")).bind(id).fetch_one(&state.db).await?;
        let Some(when) = r.next_run_at else { continue };
        // missed runs (server was down) collapse into one card, then the schedule continues from now
        let next = next_after(&r, Utc::now().max(when));
        let claimed = sqlx::query("UPDATE card_recurrences SET next_run_at = $2, last_run_at = now() WHERE id = $1 AND next_run_at = $3")
            .bind(id)
            .bind(next)
            .bind(when)
            .execute(&state.db)
            .await?
            .rows_affected()
            == 1;
        if !claimed {
            continue;
        }
        let Ok((_, t)) = crate::templates::get(&state.db, r.template_id).await else { continue };
        // the card is made "by" whoever set up the schedule (or a board owner if they're gone)
        let actor: Option<(Uuid,)> = match created_by {
            Some(c) => Some((c,)),
            None => sqlx::query_as("SELECT m.user_id FROM board_members m JOIN board_roles ro ON ro.id = m.role_id WHERE m.board_id = $1 AND ro.is_owner LIMIT 1")
                .bind(board_id)
                .fetch_optional(&state.db)
                .await?,
        };
        let Some((actor,)) = actor else { continue };
        let due_at = t.due_in_days.map(|d| {
            let day = Local::now().date_naive() + Duration::days(d as i64);
            Local.from_local_datetime(&day.and_time(r.at_time)).earliest().map(|x| x.with_timezone(&Utc)).unwrap_or_else(Utc::now)
        });
        match crate::cards::insert_card(state, board_id, r.list_id, actor, &t.title, &t.description, due_at, Some(&t), false, &r.assignee_ids, json!({ "recurring": true })).await {
            Ok(card_id) => {
                sqlx::query("UPDATE card_recurrences SET last_card_id = $2 WHERE id = $1").bind(id).bind(card_id).execute(&state.db).await?;
                state.hub.notify(board_id, "card", Some(card_id), actor);
                let others: Vec<Uuid> = r.assignee_ids.iter().copied().filter(|a| *a != actor).collect();
                crate::notify::send(state, &others, "assigned", board_id, Some(card_id), Some(actor), json!({})).await;
                tracing::info!(recurrence = %id, card = %card_id, "recurring card created");
            }
            Err(e) => tracing::warn!(recurrence = %id, error = %e, "recurring card could not be created"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    fn rule(freq: &str, every: i32, weekdays: Vec<i16>, month_day: Option<i16>, anchor: (i32, u32, u32)) -> Recurrence {
        Recurrence {
            id: Uuid::nil(),
            template_id: Uuid::nil(),
            list_id: Uuid::nil(),
            freq: freq.into(),
            every,
            weekdays,
            month_day,
            at_time: NaiveTime::from_hms_opt(9, 0, 0).unwrap(),
            anchor: NaiveDate::from_ymd_opt(anchor.0, anchor.1, anchor.2).unwrap(),
            assignee_ids: vec![],
            enabled: true,
            next_run_at: None,
            last_run_at: None,
        }
    }
    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn schedules() {
        // every 2 days from Nov 1
        let r = rule("daily", 2, vec![], None, (2026, 11, 1));
        assert!(matches(&r, d(2026, 11, 3)) && !matches(&r, d(2026, 11, 4)) && !matches(&r, d(2026, 10, 30)));
        // Mon + Fri every other week (anchor Wed Nov 4 2026 → week of Mon Nov 2)
        let r = rule("weekly", 2, vec![1, 5], None, (2026, 11, 4));
        assert!(matches(&r, d(2026, 11, 6)) && !matches(&r, d(2026, 11, 9)) && matches(&r, d(2026, 11, 16)) && !matches(&r, d(2026, 11, 2)));
        // the 31st → last day of shorter months
        let r = rule("monthly", 1, vec![], Some(31), (2026, 1, 1));
        assert!(matches(&r, d(2026, 2, 28)) && matches(&r, d(2026, 4, 30)) && matches(&r, d(2026, 5, 31)) && !matches(&r, d(2026, 5, 30)));
        // quarterly on the 1st
        let r = rule("monthly", 3, vec![], Some(1), (2026, 1, 15));
        assert!(matches(&r, d(2026, 4, 1)) && !matches(&r, d(2026, 2, 1)) && matches(&r, d(2026, 7, 1)));
        // next_after is strictly later and lands on 09:00 local
        let r = rule("daily", 1, vec![], None, (2026, 1, 1));
        let now = Local.with_ymd_and_hms(2026, 3, 10, 9, 0, 0).unwrap().with_timezone(&Utc);
        let n = next_after(&r, now).unwrap().with_timezone(&Local);
        assert_eq!((n.day(), n.hour()), (11, 9));
    }
}
