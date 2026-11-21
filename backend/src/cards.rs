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
    pub due_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub label_ids: Vec<Uuid>,
    pub assignee_ids: Vec<Uuid>,
    pub comment_count: i64,
    pub attachment_count: i64,
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
SELECT c.id, c.list_id, c.number, c.title, c.position, c.priority, c.status_id, c.color, c.due_at, c.updated_at, c.description,
  COALESCE((SELECT array_agg(label_id) FROM card_labels WHERE card_id = c.id), '{}') AS label_ids,
  COALESCE((SELECT array_agg(user_id) FROM card_assignees WHERE card_id = c.id), '{}') AS assignee_ids,
  (SELECT count(*) FROM comments WHERE card_id = c.id AND deleted_at IS NULL) AS comment_count,
  (SELECT count(*) FROM attachments WHERE card_id = c.id AND deleted_at IS NULL AND NOT is_inline) AS attachment_count
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
}

pub async fn create_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(list_id): Path<Uuid>,
    Json(r): Json<CreateCard>,
) -> AppResult<Json<CardSummary>> {
    let board_id = board_of_list(&state.db, list_id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_CREATE)?;
    let title = r.title.trim();
    if title.is_empty() {
        return Err(AppError::BadRequest("title_required"));
    }
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
    let index = if r.at.as_deref() == Some("top") { 0 } else { keys.len() };
    let pos = position_at(&keys, index);
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO cards (id, board_id, list_id, number, title, description, position, created_by, due_at, status_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                 (SELECT id FROM board_statuses WHERE board_id = $2 ORDER BY position, name LIMIT 1))",
    )
    .bind(id)
    .bind(board_id)
    .bind(list_id)
    .bind(number)
    .bind(title)
    .bind(&r.description)
    .bind(pos)
    .bind(u.id)
    .bind(r.due_at)
    .execute(&mut *tx)
    .await?;
    let (list_name,): (String,) = sqlx::query_as("SELECT name FROM lists WHERE id = $1").bind(list_id).fetch_one(&mut *tx).await?;
    log_event(&mut tx, id, board_id, u.id, "created", json!({ "list": list_name })).await?;
    tx.commit().await?;
    state.hub.notify(board_id, "card", Some(id), u.id);
    let card = load_card_summaries(&state.db, board_id, Some(id)).await?.pop().ok_or(AppError::NotFound)?;
    Ok(Json(card))
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
    due_at: Option<DateTime<Utc>>,
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
}

pub async fn get_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<CardDetail>> {
    let board_id = board_of_card(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?;
    let card: Card = sqlx::query_as(sqlf!(
        "SELECT c.id, c.board_id, c.list_id, c.number, c.title, c.description, c.priority, c.status_id, c.color, c.due_at,
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
    Ok(Json(CardDetail { card, attachments }))
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
}

#[derive(sqlx::FromRow)]
struct CardRow {
    title: String,
    description: String,
    priority: i16,
    status_id: Option<Uuid>,
    color: Option<String>,
    due_at: Option<DateTime<Utc>>,
}

pub async fn update_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<UpdateCard>,
) -> AppResult<Json<CardSummary>> {
    let board_id = board_of_card(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_EDIT)?;
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
    let mut tx = state.db.begin().await?;
    let old: CardRow =
        sqlx::query_as("SELECT title, description, priority, status_id, color, due_at FROM cards WHERE id = $1 FOR UPDATE")
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
    sqlx::query(
        "UPDATE cards SET title = COALESCE($2, title), description = COALESCE($3, description),
            priority = COALESCE($4, priority),
            status_id = CASE WHEN $10 THEN $5 ELSE status_id END,
            color = CASE WHEN $6 THEN $7 ELSE color END,
            due_at = CASE WHEN $8 THEN $9 ELSE due_at END,
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
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    touch_board(&state, board_id).await?;
    state.hub.notify(board_id, "card", Some(id), u.id);
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
    let board_id = board_of_card(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_MOVE)?;
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
    let board_id = board_of_card(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_DELETE)?;
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
    let board_id = board_of_card(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_EDIT)?;
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
    let board_id = board_of_card(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_EDIT)?;
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
    type C = (Uuid, Option<Uuid>, String, DateTime<Utc>, DateTime<Utc>, Option<String>, Option<String>, Option<Uuid>);
    let comments: Vec<C> = sqlx::query_as(sqlf!(
        "SELECT cm.id, cm.author_id, cm.body, cm.created_at, cm.updated_at, {DN}, u.avatar_color, u.avatar_id
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
        .map(|(id, author_id, body, created_at, updated_at, author_name, author_color, author_avatar)| TimelineItem::Comment {
            id,
            author_id,
            author_name,
            author_color,
            author_avatar,
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
    sqlx::query("UPDATE comments SET body = $2, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(r.body.trim_end())
        .execute(&state.db)
        .await?;
    state.hub.notify(board_id, "comment", Some(card_id), u.id);
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
}

pub async fn calendar(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    axum::extract::Query(q): axum::extract::Query<CalendarQuery>,
) -> AppResult<Json<Vec<CalendarItem>>> {
    if q.to <= q.from || q.to - q.from > chrono::Duration::days(100) {
        return Err(AppError::BadRequest("invalid_range"));
    }
    let items: Vec<CalendarItem> = sqlx::query_as(
        "SELECT c.id, c.board_id, b.name AS board_name, b.color AS board_color, l.name AS list_name, c.number, c.title,
                c.due_at, c.priority, s.name AS status_name, s.color AS status_color,
                COALESCE((SELECT array_agg(user_id) FROM card_assignees WHERE card_id = c.id), '{}') AS assignee_ids,
                ($1 OR COALESCE(r.is_owner OR 'cards.edit' = ANY(r.permissions), false)) AS can_edit
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
         LIMIT 3000",
    )
    .bind(u.is_super_admin)
    .bind(u.id)
    .bind(q.from)
    .bind(q.to)
    .bind(q.board_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(items))
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
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_CREATE)?;
    let mut tx = state.db.begin().await?;
    let (list_id, title, position): (Uuid, String, String) =
        sqlx::query_as("SELECT list_id, title, position FROM cards WHERE id = $1").bind(id).fetch_one(&mut *tx).await?;
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
        "INSERT INTO cards (id, board_id, list_id, number, title, description, position, priority, status_id, color, due_at, created_by)
         SELECT $2, board_id, list_id, $3, $4, description, $5, priority, status_id, color, due_at, $6 FROM cards WHERE id = $1",
    )
    .bind(id)
    .bind(new_id)
    .bind(number)
    .bind(format!("{title} (copy)"))
    .bind(pos)
    .bind(u.id)
    .execute(&mut *tx)
    .await?;
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
}

pub async fn archived_cards(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
) -> AppResult<Json<Vec<ArchivedCard>>> {
    board_access(&state.db, &u, board_id).await?;
    let rows: Vec<ArchivedCard> = sqlx::query_as(sqlf!(
        "SELECT c.id, c.number, c.title, l.name AS list_name, c.archived_at,
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
    let board_id = crate::perms::board_of_card_any(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_DELETE)?;
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
    let board_id = crate::perms::board_of_card_any(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_DELETE)?;
    let mut tx = state.db.begin().await?;
    let keys = crate::files::purge_card_rows(&mut tx, id, board_id).await?;
    tx.commit().await?;
    let n = keys.len();
    crate::files::delete_objects(&state.store, keys).await;
    tracing::info!(card = %id, user = %u.username, files = n, "card permanently deleted");
    state.hub.notify(board_id, "card", Some(id), u.id);
    Ok(Json(json!({ "ok": true, "files_deleted": n })))
}
