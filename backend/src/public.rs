//! Read-only public link to a board (Board settings → Share): anyone with the link sees the columns, cards and dates
//! without an account. The board's managers choose whether visitors also see comments and may download attachments.
//! Nothing can be changed through a link. An admin can turn links off for the whole site (Admin → Security).
//!
//! What a visitor gets is deliberately narrow: no emails, usernames, roles, templates, channels or recurrences;
//! only the names of people assigned to a visible card (or who wrote a visible comment).

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    audit::ClientIp,
    auth::{CurrentUser, new_token},
    boards::{Label, List, Status},
    cards::{CardSummary, load_card_summaries},
    error::{AppError, AppResult},
    files::DownloadQuery,
    perms::{self, board_access},
};

// ---------- managing the link (board members with board.manage) ----------

#[derive(sqlx::FromRow)]
struct Share {
    public_token: Option<String>,
    public_comments: bool,
    public_files: bool,
}

async fn share_view(state: &AppState, board_id: Uuid) -> AppResult<Value> {
    let s: Share = sqlx::query_as("SELECT public_token, public_comments, public_files FROM boards WHERE id = $1")
        .bind(board_id)
        .fetch_one(&state.db)
        .await?;
    let base = crate::notify::base_url(state).await;
    Ok(json!({
        "enabled": s.public_token.is_some(),
        "url": s.public_token.map(|t| format!("{base}/p/{t}")),
        "comments": s.public_comments,
        "files": s.public_files,
        // an admin turned public links off for the whole site
        "allowed": crate::admin::public_links_allowed(&state.db).await,
    }))
}

pub async fn get_share(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(board_id): Path<Uuid>) -> AppResult<Json<Value>> {
    board_access(&state.db, &u, board_id).await?.require(perms::BOARD_MANAGE)?;
    Ok(Json(share_view(&state, board_id).await?))
}

#[derive(Deserialize)]
pub struct ShareReq {
    enabled: Option<bool>,
    comments: Option<bool>,
    files: Option<bool>,
    /// a new link; the old one stops working
    #[serde(default)]
    reset: bool,
}

pub async fn save_share(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    ClientIp(ip): ClientIp,
    Path(board_id): Path<Uuid>,
    Json(r): Json<ShareReq>,
) -> AppResult<Json<Value>> {
    board_access(&state.db, &u, board_id).await?.require(perms::BOARD_MANAGE)?;
    let before: Share = sqlx::query_as("SELECT public_token, public_comments, public_files FROM boards WHERE id = $1")
        .bind(board_id)
        .fetch_one(&state.db)
        .await?;
    let enable = r.enabled.unwrap_or(before.public_token.is_some());
    if enable && !crate::admin::public_links_allowed(&state.db).await {
        return Err(AppError::BadRequest("public_links_off"));
    }
    let token = match (enable, &before.public_token) {
        (false, _) => None,
        (true, Some(t)) if !r.reset => Some(t.clone()),
        (true, _) => Some(new_token()),
    };
    let (comments, files) = (r.comments.unwrap_or(before.public_comments), r.files.unwrap_or(before.public_files));
    sqlx::query("UPDATE boards SET public_token = $2, public_comments = $3, public_files = $4 WHERE id = $1")
        .bind(board_id)
        .bind(&token)
        .bind(comments)
        .bind(files)
        .execute(&state.db)
        .await?;
    let kind = match (before.public_token.is_some(), token.is_some()) {
        (false, true) => Some("board_shared"),
        (true, false) => Some("board_unshared"),
        (true, true) if token != before.public_token => Some("board_share_reset"),
        (true, true) if comments != before.public_comments || files != before.public_files => Some("board_share_changed"),
        _ => None,
    };
    if let Some(kind) = kind {
        crate::audit::log(&state, Some(u.id), kind, Some(board_id), ip.as_deref(), json!({ "comments": comments, "files": files })).await;
    }
    Ok(Json(share_view(&state, board_id).await?))
}

// ---------- what a visitor sees (no account) ----------

#[derive(sqlx::FromRow)]
struct Shared {
    id: Uuid,
    public_comments: bool,
    public_files: bool,
}

/// The board behind a link; "not found" for an unknown link, an archived board, or links turned off by an admin.
async fn shared(state: &AppState, token: &str) -> AppResult<Shared> {
    // tokens are 64 hex characters; anything else can't match, so skip the lookup
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::NotFound);
    }
    let b: Shared = sqlx::query_as("SELECT id, public_comments, public_files FROM boards WHERE public_token = $1 AND archived_at IS NULL")
        .bind(token)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)?;
    if !crate::admin::public_links_allowed(&state.db).await {
        return Err(AppError::NotFound);
    }
    Ok(b)
}

/// JSON a search engine shouldn't index and a shared cache shouldn't keep.
fn private_json<T: Serialize>(v: &T) -> AppResult<Response> {
    let mut resp = crate::json_now(v)?;
    let h = resp.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
    Ok(resp)
}

#[derive(Serialize, sqlx::FromRow)]
struct Person {
    user_id: Uuid,
    display_name: String,
    avatar_color: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct BoardInfo {
    name: String,
    description: String,
    color: String,
}

#[derive(Serialize)]
struct PublicBoard {
    board: BoardInfo,
    comments: bool,
    files: bool,
    lists: Vec<List>,
    cards: Vec<CardSummary>,
    labels: Vec<Label>,
    statuses: Vec<Status>,
    /// only people assigned to a card on the board
    people: Vec<Person>,
}

pub async fn board(State(state): State<AppState>, Path(token): Path<String>) -> AppResult<Response> {
    let b = shared(&state, &token).await?;
    let db = &state.db;
    let board: BoardInfo = sqlx::query_as("SELECT name, description, color FROM boards WHERE id = $1").bind(b.id).fetch_one(db).await?;
    let lists: Vec<List> = sqlx::query_as(
        r#"SELECT id, name, position, color, folded, wip_limit FROM lists WHERE board_id = $1 AND archived_at IS NULL
           ORDER BY position COLLATE "C""#,
    )
    .bind(b.id)
    .fetch_all(db)
    .await?;
    let mut cards = load_card_summaries(db, b.id, None).await?;
    for c in &mut cards {
        // who created a card is not a visitor's business; counts of hidden things aren't either
        c.created_by = None;
        // time tracking is for the team
        c.estimate_minutes = None;
        c.time_minutes = 0;
        if !b.public_comments {
            c.comment_count = 0;
        }
        if !b.public_files {
            c.attachment_count = 0;
        }
    }
    let labels: Vec<Label> = sqlx::query_as("SELECT id, name, color FROM labels WHERE board_id = $1 ORDER BY name").bind(b.id).fetch_all(db).await?;
    let statuses: Vec<Status> = sqlx::query_as("SELECT id, name, color, position, is_done FROM board_statuses WHERE board_id = $1 ORDER BY position, name")
        .bind(b.id)
        .fetch_all(db)
        .await?;
    let assigned: Vec<Uuid> = cards.iter().flat_map(|c| c.assignee_ids.iter().copied()).collect();
    let people: Vec<Person> = sqlx::query_as("SELECT id AS user_id, display_name, avatar_color FROM users WHERE id = ANY($1)")
        .bind(&assigned)
        .fetch_all(db)
        .await?;
    private_json(&PublicBoard { board, comments: b.public_comments, files: b.public_files, lists, cards, labels, statuses, people })
}

#[derive(Serialize, sqlx::FromRow)]
struct PublicCard {
    id: Uuid,
    list_id: Uuid,
    number: i32,
    title: String,
    description: String,
    priority: i16,
    status_id: Option<Uuid>,
    color: Option<String>,
    start_at: Option<DateTime<Utc>>,
    due_at: Option<DateTime<Utc>>,
    done_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    label_ids: Vec<Uuid>,
    assignee_ids: Vec<Uuid>,
}

#[derive(Serialize, sqlx::FromRow)]
struct PublicAttachment {
    id: Uuid,
    filename: String,
    content_type: String,
    size: i64,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, sqlx::FromRow)]
struct PublicComment {
    id: Uuid,
    author_name: Option<String>,
    author_color: Option<String>,
    body: String,
    created_at: DateTime<Utc>,
    edited: bool,
}

pub async fn card(State(state): State<AppState>, Path((token, id)): Path<(String, Uuid)>) -> AppResult<Response> {
    let b = shared(&state, &token).await?;
    let card: PublicCard = sqlx::query_as(
        "SELECT c.id, c.list_id, c.number, c.title, c.description, c.priority, c.status_id, c.color, c.start_at, c.due_at, c.done_at,
                c.created_at, c.updated_at,
                COALESCE((SELECT array_agg(label_id) FROM card_labels WHERE card_id = c.id), '{}') AS label_ids,
                COALESCE((SELECT array_agg(user_id) FROM card_assignees WHERE card_id = c.id), '{}') AS assignee_ids
         FROM cards c JOIN lists l ON l.id = c.list_id
         WHERE c.id = $1 AND c.board_id = $2 AND c.archived_at IS NULL AND l.archived_at IS NULL",
    )
    .bind(id)
    .bind(b.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let attachments: Vec<PublicAttachment> = if b.public_files {
        sqlx::query_as(
            "SELECT id, filename, content_type, size, created_at FROM attachments
             WHERE card_id = $1 AND deleted_at IS NULL AND NOT is_inline ORDER BY created_at",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?
    } else {
        Vec::new()
    };
    let comments: Vec<PublicComment> = if b.public_comments {
        sqlx::query_as(
            "SELECT c.id, COALESCE(u.display_name, c.imported_author) AS author_name, u.avatar_color AS author_color, c.body, c.created_at,
                    c.updated_at > c.created_at + interval '1 second' AS edited
             FROM comments c LEFT JOIN users u ON u.id = c.author_id
             WHERE c.card_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?
    } else {
        Vec::new()
    };
    let people: Vec<Person> = sqlx::query_as("SELECT id AS user_id, display_name, avatar_color FROM users WHERE id = ANY($1)")
        .bind(&card.assignee_ids)
        .fetch_all(&state.db)
        .await?;
    private_json(&json!({ "card": card, "attachments": attachments, "comments": comments, "people": people }))
}

/// A file on a shared board. Pictures placed in a description or comment always load (they may have been pasted on
/// another card of the board and copied over, e.g. by duplicating); other attachments only when the board allows
/// downloads, and only from a card that is visible on the link.
pub async fn file(State(state): State<AppState>, Path((token, id)): Path<(String, Uuid)>, Query(q): Query<DownloadQuery>) -> AppResult<Response> {
    let b = shared(&state, &token).await?;
    let row: (String, String, String, i64, bool) = sqlx::query_as(
        "SELECT a.filename, a.content_type, a.object_key, a.size, a.is_inline FROM attachments a
         LEFT JOIN cards c ON c.id = a.card_id LEFT JOIN lists l ON l.id = c.list_id
         WHERE a.id = $1 AND a.board_id = $2 AND a.deleted_at IS NULL
           AND (a.is_inline OR (c.archived_at IS NULL AND l.archived_at IS NULL))",
    )
    .bind(id)
    .bind(b.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;
    let (filename, content_type, key, size, is_inline) = row;
    if !is_inline && !b.public_files {
        return Err(AppError::NotFound);
    }
    let mut resp = crate::files::serve(&state, &filename, &content_type, &key, size, q.forced(), "private, no-cache").await?;
    resp.headers_mut().insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
    Ok(resp.into_response())
}
