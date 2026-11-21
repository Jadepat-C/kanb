//! Boards, lists (columns), labels, roles and members.

use axum::{
    Json,
    extract::{Path, Query, State},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppState,
    auth::CurrentUser,
    cards::{CardSummary, load_card_summaries},
    error::{AppError, AppResult},
    perms::{self, board_access, board_of_list},
    position,
};

#[derive(Serialize, sqlx::FromRow)]
pub struct Board {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub color: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct BoardListItem {
    id: Uuid,
    name: String,
    description: String,
    color: String,
    updated_at: DateTime<Utc>,
    is_member: bool,
    card_count: i64,
    member_count: i64,
    /// [{id, display_name, avatar_color}] of members holding the owner role
    owners: serde_json::Value,
    archived_at: Option<DateTime<Utc>>,
    can_manage: bool,
    can_delete: bool,
}

#[derive(Deserialize)]
pub struct BoardsQuery {
    q: Option<String>,
    /// list archived boards instead of active ones
    #[serde(default)]
    archived: bool,
}

/// Boards visible to the user (super admins see all). `q` filters by name/description (substring; works for Thai).
pub async fn list_boards(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Query(q): Query<BoardsQuery>,
) -> AppResult<Json<Vec<BoardListItem>>> {
    let rows: Vec<BoardListItem> = sqlx::query_as(
        "SELECT b.id, b.name, b.description, b.color, b.updated_at,
                EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $1) AS is_member,
                (SELECT count(*) FROM cards c JOIN lists l ON l.id = c.list_id
                 WHERE c.board_id = b.id AND c.archived_at IS NULL AND l.archived_at IS NULL) AS card_count,
                (SELECT count(*) FROM board_members m WHERE m.board_id = b.id) AS member_count,
                COALESCE((SELECT json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'avatar_color', u.avatar_color)
                                          ORDER BY lower(u.display_name))
                          FROM board_members m JOIN board_roles r ON r.id = m.role_id JOIN users u ON u.id = m.user_id
                          WHERE m.board_id = b.id AND r.is_owner), '[]'::json) AS owners,
                b.archived_at,
                ($2 OR COALESCE((SELECT r.is_owner OR 'board.manage' = ANY(r.permissions) FROM board_members m
                                 JOIN board_roles r ON r.id = m.role_id WHERE m.board_id = b.id AND m.user_id = $1), false)) AS can_manage,
                ($2 OR COALESCE((SELECT r.is_owner OR 'board.delete' = ANY(r.permissions) FROM board_members m
                                 JOIN board_roles r ON r.id = m.role_id WHERE m.board_id = b.id AND m.user_id = $1), false)) AS can_delete
         FROM boards b
         LEFT JOIN board_prefs p ON p.board_id = b.id AND p.user_id = $1
         WHERE (b.archived_at IS NOT NULL) = $4
           -- super admins see every board except other people's personal tutorial boards
           AND (($2 AND NOT b.is_tutorial) OR EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $1))
           AND ($3::text IS NULL OR strpos(lower(b.name || ' ' || b.description), $3) > 0)
         ORDER BY CASE WHEN $4 THEN NULL ELSE p.position END NULLS FIRST, COALESCE(b.archived_at, b.updated_at) DESC",
    )
    .bind(u.id)
    .bind(u.is_super_admin)
    .bind(q.q.as_ref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()))
    .bind(q.archived)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateBoard {
    name: String,
    #[serde(default)]
    description: String,
    color: Option<String>,
    /// Initial column names; defaults are created when omitted.
    lists: Option<Vec<String>>,
}

pub async fn create_board(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Json(r): Json<CreateBoard>,
) -> AppResult<Json<Board>> {
    if !(u.is_super_admin || u.can_create_boards) {
        return Err(AppError::Forbidden);
    }
    let name = r.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name_required"));
    }
    let mut tx = state.db.begin().await?;
    let names = r.lists.unwrap_or_else(|| vec!["To Do".into(), "In Progress".into(), "Done".into()]);
    let (board, _, _) = insert_board(&mut tx, Some(u.id), u.id, &u.locale, name, r.description.trim(), r.color.as_deref(), &names).await?;
    tx.commit().await?;
    Ok(Json(board))
}

/// Creates a board with the default roles, `owner` as Owner, localized default statuses and the given columns.
/// Returns the board, its column ids and its status ids (both in order).
#[allow(clippy::too_many_arguments)]
pub async fn insert_board(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    created_by: Option<Uuid>,
    owner: Uuid,
    locale: &str,
    name: &str,
    description: &str,
    color: Option<&str>,
    lists: &[String],
) -> AppResult<(Board, Vec<Uuid>, Vec<Uuid>)> {
    let board: Board = sqlx::query_as(
        "INSERT INTO boards (id, name, description, color, created_by) VALUES ($1,$2,$3,COALESCE($4,'#6366f1'),$5)
         RETURNING id, name, description, color, created_at, updated_at",
    )
    .bind(Uuid::now_v7())
    .bind(name)
    .bind(description)
    .bind(color)
    .bind(created_by)
    .fetch_one(&mut **tx)
    .await?;
    let mut owner_role = None;
    for (i, (role_name, is_owner, perms)) in perms::default_roles().into_iter().enumerate() {
        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO board_roles (id, board_id, name, permissions, is_owner, position) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(id)
            .bind(board.id)
            .bind(role_name)
            .bind(perms)
            .bind(is_owner)
            .bind(i as i32)
            .execute(&mut **tx)
            .await?;
        if is_owner {
            owner_role = Some(id);
        }
    }
    sqlx::query("INSERT INTO board_members (board_id, user_id, role_id) VALUES ($1,$2,$3)")
        .bind(board.id)
        .bind(owner)
        .bind(owner_role)
        .execute(&mut **tx)
        .await?;
    let statuses: [(&str, &str); 3] = if locale == "th" {
        [("ปกติ", "#a1a1aa"), ("ติดปัญหา", "#ef4444"), ("พร้อม", "#22c55e")]
    } else {
        [("Normal", "#a1a1aa"), ("Blocked", "#ef4444"), ("Ready", "#22c55e")]
    };
    let mut status_ids = Vec::new();
    for (i, (name, color)) in statuses.iter().enumerate() {
        let sid = Uuid::now_v7();
        sqlx::query("INSERT INTO board_statuses (id, board_id, name, color, position) VALUES ($1,$2,$3,$4,$5)")
            .bind(sid)
            .bind(board.id)
            .bind(name)
            .bind(color)
            .bind(i as i32)
            .execute(&mut **tx)
            .await?;
        status_ids.push(sid);
    }
    let mut list_ids = Vec::new();
    let mut prev: Option<String> = None;
    for n in lists.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let pos = position::between(prev.as_deref(), None);
        let lid = Uuid::now_v7();
        sqlx::query("INSERT INTO lists (id, board_id, name, position) VALUES ($1,$2,$3,$4)")
            .bind(lid)
            .bind(board.id)
            .bind(n)
            .bind(&pos)
            .execute(&mut **tx)
            .await?;
        list_ids.push(lid);
        prev = Some(pos);
    }
    Ok((board, list_ids, status_ids))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct List {
    pub id: Uuid,
    pub name: String,
    pub position: String,
    pub color: Option<String>,
    pub folded: bool,
    pub wip_limit: Option<i32>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Label {
    pub id: Uuid,
    pub name: String,
    pub color: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Member {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub role_id: Uuid,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Role {
    pub id: Uuid,
    pub name: String,
    pub permissions: Vec<String>,
    pub is_owner: bool,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Status {
    pub id: Uuid,
    pub name: String,
    pub color: String,
    pub position: i32,
}

#[derive(Serialize)]
pub struct BoardDetail {
    board: Board,
    my_permissions: Vec<String>,
    my_role_id: Option<Uuid>,
    all_permissions: Vec<&'static str>,
    lists: Vec<List>,
    cards: Vec<CardSummary>,
    labels: Vec<Label>,
    statuses: Vec<Status>,
    members: Vec<Member>,
    roles: Vec<Role>,
}

pub async fn get_board(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<BoardDetail>> {
    let access = board_access(&state.db, &u, id).await?;
    let db = &state.db;
    let board: Board =
        sqlx::query_as("SELECT id, name, description, color, created_at, updated_at FROM boards WHERE id = $1")
            .bind(id)
            .fetch_one(db)
            .await?;
    let lists: Vec<List> = sqlx::query_as(
        r#"SELECT id, name, position, color, folded, wip_limit FROM lists WHERE board_id = $1 AND archived_at IS NULL
           ORDER BY position COLLATE "C""#,
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let cards = load_card_summaries(db, id, None).await?;
    let labels: Vec<Label> = sqlx::query_as("SELECT id, name, color FROM labels WHERE board_id = $1 ORDER BY name")
        .bind(id)
        .fetch_all(db)
        .await?;
    let statuses: Vec<Status> =
        sqlx::query_as("SELECT id, name, color, position FROM board_statuses WHERE board_id = $1 ORDER BY position, name")
            .bind(id)
            .fetch_all(db)
            .await?;
    let members: Vec<Member> = sqlx::query_as(
        "SELECT u.id AS user_id, u.username, u.display_name, u.avatar_color, m.role_id
         FROM board_members m JOIN users u ON u.id = m.user_id WHERE m.board_id = $1 ORDER BY lower(u.display_name)",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let roles: Vec<Role> =
        sqlx::query_as("SELECT id, name, permissions, is_owner FROM board_roles WHERE board_id = $1 ORDER BY position, name")
            .bind(id)
            .fetch_all(db)
            .await?;
    Ok(Json(BoardDetail {
        board,
        my_permissions: access.granted(),
        my_role_id: access.role_id,
        all_permissions: perms::ALL.to_vec(),
        lists,
        cards,
        labels,
        statuses,
        members,
        roles,
    }))
}

#[derive(Deserialize)]
pub struct UpdateBoard {
    name: Option<String>,
    description: Option<String>,
    color: Option<String>,
}

pub async fn update_board(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<UpdateBoard>,
) -> AppResult<Json<Board>> {
    board_access(&state.db, &u, id).await?.require(perms::BOARD_MANAGE)?;
    if r.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return Err(AppError::BadRequest("name_required"));
    }
    let b: Board = sqlx::query_as(
        "UPDATE boards SET name = COALESCE($2, name), description = COALESCE($3, description), color = COALESCE($4, color),
         updated_at = now() WHERE id = $1 RETURNING id, name, description, color, created_at, updated_at",
    )
    .bind(id)
    .bind(r.name.map(|s| s.trim().to_string()))
    .bind(r.description)
    .bind(r.color)
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(id, "board", None, u.id);
    Ok(Json(b))
}

/// Archive (soft delete). The board can be restored or deleted permanently from the archive.
pub async fn delete_board(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    board_access(&state.db, &u, id).await?.require(perms::BOARD_DELETE)?;
    sqlx::query("UPDATE boards SET archived_at = now() WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(id, "board_deleted", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn restore_board(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    crate::perms::board_access_incl_archived(&state.db, &u, id).await?.require(perms::BOARD_DELETE)?;
    sqlx::query("UPDATE boards SET archived_at = NULL, updated_at = now() WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(id, "board", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Deletes a board for good: every column, card, comment, log entry and attachment (rows and stored files).
pub async fn purge_board(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    crate::perms::board_access_incl_archived(&state.db, &u, id).await?.require(perms::BOARD_DELETE)?;
    let (name,): (String,) = sqlx::query_as("SELECT name FROM boards WHERE id = $1").bind(id).fetch_one(&state.db).await?;
    sqlx::query("DELETE FROM boards WHERE id = $1").bind(id).execute(&state.db).await?;
    let files = crate::files::delete_board_objects(&state.store, id).await;
    tracing::info!(board = %id, %name, user = %u.username, files, "board permanently deleted");
    state.hub.notify(id, "board_deleted", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true, "files_deleted": files })))
}

// ---------- lists ----------

#[derive(Deserialize)]
pub struct CreateList {
    name: String,
}

pub async fn create_list(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
    Json(r): Json<CreateList>,
) -> AppResult<Json<List>> {
    board_access(&state.db, &u, board_id).await?.require(perms::LISTS_MANAGE)?;
    let name = r.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name_required"));
    }
    let last: Option<(String,)> =
        sqlx::query_as(r#"SELECT position FROM lists WHERE board_id = $1 ORDER BY position COLLATE "C" DESC LIMIT 1"#)
            .bind(board_id)
            .fetch_optional(&state.db)
            .await?;
    let pos = position::between(last.as_ref().map(|l| l.0.as_str()), None);
    let list: List = sqlx::query_as(
        "INSERT INTO lists (id, board_id, name, position) VALUES ($1,$2,$3,$4)
         RETURNING id, name, position, color, folded, wip_limit",
    )
    .bind(Uuid::now_v7())
    .bind(board_id)
    .bind(name)
    .bind(pos)
    .fetch_one(&state.db)
    .await?;
    touch_board(&state, board_id).await?;
    state.hub.notify(board_id, "list", None, u.id);
    Ok(Json(list))
}

#[derive(Deserialize)]
pub struct UpdateList {
    name: Option<String>,
    folded: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    color: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    wip_limit: Option<Option<i32>>,
    /// New index among the board's lists (0-based).
    index: Option<usize>,
}

pub async fn update_list(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<UpdateList>,
) -> AppResult<Json<List>> {
    let board_id = board_of_list(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::LISTS_MANAGE)?;
    let mut tx = state.db.begin().await?;
    let new_pos = match r.index {
        Some(index) => {
            let others: Vec<(String,)> = sqlx::query_as(
                r#"SELECT position FROM lists WHERE board_id = $1 AND id <> $2 AND archived_at IS NULL
                   ORDER BY position COLLATE "C" FOR UPDATE"#,
            )
            .bind(board_id)
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
            Some(position_at(&others.into_iter().map(|o| o.0).collect::<Vec<_>>(), index))
        }
        None => None,
    };
    let list: List = sqlx::query_as(
        "UPDATE lists SET name = COALESCE($2, name), folded = COALESCE($3, folded),
            color = CASE WHEN $4 THEN $5 ELSE color END,
            wip_limit = CASE WHEN $6 THEN $7 ELSE wip_limit END,
            position = COALESCE($8, position)
         WHERE id = $1 RETURNING id, name, position, color, folded, wip_limit",
    )
    .bind(id)
    .bind(r.name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    .bind(r.folded)
    .bind(r.color.is_some())
    .bind(r.color.flatten())
    .bind(r.wip_limit.is_some())
    .bind(r.wip_limit.flatten())
    .bind(new_pos)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    state.hub.notify(board_id, "list", None, u.id);
    Ok(Json(list))
}

/// Deletes a column permanently together with ALL its cards (and their attachments' stored files).
/// Works for active and archived columns. Needs `lists.manage`, plus `cards.delete` when it has cards.
pub async fn delete_list(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let board_id = crate::perms::board_of_list_any(&state.db, id).await?;
    let access = board_access(&state.db, &u, board_id).await?;
    access.require(perms::LISTS_MANAGE)?;
    let mut tx = state.db.begin().await?;
    let cards: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM cards WHERE list_id = $1").bind(id).fetch_all(&mut *tx).await?;
    if !cards.is_empty() {
        access.require(perms::CARDS_DELETE)?;
    }
    let mut keys = Vec::new();
    for (cid,) in &cards {
        keys.extend(crate::files::purge_card_rows(&mut tx, *cid, board_id).await?);
    }
    sqlx::query("DELETE FROM lists WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    let files = keys.len();
    crate::files::delete_objects(&state.store, keys).await;
    tracing::info!(list = %id, user = %u.username, cards = cards.len(), files, "column permanently deleted");
    state.hub.notify(board_id, "list", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true, "cards_deleted": cards.len(), "files_deleted": files })))
}

/// Hides a column and everything in it; it can be restored from Board settings → Archive.
pub async fn archive_list(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let board_id = board_of_list(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::LISTS_MANAGE)?;
    sqlx::query("UPDATE lists SET archived_at = now() WHERE id = $1").bind(id).execute(&state.db).await?;
    touch_board(&state, board_id).await?;
    state.hub.notify(board_id, "list", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Brings a column back, as the last column (fresh position so ordering keys never collide).
pub async fn restore_list(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let board_id = crate::perms::board_of_list_any(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::LISTS_MANAGE)?;
    let mut tx = state.db.begin().await?;
    let last: Option<(String,)> = sqlx::query_as(
        r#"SELECT position FROM lists WHERE board_id = $1 AND archived_at IS NULL ORDER BY position COLLATE "C" DESC LIMIT 1 FOR UPDATE"#,
    )
    .bind(board_id)
    .fetch_optional(&mut *tx)
    .await?;
    let pos = position::between(last.as_ref().map(|l| l.0.as_str()), None);
    sqlx::query("UPDATE lists SET archived_at = NULL, position = $2 WHERE id = $1").bind(id).bind(pos).execute(&mut *tx).await?;
    tx.commit().await?;
    state.hub.notify(board_id, "list", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ArchivedList {
    id: Uuid,
    name: String,
    card_count: i64,
    archived_at: DateTime<Utc>,
}

pub async fn archived_lists(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
) -> AppResult<Json<Vec<ArchivedList>>> {
    board_access(&state.db, &u, board_id).await?;
    let rows: Vec<ArchivedList> = sqlx::query_as(
        "SELECT l.id, l.name, l.archived_at,
                (SELECT count(*) FROM cards c WHERE c.list_id = l.id AND c.archived_at IS NULL) AS card_count
         FROM lists l WHERE l.board_id = $1 AND l.archived_at IS NOT NULL ORDER BY l.archived_at DESC",
    )
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

// ---------- personal board order ----------

#[derive(Deserialize)]
pub struct BoardOrder {
    ids: Vec<Uuid>,
}

/// Saves the current user's arrangement of the Boards page.
pub async fn set_board_order(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Json(r): Json<BoardOrder>,
) -> AppResult<Json<serde_json::Value>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM board_prefs WHERE user_id = $1").bind(u.id).execute(&mut *tx).await?;
    // only boards that exist (unknown ids are ignored); visibility is checked when listing anyway
    sqlx::query(
        "INSERT INTO board_prefs (user_id, board_id, position)
         SELECT $1, t.id, t.ord::int FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ord)
         WHERE EXISTS (SELECT 1 FROM boards WHERE id = t.id)",
    )
    .bind(u.id)
    .bind(&r.ids)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Key for inserting at `index` into an ordered list of existing keys.
pub fn position_at(keys: &[String], index: usize) -> String {
    let index = index.min(keys.len());
    let before = if index == 0 { None } else { Some(keys[index - 1].as_str()) };
    let after = keys.get(index).map(String::as_str);
    position::between(before, after)
}

pub async fn touch_board(state: &AppState, board_id: Uuid) -> AppResult<()> {
    sqlx::query("UPDATE boards SET updated_at = now() WHERE id = $1").bind(board_id).execute(&state.db).await?;
    Ok(())
}

// ---------- labels ----------

#[derive(Deserialize)]
pub struct LabelReq {
    name: Option<String>,
    color: Option<String>,
}

pub async fn create_label(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
    Json(r): Json<LabelReq>,
) -> AppResult<Json<Label>> {
    board_access(&state.db, &u, board_id).await?.require(perms::LABELS_MANAGE)?;
    let name = r.name.unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name_required"));
    }
    let l: Label = sqlx::query_as("INSERT INTO labels (id, board_id, name, color) VALUES ($1,$2,$3,$4) RETURNING id, name, color")
        .bind(Uuid::now_v7())
        .bind(board_id)
        .bind(name)
        .bind(r.color.unwrap_or_else(|| "#64748b".into()))
        .fetch_one(&state.db)
        .await?;
    state.hub.notify(board_id, "label", None, u.id);
    Ok(Json(l))
}

pub async fn update_label(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<LabelReq>,
) -> AppResult<Json<Label>> {
    let (board_id,): (Uuid,) = sqlx::query_as("SELECT board_id FROM labels WHERE id = $1").bind(id).fetch_one(&state.db).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::LABELS_MANAGE)?;
    let l: Label = sqlx::query_as(
        "UPDATE labels SET name = COALESCE($2, name), color = COALESCE($3, color) WHERE id = $1 RETURNING id, name, color",
    )
    .bind(id)
    .bind(r.name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    .bind(r.color)
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(board_id, "label", None, u.id);
    Ok(Json(l))
}

pub async fn delete_label(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let (board_id,): (Uuid,) = sqlx::query_as("SELECT board_id FROM labels WHERE id = $1").bind(id).fetch_one(&state.db).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::LABELS_MANAGE)?;
    sqlx::query("DELETE FROM labels WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(board_id, "label", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------- statuses ----------

#[derive(Deserialize)]
pub struct StatusReq {
    name: Option<String>,
    color: Option<String>,
    /// new index among the board's statuses
    index: Option<usize>,
}

pub async fn create_status(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
    Json(r): Json<StatusReq>,
) -> AppResult<Json<Status>> {
    board_access(&state.db, &u, board_id).await?.require(perms::BOARD_MANAGE)?;
    let name = r.name.unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name_required"));
    }
    let st: Status = sqlx::query_as(
        "INSERT INTO board_statuses (id, board_id, name, color, position)
         VALUES ($1,$2,$3,$4,(SELECT coalesce(max(position),-1)+1 FROM board_statuses WHERE board_id = $2))
         RETURNING id, name, color, position",
    )
    .bind(Uuid::now_v7())
    .bind(board_id)
    .bind(name)
    .bind(r.color.unwrap_or_else(|| "#64748b".into()))
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(board_id, "status", None, u.id);
    Ok(Json(st))
}

pub async fn update_status(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<StatusReq>,
) -> AppResult<Json<Status>> {
    let (board_id,): (Uuid,) =
        sqlx::query_as("SELECT board_id FROM board_statuses WHERE id = $1").bind(id).fetch_one(&state.db).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::BOARD_MANAGE)?;
    let mut tx = state.db.begin().await?;
    if let Some(index) = r.index {
        // renumber all statuses with this one at `index`
        let mut ids: Vec<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM board_statuses WHERE board_id = $1 AND id <> $2 ORDER BY position, name FOR UPDATE",
        )
        .bind(board_id)
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
        ids.insert(index.min(ids.len()), (id,));
        for (i, (sid,)) in ids.iter().enumerate() {
            sqlx::query("UPDATE board_statuses SET position = $2 WHERE id = $1").bind(sid).bind(i as i32).execute(&mut *tx).await?;
        }
    }
    let st: Status = sqlx::query_as(
        "UPDATE board_statuses SET name = COALESCE($2, name), color = COALESCE($3, color) WHERE id = $1
         RETURNING id, name, color, position",
    )
    .bind(id)
    .bind(r.name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    .bind(r.color)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    state.hub.notify(board_id, "status", None, u.id);
    Ok(Json(st))
}

pub async fn delete_status(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let (board_id,): (Uuid,) =
        sqlx::query_as("SELECT board_id FROM board_statuses WHERE id = $1").bind(id).fetch_one(&state.db).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::BOARD_MANAGE)?;
    // cards using it fall back to "no status" (FK ON DELETE SET NULL)
    sqlx::query("DELETE FROM board_statuses WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(board_id, "status", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------- sort a column ----------

#[derive(Deserialize)]
pub struct SortReq {
    /// priority | due | created | updated | title | number
    by: String,
    #[serde(default)]
    desc: bool,
}

/// One-off reorder of a column's cards (like Trello's "Sort by…"); manual dragging keeps working afterwards.
pub async fn sort_list(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<SortReq>,
) -> AppResult<Json<serde_json::Value>> {
    let board_id = board_of_list(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_MOVE)?;
    // NULL due dates always go last; ties keep their current order
    let order = match (r.by.as_str(), r.desc) {
        ("priority", false) => "priority ASC",
        ("priority", true) => "priority DESC",
        ("due", false) => "due_at ASC NULLS LAST",
        ("due", true) => "due_at DESC NULLS LAST",
        ("created", false) => "created_at ASC",
        ("created", true) => "created_at DESC",
        ("updated", false) => "updated_at ASC",
        ("updated", true) => "updated_at DESC",
        ("title", false) => "lower(title) ASC",
        ("title", true) => "lower(title) DESC",
        ("number", false) => "number ASC",
        ("number", true) => "number DESC",
        _ => return Err(AppError::BadRequest("invalid_sort")),
    };
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT 1 FROM lists WHERE id = $1 FOR UPDATE").bind(id).execute(&mut *tx).await?;
    let ids: Vec<(Uuid,)> = sqlx::query_as(sqlf!(
        r#"SELECT id FROM cards WHERE list_id = $1 AND archived_at IS NULL ORDER BY {order}, position COLLATE "C""#
    ))
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let mut prev: Option<String> = None;
    for (cid,) in ids {
        let pos = position::between(prev.as_deref(), None);
        sqlx::query("UPDATE cards SET position = $2 WHERE id = $1").bind(cid).bind(&pos).execute(&mut *tx).await?;
        prev = Some(pos);
    }
    tx.commit().await?;
    state.hub.notify(board_id, "list", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------- roles ----------

#[derive(Deserialize)]
pub struct RoleReq {
    name: Option<String>,
    permissions: Option<Vec<String>>,
}

fn clean_perms(p: Vec<String>) -> AppResult<Vec<String>> {
    if let Some(bad) = p.iter().find(|x| !perms::ALL.contains(&x.as_str())) {
        tracing::debug!(%bad, "unknown permission");
        return Err(AppError::BadRequest("invalid_permission"));
    }
    Ok(perms::ALL.iter().filter(|a| p.iter().any(|x| x == *a)).map(|s| s.to_string()).collect())
}

pub async fn create_role(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
    Json(r): Json<RoleReq>,
) -> AppResult<Json<Role>> {
    board_access(&state.db, &u, board_id).await?.require(perms::MEMBERS_MANAGE)?;
    let name = r.name.unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("name_required"));
    }
    let p = clean_perms(r.permissions.unwrap_or_default())?;
    let role: Role = sqlx::query_as(
        "INSERT INTO board_roles (id, board_id, name, permissions, position)
         VALUES ($1,$2,$3,$4,(SELECT coalesce(max(position),0)+1 FROM board_roles WHERE board_id = $2))
         RETURNING id, name, permissions, is_owner",
    )
    .bind(Uuid::now_v7())
    .bind(board_id)
    .bind(name)
    .bind(p)
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(board_id, "role", None, u.id);
    Ok(Json(role))
}

async fn role_board(state: &AppState, id: Uuid) -> AppResult<(Uuid, bool)> {
    Ok(sqlx::query_as("SELECT board_id, is_owner FROM board_roles WHERE id = $1").bind(id).fetch_one(&state.db).await?)
}

pub async fn update_role(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<RoleReq>,
) -> AppResult<Json<Role>> {
    let (board_id, is_owner) = role_board(&state, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::MEMBERS_MANAGE)?;
    if is_owner && r.permissions.is_some() {
        return Err(AppError::BadRequest("owner_role_fixed"));
    }
    let p = r.permissions.map(clean_perms).transpose()?;
    let role: Role = sqlx::query_as(
        "UPDATE board_roles SET name = COALESCE($2, name), permissions = COALESCE($3, permissions) WHERE id = $1
         RETURNING id, name, permissions, is_owner",
    )
    .bind(id)
    .bind(r.name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
    .bind(p)
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(board_id, "role", None, u.id);
    Ok(Json(role))
}

pub async fn delete_role(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let (board_id, is_owner) = role_board(&state, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::MEMBERS_MANAGE)?;
    if is_owner {
        return Err(AppError::BadRequest("owner_role_fixed"));
    }
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM board_members WHERE role_id = $1").bind(id).fetch_one(&state.db).await?;
    if n > 0 {
        return Err(AppError::Conflict("role_in_use"));
    }
    sqlx::query("DELETE FROM board_roles WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(board_id, "role", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------- members ----------

#[derive(Deserialize)]
pub struct MemberReq {
    user_id: Option<Uuid>,
    role_id: Uuid,
}

async fn check_role_on_board(state: &AppState, role_id: Uuid, board_id: Uuid) -> AppResult<bool> {
    let (b, is_owner) = role_board(state, role_id).await?;
    if b != board_id {
        return Err(AppError::BadRequest("invalid_role"));
    }
    Ok(is_owner)
}

/// Only owners (or super admins) may grant or take away the owner role.
fn guard_owner_change(access: &perms::BoardAccess, touches_owner: bool) -> AppResult<()> {
    if touches_owner && !access.is_owner {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

async fn owner_count(state: &AppState, board_id: Uuid) -> AppResult<i64> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM board_members m JOIN board_roles r ON r.id = m.role_id WHERE m.board_id = $1 AND r.is_owner",
    )
    .bind(board_id)
    .fetch_one(&state.db)
    .await?;
    Ok(n)
}

async fn member_is_owner(state: &AppState, board_id: Uuid, user_id: Uuid) -> AppResult<bool> {
    let (o,): (bool,) = sqlx::query_as(
        "SELECT r.is_owner FROM board_members m JOIN board_roles r ON r.id = m.role_id WHERE m.board_id = $1 AND m.user_id = $2",
    )
    .bind(board_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    Ok(o)
}

pub async fn add_member(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
    Json(r): Json<MemberReq>,
) -> AppResult<Json<serde_json::Value>> {
    let access = board_access(&state.db, &u, board_id).await?;
    access.require(perms::MEMBERS_MANAGE)?;
    let user_id = r.user_id.ok_or(AppError::BadRequest("user_required"))?;
    let new_is_owner = check_role_on_board(&state, r.role_id, board_id).await?;
    guard_owner_change(&access, new_is_owner)?;
    sqlx::query("INSERT INTO board_members (board_id, user_id, role_id) SELECT $1, id, $3 FROM users WHERE id = $2 AND is_active")
        .bind(board_id)
        .bind(user_id)
        .bind(r.role_id)
        .execute(&state.db)
        .await
        .map_err(|e| match AppError::from(e) {
            AppError::Conflict(_) => AppError::Conflict("already_member"),
            e => e,
        })?;
    state.hub.notify(board_id, "member", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn update_member(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path((board_id, user_id)): Path<(Uuid, Uuid)>,
    Json(r): Json<MemberReq>,
) -> AppResult<Json<serde_json::Value>> {
    let access = board_access(&state.db, &u, board_id).await?;
    access.require(perms::MEMBERS_MANAGE)?;
    let new_is_owner = check_role_on_board(&state, r.role_id, board_id).await?;
    let was_owner = member_is_owner(&state, board_id, user_id).await?;
    guard_owner_change(&access, new_is_owner || was_owner)?;
    if was_owner && !new_is_owner && owner_count(&state, board_id).await? <= 1 {
        return Err(AppError::Conflict("last_owner"));
    }
    sqlx::query("UPDATE board_members SET role_id = $3 WHERE board_id = $1 AND user_id = $2")
        .bind(board_id)
        .bind(user_id)
        .bind(r.role_id)
        .execute(&state.db)
        .await?;
    state.hub.notify(board_id, "member", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn remove_member(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path((board_id, user_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<serde_json::Value>> {
    let access = board_access(&state.db, &u, board_id).await?;
    // anyone may leave a board; removing others needs members.manage
    if user_id != u.id {
        access.require(perms::MEMBERS_MANAGE)?;
    }
    let was_owner = member_is_owner(&state, board_id, user_id).await?;
    if user_id != u.id {
        guard_owner_change(&access, was_owner)?;
    }
    if was_owner && owner_count(&state, board_id).await? <= 1 {
        return Err(AppError::Conflict("last_owner"));
    }
    sqlx::query("DELETE FROM board_members WHERE board_id = $1 AND user_id = $2")
        .bind(board_id)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM card_assignees a USING cards c WHERE a.card_id = c.id AND c.board_id = $1 AND a.user_id = $2")
        .bind(board_id)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    state.hub.notify(board_id, "member", None, u.id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Distinguishes "field absent" (None) from "field: null" (Some(None)).
pub fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}
