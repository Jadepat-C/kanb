//! Cards, card activity log ("chatter") and comments.

use axum::{
    Json,
    extract::{Path, State},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    AppState,
    auth::CurrentUser,
    boards::{double_option, position_at, touch_board},
    error::{AppError, AppResult},
    perms::{self, board_access, board_of_card, board_of_list},
};

#[derive(Serialize, sqlx::FromRow)]
pub struct CardSummary {
    pub id: Uuid,
    pub list_id: Uuid,
    pub number: i32,
    pub title: String,
    pub position: String,
    pub priority: i16,
    pub status_id: Option<Uuid>,
    pub color: Option<String>,
    pub start_at: Option<DateTime<Utc>>,
    pub due_at: Option<DateTime<Utc>>,
    /// "due soon" reminder, minutes before the due date (None = 1 day, 0 = none)
    pub remind_minutes: Option<i32>,
    /// status counts as done
    pub done: bool,
    pub done_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub label_ids: Vec<Uuid>,
    /// cards this one waits for (finish-to-start)
    pub depends_on: Vec<Uuid>,
    pub assignee_ids: Vec<Uuid>,
    pub comment_count: i64,
    pub attachment_count: i64,
    /// for "only cards they created" roles
    pub created_by: Option<Uuid>,
    /// time tracking: the estimate, and the time logged so far (finished entries)
    pub estimate_minutes: Option<i32>,
    pub time_minutes: i64,
    #[sqlx(skip)]
    pub excerpt: String,
    #[sqlx(skip)]
    pub checklist_total: u32,
    #[sqlx(skip)]
    pub checklist_done: u32,
    #[serde(skip)]
    pub description: String,
}

/// shown user name, see auth::DISPLAY_NAME_SQL
const DN: &str = crate::auth::DISPLAY_NAME_SQL;

const SUMMARY_SELECT: &str = r#"
SELECT c.id, c.list_id, c.number, c.title, c.position, c.priority, c.status_id, c.color, c.start_at, c.due_at, c.remind_minutes, c.updated_at, c.description, c.done_at, c.created_by,
  COALESCE((SELECT is_done FROM board_statuses WHERE id = c.status_id), false) AS done,
  COALESCE((SELECT array_agg(d.depends_on) FROM card_dependencies d JOIN cards x ON x.id = d.depends_on AND x.archived_at IS NULL WHERE d.card_id = c.id), '{}') AS depends_on,
  COALESCE((SELECT array_agg(label_id) FROM card_labels WHERE card_id = c.id), '{}') AS label_ids,
  COALESCE((SELECT array_agg(user_id) FROM card_assignees WHERE card_id = c.id), '{}') AS assignee_ids,
  (SELECT count(*) FROM comments WHERE card_id = c.id AND deleted_at IS NULL) AS comment_count,
  (SELECT count(*) FROM attachments WHERE card_id = c.id AND deleted_at IS NULL AND NOT is_inline) AS attachment_count,
  c.estimate_minutes,
  COALESCE((SELECT sum(minutes) FROM time_entries WHERE card_id = c.id AND ended_at IS NOT NULL), 0)::int8 AS time_minutes
FROM cards c
"#;

/// Excerpt for hover previews: first ~400 chars of the markdown, cut at a line end when possible.
fn excerpt(md: &str) -> String {
    const MAX: usize = 400;
    if md.chars().count() <= MAX {
        return md.to_string();
    }
    let cut: String = md.chars().take(MAX).collect();
    match cut.rfind('\n') {
        Some(i) if i > MAX / 2 => format!("{}\n…", &cut[..i]),
        _ => format!("{cut}…"),
    }
}

/// Markdown task lists double as checklists: counts `- [ ]` / `- [x]` items.
pub fn checklist(md: &str) -> (u32, u32) {
    let (mut total, mut done) = (0, 0);
    for line in md.lines() {
        let t = line.trim_start();
        let rest = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).or_else(|| t.strip_prefix("+ "));
        if let Some(r) = rest {
            if r.starts_with("[ ]") {
                total += 1;
            } else if r.starts_with("[x]") || r.starts_with("[X]") {
                total += 1;
                done += 1;
            }
        }
    }
    (total, done)
}

fn finish(mut c: CardSummary) -> CardSummary {
    let (t, d) = checklist(&c.description);
    c.checklist_total = t;
    c.checklist_done = d;
    c.excerpt = excerpt(&c.description);
    c
}

pub async fn load_card_summaries(db: &PgPool, board_id: Uuid, card_id: Option<Uuid>) -> AppResult<Vec<CardSummary>> {
    let rows: Vec<CardSummary> = sqlx::query_as(sqlf!(
        r#"{SUMMARY_SELECT} WHERE c.board_id = $1 AND c.archived_at IS NULL AND ($2::uuid IS NULL OR c.id = $2)
             AND EXISTS (SELECT 1 FROM lists l WHERE l.id = c.list_id AND l.archived_at IS NULL)
           ORDER BY c.position COLLATE "C""#
    ))
    .bind(board_id)
    .bind(card_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(finish).collect())
}

/// done_at follows the card's status (set when it is a "done" status, cleared otherwise).
pub async fn sync_done(tx: &mut Transaction<'_, Postgres>, card_id: Uuid) -> AppResult<()> {
    sqlx::query(
        "UPDATE cards c SET done_at = CASE WHEN s.is_done THEN COALESCE(c.done_at, now()) END
         FROM cards x LEFT JOIN board_statuses s ON s.id = x.status_id WHERE x.id = c.id AND c.id = $1",
    )
    .bind(card_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn log_event(
    tx: &mut Transaction<'_, Postgres>,
    card_id: Uuid,
    board_id: Uuid,
    actor: Uuid,
    kind: &str,
    data: Value,
) -> AppResult<()> {
    sqlx::query("INSERT INTO card_events (card_id, board_id, actor_id, kind, data) VALUES ($1,$2,$3,$4,$5)")
        .bind(card_id)
        .bind(board_id)
        .bind(actor)
        .bind(kind)
        .bind(data)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

// ---------- create ----------

#[derive(Deserialize)]
pub struct CreateCard {
    title: String,
    #[serde(default)]
    description: String,
    /// "top" or "bottom" (default)
    #[serde(default)]
    at: Option<String>,
    /// e.g. when created from the calendar
    due_at: Option<DateTime<Utc>>,
    /// start from a card template (title/description fall back to the template's)
    template_id: Option<Uuid>,
}

pub async fn create_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(list_id): Path<Uuid>,
    Json(r): Json<CreateCard>,
) -> AppResult<Json<CardSummary>> {
    let board_id = board_of_list(&state.db, list_id).await?;
    board_access(&state.db, &u, board_id).await?.require_create_in(list_id)?;
    let tpl = match r.template_id {
        Some(tid) => {
            let (tb, t) = crate::templates::get(&state.db, tid).await?;
            if tb != board_id {
                return Err(AppError::BadRequest("invalid_template"));
            }
            Some(t)
        }
        None => None,
    };
    let title = if r.title.trim().is_empty() { tpl.as_ref().map(|t| t.title.trim()).unwrap_or("") } else { r.title.trim() };
    if title.is_empty() {
        return Err(AppError::BadRequest("title_required"));
    }
    let description = if r.description.is_empty() { tpl.as_ref().map(|t| t.description.clone()).unwrap_or_default() } else { r.description.clone() };
    let id = insert_card(&state, board_id, list_id, u.id, title, &description, r.due_at, tpl.as_ref(), r.at.as_deref() == Some("top"), &[], json!({})).await?;
    state.hub.notify(board_id, "card", Some(id), u.id);
    let card = load_card_summaries(&state.db, board_id, Some(id)).await?.pop().ok_or(AppError::NotFound)?;
    Ok(Json(card))
}

/// Creates a card at the end (or top) of a column: the next number, a position, the board's first status unless the
/// template says otherwise, the template's labels, optional assignees, and a "created" history entry.
#[allow(clippy::too_many_arguments)]
pub async fn insert_card(
    state: &AppState,
    board_id: Uuid,
    list_id: Uuid,
    actor: Uuid,
    title: &str,
    description: &str,
    due_at: Option<DateTime<Utc>>,
    tpl: Option<&crate::templates::Template>,
    top: bool,
    assignees: &[Uuid],
    extra: Value,
) -> AppResult<Uuid> {
    let mut tx = state.db.begin().await?;
    let (number,): (i32,) = sqlx::query_as("UPDATE boards SET card_seq = card_seq + 1, updated_at = now() WHERE id = $1 RETURNING card_seq")
        .bind(board_id)
        .fetch_one(&mut *tx)
        .await?;
    // serialize inserts into the same list so two concurrent drops can't get the same position key
    sqlx::query("SELECT 1 FROM lists WHERE id = $1 FOR UPDATE").bind(list_id).execute(&mut *tx).await?;
    let keys: Vec<(String,)> =
        sqlx::query_as(r#"SELECT position FROM cards WHERE list_id = $1 AND archived_at IS NULL ORDER BY position COLLATE "C""#)
            .bind(list_id)
            .fetch_all(&mut *tx)
            .await?;
    let keys: Vec<String> = keys.into_iter().map(|k| k.0).collect();
    let index = if top { 0 } else { keys.len() };
    let pos = position_at(&keys, index);
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO cards (id, board_id, list_id, number, title, description, position, created_by, due_at, priority, status_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                 COALESCE($11, (SELECT id FROM board_statuses WHERE board_id = $2 ORDER BY position, name LIMIT 1)))",
    )
    .bind(id)
    .bind(board_id)
    .bind(list_id)
    .bind(number)
    .bind(title)
    .bind(description)
    .bind(pos)
    .bind(actor)
    .bind(due_at)
    .bind(tpl.as_ref().map(|t| t.priority).unwrap_or(0))
    .bind(tpl.as_ref().and_then(|t| t.status_id))
    .execute(&mut *tx)
    .await?;
    if let Some(t) = tpl {
        sqlx::query(
            "INSERT INTO card_labels (card_id, label_id) SELECT $1, l.id FROM labels l WHERE l.board_id = $2 AND l.id = ANY($3)",
        )
        .bind(id)
        .bind(board_id)
        .bind(&t.label_ids)
        .execute(&mut *tx)
        .await?;
    }
    sync_done(&mut tx, id).await?;
    let (list_name,): (String,) = sqlx::query_as("SELECT name FROM lists WHERE id = $1").bind(list_id).fetch_one(&mut *tx).await?;
    for a in assignees {
        sqlx::query("INSERT INTO card_assignees (card_id, user_id) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM board_members WHERE board_id = $3 AND user_id = $2) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(a)
            .bind(board_id)
            .execute(&mut *tx)
            .await?;
    }
    let mut data = json!({ "list": list_name });
    if let (Some(d), Some(extra)) = (data.as_object_mut(), extra.as_object()) {
        d.extend(extra.clone());
    }
    log_event(&mut tx, id, board_id, actor, "created", data).await?;
    tx.commit().await?;
    Ok(id)
}

// ---------- detail ----------

#[derive(Serialize, sqlx::FromRow)]
pub struct Card {
    id: Uuid,
    board_id: Uuid,
    list_id: Uuid,
    number: i32,
    title: String,
    description: String,
    priority: i16,
    status_id: Option<Uuid>,
    color: Option<String>,
    start_at: Option<DateTime<Utc>>,
    due_at: Option<DateTime<Utc>>,
    remind_minutes: Option<i32>,
    done_at: Option<DateTime<Utc>>,
    created_by: Option<Uuid>,
    #[sqlx(default)]
    created_by_name: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    label_ids: Vec<Uuid>,
    assignee_ids: Vec<Uuid>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Attachment {
    pub id: Uuid,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub is_inline: bool,
    pub uploaded_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    /// shown name (deleted accounts read "[Deleted User] Name (username)")
    #[sqlx(default)]
    pub uploaded_by_name: Option<String>,
}

#[derive(Serialize)]
pub struct CardDetail {
    card: Card,
    attachments: Vec<Attachment>,
    /// I watch this card (notified about it as if it were mine)
    watching: bool,
}

pub async fn get_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<CardDetail>> {
    let board_id = board_of_card(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?;
    let card: Card = sqlx::query_as(sqlf!(
        "SELECT c.id, c.board_id, c.list_id, c.number, c.title, c.description, c.priority, c.status_id, c.color, c.start_at, c.due_at, c.remind_minutes, c.done_at,
                c.created_by, (SELECT {DN} FROM users u WHERE u.id = c.created_by) AS created_by_name, c.created_at, c.updated_at,
                COALESCE((SELECT array_agg(label_id) FROM card_labels WHERE card_id = c.id), '{{}}') AS label_ids,
                COALESCE((SELECT array_agg(user_id) FROM card_assignees WHERE card_id = c.id), '{{}}') AS assignee_ids
         FROM cards c WHERE c.id = $1"
    ))
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    let attachments: Vec<Attachment> = sqlx::query_as(
        sqlf!(
            "SELECT a.id, a.filename, a.content_type, a.size, a.is_inline, a.uploaded_by, a.created_at, {DN} AS uploaded_by_name
             FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
             WHERE a.card_id = $1 AND a.deleted_at IS NULL AND NOT a.is_inline ORDER BY a.created_at"
        ),
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let (watching,): (bool,) = sqlx::query_as("SELECT EXISTS (SELECT 1 FROM card_watchers WHERE card_id = $1 AND user_id = $2)")
        .bind(id)
        .bind(u.id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(CardDetail { card, attachments, watching }))
}

#[derive(Deserialize)]
pub struct WatchReq {
    watching: bool,
}

/// Watch a card (or stop): anyone who can see it. Watchers hear about it like its assignees do, for the kinds they
/// chose in Profile → Notifications, while they're on the board.
pub async fn watch(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<WatchReq>,
) -> AppResult<Json<serde_json::Value>> {
    let board_id = board_of_card(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?;
    let q = if r.watching {
        "INSERT INTO card_watchers (card_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"
    } else {
        "DELETE FROM card_watchers WHERE card_id = $1 AND user_id = $2"
    };
    sqlx::query(q).bind(id).bind(u.id).execute(&state.db).await?;
    Ok(Json(json!({ "watching": r.watching })))
}

// ---------- update ----------

#[derive(Deserialize)]
pub struct UpdateCard {
    title: Option<String>,
    description: Option<String>,
    priority: Option<i16>,
    #[serde(default, deserialize_with = "double_option")]
    status_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "double_option")]
    color: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    due_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "double_option")]
    start_at: Option<Option<DateTime<Utc>>>,
    /// null = the default (1 day before), 0 = no reminder
    #[serde(default, deserialize_with = "double_option")]
    remind_minutes: Option<Option<i32>>,
    /// time tracking: null = no estimate
    #[serde(default, deserialize_with = "double_option")]
    estimate_minutes: Option<Option<i32>>,
}

#[derive(sqlx::FromRow)]
struct CardRow {
    title: String,
    description: String,
    priority: i16,
    status_id: Option<Uuid>,
    color: Option<String>,
    due_at: Option<DateTime<Utc>>,
    start_at: Option<DateTime<Utc>>,
}

pub async fn update_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<UpdateCard>,
) -> AppResult<Json<CardSummary>> {
    crate::boards::check_color(r.color.as_ref().and_then(|c| c.as_deref()))?;
    let (board_id, creator) = perms::card_owner(&state.db, id).await?;
    // each kind of change has its own permission
    let access = board_access(&state.db, &u, board_id).await?;
    if r.title.is_some() || r.description.is_some() || r.priority.is_some() || r.color.is_some() || r.estimate_minutes.is_some() {
        access.require_on(perms::CARDS_EDIT, creator)?;
    }
    if r.estimate_minutes.flatten().is_some_and(|m| !(0..=1_000_000).contains(&m)) {
        return Err(AppError::BadRequest("invalid_estimate"));
    }
    if r.status_id.is_some() {
        access.require_on(perms::CARDS_STATUS, creator)?;
    }
    if r.due_at.is_some() || r.start_at.is_some() || r.remind_minutes.is_some() {
        access.require_on(perms::CARDS_DUE, creator)?;
    }
    if r.remind_minutes.flatten().is_some_and(|m| !(0..=43200).contains(&m)) {
        return Err(AppError::BadRequest("invalid_reminder"));
    }
    if r.title.as_deref().is_some_and(|t| t.trim().is_empty()) {
        return Err(AppError::BadRequest("title_required"));
    }
    if r.priority.is_some_and(|p| !(0..=3).contains(&p)) {
        return Err(AppError::BadRequest("invalid_priority"));
    }
    if let Some(Some(sid)) = r.status_id {
        let ok: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM board_statuses WHERE id = $1 AND board_id = $2")
            .bind(sid)
            .bind(board_id)
            .fetch_optional(&state.db)
            .await?;
        if ok.is_none() {
            return Err(AppError::BadRequest("invalid_status"));
        }
    }
    let r_description = r.description.clone(); // kept for @mention notifications after the update
    let mut tx = state.db.begin().await?;
    let old: CardRow =
        sqlx::query_as("SELECT title, description, priority, status_id, color, due_at, start_at FROM cards WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let title = r.title.map(|t| t.trim().to_string());
    if let Some(t) = &title
        && *t != old.title
    {
        log_event(&mut tx, id, board_id, u.id, "title", json!({ "from": old.title, "to": t })).await?;
    }
    if let Some(d) = &r.description
        && *d != old.description
    {
        // Consecutive description edits by the same person within 10 minutes collapse into one log entry.
        let merged = sqlx::query(
            "UPDATE card_events SET created_at = now() WHERE id = (
                SELECT id FROM card_events WHERE card_id = $1 ORDER BY id DESC LIMIT 1)
             AND kind = 'description' AND actor_id = $2 AND created_at > now() - interval '10 minutes'",
        )
        .bind(id)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
        if merged.rows_affected() == 0 {
            log_event(&mut tx, id, board_id, u.id, "description", json!({})).await?;
        }
    }
    if let Some(p) = r.priority
        && p != old.priority
    {
        log_event(&mut tx, id, board_id, u.id, "priority", json!({ "from": old.priority, "to": p })).await?;
    }
    if let Some(s) = r.status_id
        && s != old.status_id
    {
        // log names (not ids) so the history still reads right after a status is renamed or deleted
        let names: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, name FROM board_statuses WHERE board_id = $1")
            .bind(board_id)
            .fetch_all(&mut *tx)
            .await?;
        let name = |x: Option<Uuid>| x.and_then(|x| names.iter().find(|n| n.0 == x).map(|n| n.1.clone()));
        log_event(&mut tx, id, board_id, u.id, "status", json!({ "from": name(old.status_id), "to": name(s) })).await?;
    }
    if let Some(c) = &r.color
        && *c != old.color
    {
        log_event(&mut tx, id, board_id, u.id, "color", json!({ "from": old.color, "to": c })).await?;
    }
    if let Some(d) = &r.due_at
        && *d != old.due_at
    {
        log_event(&mut tx, id, board_id, u.id, "due", json!({ "from": old.due_at, "to": d })).await?;
    }
    if let Some(d) = &r.start_at
        && *d != old.start_at
    {
        log_event(&mut tx, id, board_id, u.id, "start", json!({ "from": old.start_at, "to": d })).await?;
    }
    // a card can't start after it's due
    let (start, due) = (r.start_at.unwrap_or(old.start_at), r.due_at.unwrap_or(old.due_at));
    if let (Some(s), Some(d)) = (start, due)
        && s > d
    {
        return Err(AppError::BadRequest("start_after_due"));
    }
    sqlx::query(
        "UPDATE cards SET title = COALESCE($2, title), description = COALESCE($3, description),
            priority = COALESCE($4, priority),
            status_id = CASE WHEN $10 THEN $5 ELSE status_id END,
            color = CASE WHEN $6 THEN $7 ELSE color END,
            due_at = CASE WHEN $8 THEN $9 ELSE due_at END,
            start_at = CASE WHEN $11 THEN $12 ELSE start_at END,
            remind_minutes = CASE WHEN $13 THEN $14 ELSE remind_minutes END,
            estimate_minutes = CASE WHEN $15 THEN $16 ELSE estimate_minutes END,
            done_at = CASE WHEN NOT $10 THEN done_at
                           WHEN EXISTS (SELECT 1 FROM board_statuses s WHERE s.id = $5 AND s.is_done) THEN COALESCE(done_at, now())
                           ELSE NULL END,
            updated_at = now()
         WHERE id = $1",
    )
    .bind(id)
    .bind(title)
    .bind(r.description)
    .bind(r.priority)
    .bind(r.status_id.flatten())
    .bind(r.color.is_some())
    .bind(r.color.flatten())
    .bind(r.due_at.is_some())
    .bind(r.due_at.flatten())
    .bind(r.status_id.is_some())
    .bind(r.start_at.is_some())
    .bind(r.start_at.flatten())
    .bind(r.remind_minutes.is_some())
    .bind(r.remind_minutes.flatten())
    .bind(r.estimate_minutes.is_some())
    .bind(r.estimate_minutes.flatten())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    touch_board(&state, board_id).await?;
    state.hub.notify(board_id, "card", Some(id), u.id);
    if let Some(d) = &r_description {
        let new: std::collections::HashSet<String> =
            crate::notify::mentions(d).difference(&crate::notify::mentions(&old.description)).cloned().collect();
        let mentioned = crate::notify::members_by_username(&state, board_id, &new, u.id).await?;
        let data = json!({ "snippet": crate::notify::snippet(d), "where": "description" });
        crate::notify::send(&state, &mentioned, "mentioned", board_id, Some(id), Some(u.id), data).await;
    }
    let card = load_card_summaries(&state.db, board_id, Some(id)).await?.pop().ok_or(AppError::NotFound)?;
    Ok(Json(card))
}

// ---------- move ----------

#[derive(Deserialize)]
pub struct MoveCard {
    list_id: Uuid,
    /// Target index within the destination list (0-based, computed without the moved card).
    index: usize,
}

pub async fn move_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<MoveCard>,
) -> AppResult<Json<CardSummary>> {
    let (board_id, creator) = perms::card_owner(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require_on(perms::CARDS_MOVE, creator)?;
    if board_of_list(&state.db, r.list_id).await? != board_id {
        return Err(AppError::BadRequest("invalid_list"));
    }
    let mut tx = state.db.begin().await?;
    // serialize inserts into the same list so two concurrent drops can't get the same position key
    sqlx::query("SELECT 1 FROM lists WHERE id = $1 FOR UPDATE").bind(r.list_id).execute(&mut *tx).await?;
    let (from_list,): (Uuid,) = sqlx::query_as("SELECT list_id FROM cards WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let keys: Vec<(String,)> = sqlx::query_as(
        r#"SELECT position FROM cards WHERE list_id = $1 AND id <> $2 AND archived_at IS NULL ORDER BY position COLLATE "C""#,
    )
    .bind(r.list_id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let pos = position_at(&keys.into_iter().map(|k| k.0).collect::<Vec<_>>(), r.index);
    sqlx::query("UPDATE cards SET list_id = $2, position = $3, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(r.list_id)
        .bind(pos)
        .execute(&mut *tx)
        .await?;
    if from_list != r.list_id {
        let names: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, name FROM lists WHERE id = ANY($1)")
            .bind(vec![from_list, r.list_id])
            .fetch_all(&mut *tx)
            .await?;
        let name = |l: Uuid| names.iter().find(|n| n.0 == l).map(|n| n.1.clone()).unwrap_or_default();
        log_event(&mut tx, id, board_id, u.id, "moved", json!({ "from": name(from_list), "to": name(r.list_id) })).await?;
    }
    tx.commit().await?;
    touch_board(&state, board_id).await?;
    state.hub.notify(board_id, "card", Some(id), u.id);
    let card = load_card_summaries(&state.db, board_id, Some(id)).await?.pop().ok_or(AppError::NotFound)?;
    Ok(Json(card))
}

pub async fn archive_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let (board_id, creator) = perms::card_owner(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require_on(perms::CARDS_ARCHIVE, creator)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE cards SET archived_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    log_event(&mut tx, id, board_id, u.id, "archived", json!({})).await?;
    tx.commit().await?;
    state.hub.notify(board_id, "card", Some(id), u.id);
    Ok(Json(json!({ "ok": true })))
}

// ---------- labels & assignees ----------

#[derive(Deserialize)]
pub struct IdsReq {
    ids: Vec<Uuid>,
}

pub async fn set_labels(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<IdsReq>,
) -> AppResult<Json<Value>> {
    let (board_id, creator) = perms::card_owner(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require_on(perms::CARDS_LABELS, creator)?;
    let mut tx = state.db.begin().await?;
    let valid: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, name FROM labels WHERE board_id = $1")
        .bind(board_id)
        .fetch_all(&mut *tx)
        .await?;
    let current: Vec<(Uuid,)> = sqlx::query_as("SELECT label_id FROM card_labels WHERE card_id = $1").bind(id).fetch_all(&mut *tx).await?;
    let current: Vec<Uuid> = current.into_iter().map(|c| c.0).collect();
    let wanted: Vec<Uuid> = r.ids.into_iter().filter(|i| valid.iter().any(|v| v.0 == *i)).collect();
    let name = |l: &Uuid| valid.iter().find(|v| v.0 == *l).map(|v| v.1.clone()).unwrap_or_default();
    let added: Vec<String> = wanted.iter().filter(|w| !current.contains(w)).map(name).collect();
    let removed: Vec<String> = current.iter().filter(|c| !wanted.contains(c)).map(name).collect();
    sqlx::query("DELETE FROM card_labels WHERE card_id = $1").bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO card_labels (card_id, label_id) SELECT $1, unnest($2::uuid[])")
        .bind(id)
        .bind(&wanted)
        .execute(&mut *tx)
        .await?;
    if !added.is_empty() || !removed.is_empty() {
        log_event(&mut tx, id, board_id, u.id, "labels", json!({ "added": added, "removed": removed })).await?;
    }
    tx.commit().await?;
    state.hub.notify(board_id, "card", Some(id), u.id);
    Ok(Json(json!({ "ok": true })))
}

pub async fn set_assignees(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<IdsReq>,
) -> AppResult<Json<Value>> {
    let (board_id, creator) = perms::card_owner(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require_on(perms::CARDS_ASSIGN, creator)?;
    let mut tx = state.db.begin().await?;
    let valid: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT u.id, u.display_name || ' · @' || u.username FROM board_members m JOIN users u ON u.id = m.user_id WHERE m.board_id = $1",
    )
    .bind(board_id)
    .fetch_all(&mut *tx)
    .await?;
    let current: Vec<(Uuid,)> =
        sqlx::query_as("SELECT user_id FROM card_assignees WHERE card_id = $1").bind(id).fetch_all(&mut *tx).await?;
    let current: Vec<Uuid> = current.into_iter().map(|c| c.0).collect();
    let wanted: Vec<Uuid> = r.ids.into_iter().filter(|i| valid.iter().any(|v| v.0 == *i)).collect();
    let name = |l: &Uuid| valid.iter().find(|v| v.0 == *l).map(|v| v.1.clone()).unwrap_or_default();
    let added_ids: Vec<Uuid> = wanted.iter().filter(|w| !current.contains(w)).copied().collect();
    let added: Vec<String> = wanted.iter().filter(|w| !current.contains(w)).map(name).collect();
    let removed: Vec<String> = current.iter().filter(|c| !wanted.contains(c)).map(name).collect();
    sqlx::query("DELETE FROM card_assignees WHERE card_id = $1").bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO card_assignees (card_id, user_id) SELECT $1, unnest($2::uuid[])")
        .bind(id)
        .bind(&wanted)
        .execute(&mut *tx)
        .await?;
    if !added.is_empty() || !removed.is_empty() {
        log_event(&mut tx, id, board_id, u.id, "assignees", json!({ "added": added, "removed": removed })).await?;
    }
    tx.commit().await?;
    crate::notify::send(&state, &added_ids, "assigned", board_id, Some(id), Some(u.id), json!({})).await;
    state.hub.notify(board_id, "card", Some(id), u.id);
    Ok(Json(json!({ "ok": true })))
}

// ---------- timeline (comments + events) ----------

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TimelineItem {
    Comment {
        id: Uuid,
        author_id: Option<Uuid>,
        author_name: Option<String>,
        author_color: Option<String>,
        author_avatar: Option<Uuid>,
        /// brought in by a board import: `author_name` is the name from the other app, not an account here
        imported: bool,
        body: String,
        created_at: DateTime<Utc>,
        edited: bool,
    },
    Event {
        id: i64,
        actor_id: Option<Uuid>,
        actor_name: Option<String>,
        actor_color: Option<String>,
        actor_avatar: Option<Uuid>,
        kind: String,
        data: Value,
        created_at: DateTime<Utc>,
    },
}

impl TimelineItem {
    fn at(&self) -> DateTime<Utc> {
        match self {
            TimelineItem::Comment { created_at, .. } | TimelineItem::Event { created_at, .. } => *created_at,
        }
    }
}

pub async fn timeline(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Vec<TimelineItem>>> {
    let board_id = board_of_card(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?;
    type C = (Uuid, Option<Uuid>, String, DateTime<Utc>, DateTime<Utc>, Option<String>, Option<String>, Option<Uuid>, bool);
    let comments: Vec<C> = sqlx::query_as(sqlf!(
        "SELECT cm.id, cm.author_id, cm.body, cm.created_at, cm.updated_at, COALESCE({DN}, cm.imported_author), u.avatar_color, u.avatar_id,
                cm.imported_author IS NOT NULL
         FROM comments cm LEFT JOIN users u ON u.id = cm.author_id WHERE cm.card_id = $1 AND cm.deleted_at IS NULL"
    ))
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    type E = (i64, Option<Uuid>, String, Value, DateTime<Utc>, Option<String>, Option<String>, Option<Uuid>);
    let events: Vec<E> =
        sqlx::query_as(sqlf!(
            "SELECT e.id, e.actor_id, e.kind, e.data, e.created_at, {DN}, u.avatar_color, u.avatar_id
             FROM card_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.card_id = $1"
        ))
            .bind(id)
            .fetch_all(&state.db)
            .await?;
    let mut items: Vec<TimelineItem> = comments
        .into_iter()
        .map(|(id, author_id, body, created_at, updated_at, author_name, author_color, author_avatar, imported)| TimelineItem::Comment {
            id,
            author_id,
            author_name,
            author_color,
            author_avatar,
            imported,
            body,
            created_at,
            edited: updated_at > created_at + chrono::Duration::seconds(1),
        })
        .chain(events.into_iter().map(|(id, actor_id, kind, data, created_at, actor_name, actor_color, actor_avatar)| TimelineItem::Event {
            id,
            actor_id,
            actor_name,
            actor_color,
            actor_avatar,
            kind,
            data,
            created_at,
        }))
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.at()));
    Ok(Json(items))
}

#[derive(Deserialize)]
pub struct CommentReq {
    body: String,
}

pub async fn create_comment(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(card_id): Path<Uuid>,
    Json(r): Json<CommentReq>,
) -> AppResult<Json<Value>> {
    let board_id = board_of_card(&state.db, card_id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::COMMENTS_CREATE)?;
    if r.body.trim().is_empty() {
        return Err(AppError::BadRequest("comment_empty"));
    }
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO comments (id, card_id, author_id, body) VALUES ($1,$2,$3,$4)")
        .bind(id)
        .bind(card_id)
        .bind(u.id)
        .bind(r.body.trim_end())
        .execute(&state.db)
        .await?;
    state.hub.notify(board_id, "comment", Some(card_id), u.id);
    let mentioned = crate::notify::members_by_username(&state, board_id, &crate::notify::mentions(&r.body), u.id).await?;
    let data = json!({ "snippet": crate::notify::snippet(&r.body), "where": "comment" });
    crate::board_contacts::comment(&state, board_id, card_id, u.id, crate::notify::snippet(&r.body));
    crate::notify::send(&state, &mentioned, "mentioned", board_id, Some(card_id), Some(u.id), data.clone()).await;
    // assignees, whoever created the card and its watchers, while they're on the board (people already @mentioned
    // get just the mention)
    let watchers: Vec<(Uuid,)> = sqlx::query_as(
        "SELECT x.uid FROM (
             SELECT user_id AS uid FROM card_assignees WHERE card_id = $1
             UNION SELECT created_by FROM cards WHERE id = $1 AND created_by IS NOT NULL
             UNION SELECT user_id FROM card_watchers WHERE card_id = $1
         ) x
         WHERE x.uid IN (SELECT user_id FROM board_members WHERE board_id = $2) OR x.uid IN (SELECT id FROM users WHERE is_super_admin)",
    )
    .bind(card_id)
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    let watchers: Vec<Uuid> = watchers.into_iter().map(|w| w.0).filter(|w| !mentioned.contains(w)).collect();
    crate::notify::send(&state, &watchers, "commented", board_id, Some(card_id), Some(u.id), data).await;
    Ok(Json(json!({ "id": id })))
}

async fn comment_ctx(state: &AppState, id: Uuid) -> AppResult<(Uuid, Uuid, Option<Uuid>)> {
    let row: (Uuid, Uuid, Option<Uuid>) = sqlx::query_as(
        "SELECT c.board_id, c.id, cm.author_id FROM comments cm JOIN cards c ON c.id = cm.card_id
         WHERE cm.id = $1 AND cm.deleted_at IS NULL",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

pub async fn update_comment(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<CommentReq>,
) -> AppResult<Json<Value>> {
    let (board_id, card_id, author) = comment_ctx(&state, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::COMMENTS_CREATE)?;
    if author != Some(u.id) {
        return Err(AppError::Forbidden);
    }
    if r.body.trim().is_empty() {
        return Err(AppError::BadRequest("comment_empty"));
    }
    let (old_body,): (String,) = sqlx::query_as("SELECT body FROM comments WHERE id = $1").bind(id).fetch_one(&state.db).await?;
    sqlx::query("UPDATE comments SET body = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(r.body.trim_end())
        .execute(&state.db)
        .await?;
    state.hub.notify(board_id, "comment", Some(card_id), u.id);
    let new: std::collections::HashSet<String> =
        crate::notify::mentions(&r.body).difference(&crate::notify::mentions(&old_body)).cloned().collect();
    let mentioned = crate::notify::members_by_username(&state, board_id, &new, u.id).await?;
    let data = json!({ "snippet": crate::notify::snippet(&r.body), "where": "comment" });
    crate::notify::send(&state, &mentioned, "mentioned", board_id, Some(card_id), Some(u.id), data).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn delete_comment(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let (board_id, card_id, author) = comment_ctx(&state, id).await?;
    let access = board_access(&state.db, &u, board_id).await?;
    if author != Some(u.id) {
        access.require(perms::COMMENTS_MODERATE)?;
    }
    sqlx::query("UPDATE comments SET deleted_at = now() WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(board_id, "comment", Some(card_id), u.id);
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    #[test]
    fn checklist_counts() {
        let md = "# งาน\n- [ ] ซื้อของ\n- [x] done\n  * [X] nested\n- not a task\n";
        assert_eq!(super::checklist(md), (3, 2));
    }
}

// ---------- calendar (cards with a due date, across every board the user can see) ----------

#[derive(Deserialize)]
pub struct CalendarQuery {
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    board_id: Option<Uuid>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct CalendarItem {
    id: Uuid,
    board_id: Uuid,
    board_name: String,
    board_color: String,
    list_name: String,
    number: i32,
    title: String,
    due_at: DateTime<Utc>,
    priority: i16,
    status_name: Option<String>,
    status_color: Option<String>,
    assignee_ids: Vec<Uuid>,
    can_edit: bool,
    done: bool,
    // for the hover preview
    start_at: Option<DateTime<Utc>>,
    assignee_names: Vec<String>,
    labels: Value,
    #[serde(skip)]
    description: String,
    #[sqlx(skip)]
    excerpt: String,
}

pub async fn calendar(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    axum::extract::Query(q): axum::extract::Query<CalendarQuery>,
) -> AppResult<axum::response::Response> {
    if q.to <= q.from || q.to - q.from > chrono::Duration::days(100) {
        return Err(AppError::BadRequest("invalid_range"));
    }
    let _slot = crate::heavy(&state).await;
    let mut items: Vec<CalendarItem> = sqlx::query_as(sqlf!(
        "SELECT c.id, c.board_id, b.name AS board_name, b.color AS board_color, l.name AS list_name, c.number, c.title,
                c.due_at, c.priority, s.name AS status_name, s.color AS status_color,
                COALESCE((SELECT array_agg(user_id) FROM card_assignees WHERE card_id = c.id), '{{}}') AS assignee_ids,
                ($1 OR COALESCE(r.is_owner OR ('cards.due' = ANY(r.permissions) AND (NOT r.own_cards_only OR c.created_by = $2)), false)) AS can_edit,
                COALESCE(s.is_done, false) AS done, c.start_at, c.description,
                COALESCE((SELECT array_agg({DN} ORDER BY u.display_name) FROM card_assignees a JOIN users u ON u.id = a.user_id WHERE a.card_id = c.id), '{{}}') AS assignee_names,
                COALESCE((SELECT json_agg(json_build_object('name', x.name, 'color', x.color) ORDER BY x.name) FROM card_labels cl JOIN labels x ON x.id = cl.label_id WHERE cl.card_id = c.id), '[]'::json) AS labels
         FROM cards c
         JOIN boards b ON b.id = c.board_id
         JOIN lists l ON l.id = c.list_id
         LEFT JOIN board_statuses s ON s.id = c.status_id
         LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = $2
         LEFT JOIN board_roles r ON r.id = m.role_id
         WHERE c.archived_at IS NULL AND b.archived_at IS NULL AND l.archived_at IS NULL
           AND c.due_at >= $3 AND c.due_at < $4
           AND (($1 AND NOT b.is_tutorial) OR m.user_id IS NOT NULL)
           AND ($5::uuid IS NULL OR c.board_id = $5)
         ORDER BY c.due_at, c.number
         LIMIT 3000"
    ))
    .bind(u.is_super_admin)
    .bind(u.id)
    .bind(q.from)
    .bind(q.to)
    .bind(q.board_id)
    .fetch_all(&state.db)
    .await?;
    for i in &mut items {
        i.excerpt = excerpt(&std::mem::take(&mut i.description));
    }
    crate::json_now(&items)
}

// ---------- duplicate ----------

/// Copies a card (text, priority, status, colour, due date, labels, assignees) right below the original.
/// Attachments aren't copied; images pasted into the description keep pointing at the same files.
pub async fn duplicate_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<CardSummary>> {
    let board_id = board_of_card(&state.db, id).await?;
    let access = board_access(&state.db, &u, board_id).await?;
    let mut tx = state.db.begin().await?;
    let (list_id, title, position): (Uuid, String, String) =
        sqlx::query_as("SELECT list_id, title, position FROM cards WHERE id = $1").bind(id).fetch_one(&mut *tx).await?;
    // the copy lands in the same column
    access.require_create_in(list_id)?;
    sqlx::query("SELECT 1 FROM lists WHERE id = $1 FOR UPDATE").bind(list_id).execute(&mut *tx).await?;
    let next: Option<(String,)> = sqlx::query_as(
        r#"SELECT position FROM cards WHERE list_id = $1 AND archived_at IS NULL AND position COLLATE "C" > $2
           ORDER BY position COLLATE "C" LIMIT 1"#,
    )
    .bind(list_id)
    .bind(&position)
    .fetch_optional(&mut *tx)
    .await?;
    let pos = crate::position::between(Some(&position), next.as_ref().map(|n| n.0.as_str()));
    let (number,): (i32,) = sqlx::query_as("UPDATE boards SET card_seq = card_seq + 1, updated_at = now() WHERE id = $1 RETURNING card_seq")
        .bind(board_id)
        .fetch_one(&mut *tx)
        .await?;
    let new_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO cards (id, board_id, list_id, number, title, description, position, priority, status_id, color, start_at, due_at, remind_minutes, created_by)
         SELECT $2, board_id, list_id, $3, $4, description, $5, priority, status_id, color, start_at, due_at, remind_minutes, $6 FROM cards WHERE id = $1",
    )
    .bind(id)
    .bind(new_id)
    .bind(number)
    .bind(format!("{title} (copy)"))
    .bind(pos)
    .bind(u.id)
    .execute(&mut *tx)
    .await?;
    sync_done(&mut tx, new_id).await?;
    sqlx::query("INSERT INTO card_labels (card_id, label_id) SELECT $2, label_id FROM card_labels WHERE card_id = $1")
        .bind(id)
        .bind(new_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO card_assignees (card_id, user_id) SELECT $2, user_id FROM card_assignees WHERE card_id = $1")
        .bind(id)
        .bind(new_id)
        .execute(&mut *tx)
        .await?;
    let (orig_number,): (i32,) = sqlx::query_as("SELECT number FROM cards WHERE id = $1").bind(id).fetch_one(&mut *tx).await?;
    log_event(&mut tx, new_id, board_id, u.id, "duplicated", json!({ "from": orig_number })).await?;
    tx.commit().await?;
    state.hub.notify(board_id, "card", Some(new_id), u.id);
    let card = load_card_summaries(&state.db, board_id, Some(new_id)).await?.pop().ok_or(AppError::NotFound)?;
    Ok(Json(card))
}

// ---------- archive view, restore, permanent delete ----------

#[derive(Serialize, sqlx::FromRow)]
pub struct ArchivedCard {
    id: Uuid,
    number: i32,
    title: String,
    list_name: String,
    archived_at: DateTime<Utc>,
    archived_by: Option<String>,
    created_by: Option<Uuid>,
}

pub async fn archived_cards(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
) -> AppResult<Json<Vec<ArchivedCard>>> {
    board_access(&state.db, &u, board_id).await?;
    let rows: Vec<ArchivedCard> = sqlx::query_as(sqlf!(
        "SELECT c.id, c.number, c.title, l.name AS list_name, c.archived_at, c.created_by,
                (SELECT {DN} FROM card_events e JOIN users u ON u.id = e.actor_id
                 WHERE e.card_id = c.id AND e.kind = 'archived' ORDER BY e.id DESC LIMIT 1) AS archived_by
         FROM cards c JOIN lists l ON l.id = c.list_id
         WHERE c.board_id = $1 AND c.archived_at IS NOT NULL AND l.archived_at IS NULL
         ORDER BY c.archived_at DESC"
    ))
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

/// Brings an archived card back, at the bottom of its column (a fresh position, so ordering keys never collide).
pub async fn restore_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let (board_id, creator) = perms::card_owner_any(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require_on(perms::CARDS_ARCHIVE, creator)?;
    let mut tx = state.db.begin().await?;
    let (list_id,): (Uuid,) = sqlx::query_as("SELECT list_id FROM cards WHERE id = $1 AND archived_at IS NOT NULL")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("SELECT 1 FROM lists WHERE id = $1 FOR UPDATE").bind(list_id).execute(&mut *tx).await?;
    let last: Option<(String,)> = sqlx::query_as(
        r#"SELECT position FROM cards WHERE list_id = $1 AND archived_at IS NULL ORDER BY position COLLATE "C" DESC LIMIT 1"#,
    )
    .bind(list_id)
    .fetch_optional(&mut *tx)
    .await?;
    let pos = crate::position::between(last.as_ref().map(|l| l.0.as_str()), None);
    sqlx::query("UPDATE cards SET archived_at = NULL, position = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(pos)
        .execute(&mut *tx)
        .await?;
    log_event(&mut tx, id, board_id, u.id, "restored", json!({})).await?;
    tx.commit().await?;
    state.hub.notify(board_id, "card", Some(id), u.id);
    Ok(Json(json!({ "ok": true })))
}

/// Deletes a card for good: comments, activity, attachments (database rows and stored files).
pub async fn purge_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Value>> {
    let (board_id, creator) = perms::card_owner_any(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require_on(perms::CARDS_DELETE, creator)?;
    let mut tx = state.db.begin().await?;
    let keys = crate::files::purge_card_rows(&mut tx, id, board_id).await?;
    tx.commit().await?;
    let n = keys.len();
    crate::files::delete_objects(&state.store, keys).await;
    tracing::info!(card = %id, user = %u.username, files = n, "card permanently deleted");
    state.hub.notify(board_id, "card", Some(id), u.id);
    Ok(Json(json!({ "ok": true, "files_deleted": n })))
}

// ---------- dependencies (Gantt) ----------

#[derive(Deserialize)]
pub struct DepsReq {
    /// cards this card waits for (replaces the current list)
    ids: Vec<Uuid>,
}

/// Sets which cards this one depends on (finish-to-start). Same board only; loops are refused.
pub async fn set_dependencies(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<DepsReq>,
) -> AppResult<Json<Value>> {
    let (board_id, creator) = perms::card_owner(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require_on(perms::CARDS_DEPENDENCIES, creator)?;
    let mut wanted: Vec<Uuid> = r.ids.into_iter().filter(|x| *x != id).collect();
    wanted.sort();
    wanted.dedup();
    if wanted.len() > 50 {
        return Err(AppError::BadRequest("too_many_dependencies"));
    }
    let mut tx = state.db.begin().await?;
    // serialize dependency edits on this board so two concurrent edits can't build a loop together
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7))").bind(board_id).execute(&mut *tx).await?;
    let same_board: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM cards WHERE board_id = $1 AND id = ANY($2)").bind(board_id).bind(&wanted).fetch_all(&mut *tx).await?;
    if same_board.len() != wanted.len() {
        return Err(AppError::BadRequest("invalid_dependency"));
    }
    // loop check: does any new prerequisite (directly or indirectly) already wait for this card?
    let (cycle,): (bool,) = sqlx::query_as(
        "WITH RECURSIVE up(id) AS (
             SELECT depends_on FROM card_dependencies WHERE card_id = ANY($2)
             UNION SELECT d.depends_on FROM card_dependencies d JOIN up ON d.card_id = up.id
         ) SELECT EXISTS (SELECT 1 FROM up WHERE id = $1)",
    )
    .bind(id)
    .bind(&wanted)
    .fetch_one(&mut *tx)
    .await?;
    if cycle {
        return Err(AppError::BadRequest("dependency_cycle"));
    }
    let current: Vec<(Uuid,)> = sqlx::query_as("SELECT depends_on FROM card_dependencies WHERE card_id = $1").bind(id).fetch_all(&mut *tx).await?;
    let current: Vec<Uuid> = current.into_iter().map(|c| c.0).collect();
    let added: Vec<Uuid> = wanted.iter().filter(|w| !current.contains(w)).copied().collect();
    let removed: Vec<Uuid> = current.iter().filter(|c| !wanted.contains(c)).copied().collect();
    sqlx::query("DELETE FROM card_dependencies WHERE card_id = $1 AND depends_on = ANY($2)").bind(id).bind(&removed).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO card_dependencies (card_id, depends_on, created_by) SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(&added)
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    if !added.is_empty() || !removed.is_empty() {
        let mut names: Vec<Vec<String>> = Vec::new();
        for ids in [&added, &removed] {
            let rows: Vec<(String,)> = sqlx::query_as("SELECT '#' || number || ' ' || title FROM cards WHERE id = ANY($1) ORDER BY number")
                .bind(ids)
                .fetch_all(&mut *tx)
                .await?;
            names.push(rows.into_iter().map(|r| r.0).collect());
        }
        let (a, rm) = (&names[0], &names[1]);
        log_event(&mut tx, id, board_id, u.id, "dependencies", json!({ "added": a, "removed": rm })).await?;
    }
    tx.commit().await?;
    touch_board(&state, board_id).await?;
    state.hub.notify(board_id, "card", Some(id), u.id);
    Ok(Json(json!({ "depends_on": wanted })))
}

// ---------- several cards at once ----------

#[derive(Deserialize)]
pub struct BulkReq {
    card_ids: Vec<Uuid>,
    /// move | update | labels | assignees | archive | watch
    action: String,
    /// move: the column
    list_id: Option<Uuid>,
    /// move: "top" or "bottom" (default); the cards keep their order
    at: Option<String>,
    /// update: what PATCH /cards/{id} takes, except the title and description
    changes: Option<Value>,
    /// labels / assignees: ids to add and to take off
    #[serde(default)]
    add: Vec<Uuid>,
    #[serde(default)]
    remove: Vec<Uuid>,
    /// watch: on or off
    watching: Option<bool>,
}

/// at most this many cards per request
const BULK_MAX: usize = 500;

fn code(e: &AppError) -> &'static str {
    match e {
        AppError::Forbidden => "forbidden",
        AppError::NotFound => "not_found",
        AppError::BadRequest(c) | AppError::Conflict(c) | AppError::Denied(c) => c,
        _ => "error",
    }
}

/// POST /boards/{id}/cards/bulk: one change to several cards of a board. Each card goes through the same handler
/// (and so the same permission checks: own-cards-only roles, valid labels and members…) as a single change; cards
/// that can't be changed are reported, the rest are changed. Answers { done, failed: [{ id, error }] }.
pub async fn bulk(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
    Json(r): Json<BulkReq>,
) -> AppResult<Json<Value>> {
    board_access(&state.db, &u, board_id).await?;
    let mut ids: Vec<Uuid> = Vec::new();
    for id in r.card_ids {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.len() > BULK_MAX {
        return Err(AppError::BadRequest("too_many_cards"));
    }
    // only this board's (unarchived) cards, in the order given
    let here: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM cards WHERE id = ANY($1) AND board_id = $2 AND archived_at IS NULL")
        .bind(&ids)
        .bind(board_id)
        .fetch_all(&state.db)
        .await?;
    let changes: Option<UpdateCard> = match (r.action.as_str(), r.changes) {
        ("update", Some(Value::Object(mut m))) => {
            // a bulk change never renames: those fields are dropped
            m.remove("title");
            m.remove("description");
            if m.is_empty() {
                return Err(AppError::BadRequest("nothing_to_change"));
            }
            Some(serde_json::from_value(Value::Object(m)).map_err(|_| AppError::BadRequest("invalid_changes"))?)
        }
        ("update", _) => return Err(AppError::BadRequest("nothing_to_change")),
        _ => None,
    };
    if r.action == "move" && r.list_id.is_none() {
        return Err(AppError::BadRequest("invalid_list"));
    }
    if !matches!(r.action.as_str(), "move" | "update" | "labels" | "assignees" | "archive" | "watch") {
        return Err(AppError::BadRequest("invalid_action"));
    }
    let top = r.at.as_deref() == Some("top");
    let (mut done, mut failed) = (0usize, Vec::<Value>::new());
    for (i, id) in ids.iter().enumerate() {
        if !here.contains(id) {
            failed.push(json!({ "id": id, "error": "not_found" }));
            continue;
        }
        let st = || State(state.clone());
        let cu = || CurrentUser(u.clone());
        let res: AppResult<()> = match r.action.as_str() {
            "move" => {
                let list_id = r.list_id.unwrap();
                let index = if top {
                    i
                } else {
                    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM cards WHERE list_id = $1 AND archived_at IS NULL AND id <> $2")
                        .bind(list_id)
                        .bind(id)
                        .fetch_one(&state.db)
                        .await?;
                    n as usize
                };
                move_card(st(), cu(), Path(*id), Json(MoveCard { list_id, index })).await.map(|_| ())
            }
            "update" => {
                let c = changes.as_ref().unwrap();
                let one = UpdateCard {
                    title: None,
                    description: None,
                    priority: c.priority,
                    status_id: c.status_id,
                    color: c.color.clone(),
                    due_at: c.due_at,
                    start_at: c.start_at,
                    remind_minutes: c.remind_minutes,
                    estimate_minutes: c.estimate_minutes,
                };
                update_card(st(), cu(), Path(*id), Json(one)).await.map(|_| ())
            }
            "labels" | "assignees" => {
                let q = if r.action == "labels" {
                    "SELECT label_id FROM card_labels WHERE card_id = $1"
                } else {
                    "SELECT user_id FROM card_assignees WHERE card_id = $1"
                };
                let now: Vec<Uuid> = sqlx::query_scalar(q).bind(id).fetch_all(&state.db).await?;
                let mut next: Vec<Uuid> = now.iter().copied().filter(|x| !r.remove.contains(x)).collect();
                for a in &r.add {
                    if !next.contains(a) {
                        next.push(*a);
                    }
                }
                if next.len() == now.len() && next.iter().all(|x| now.contains(x)) {
                    Ok(()) // nothing to change on this card
                } else if r.action == "labels" {
                    set_labels(st(), cu(), Path(*id), Json(IdsReq { ids: next })).await.map(|_| ())
                } else {
                    set_assignees(st(), cu(), Path(*id), Json(IdsReq { ids: next })).await.map(|_| ())
                }
            }
            "archive" => archive_card(st(), cu(), Path(*id)).await.map(|_| ()),
            _ => watch(st(), cu(), Path(*id), Json(WatchReq { watching: r.watching.unwrap_or(true) })).await.map(|_| ()),
        };
        match res {
            Ok(()) => done += 1,
            Err(e) => {
                if matches!(e, AppError::Internal(_)) {
                    tracing::warn!(error = %e, card = %id, "bulk change failed");
                }
                failed.push(json!({ "id": id, "error": code(&e) }));
            }
        }
    }
    Ok(Json(json!({ "done": done, "failed": failed })))
}
