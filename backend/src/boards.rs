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
}

#[derive(Deserialize)]
pub struct BoardsQuery {
    q: Option<String>,
}

/// Boards visible to the user (super admins see all). `q` filters by name/description (substring; works for Thai).
pub async fn list_boards(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Query(q): Query<BoardsQuery>,
) -> AppResult<Json<Vec<BoardListItem>>> {
    let q = q.q.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    let rows: Vec<BoardListItem> = sqlx::query_as(
        "SELECT b.id, b.name, b.description, b.color, b.updated_at,
                EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $1) AS is_member,
                (SELECT count(*) FROM cards c WHERE c.board_id = b.id AND c.archived_at IS NULL) AS card_count,
                (SELECT count(*) FROM board_members m WHERE m.board_id = b.id) AS member_count
         FROM boards b
         WHERE b.archived_at IS NULL
           AND ($2 OR EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $1))
           AND ($3::text IS NULL OR strpos(lower(b.name || ' ' || b.description), $3) > 0)
         ORDER BY b.updated_at DESC",
    )
    .bind(u.id)
    .bind(u.is_super_admin)
    .bind(q)
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
    let board: Board = sqlx::query_as(
        "INSERT INTO boards (id, name, description, color, created_by) VALUES ($1,$2,$3,COALESCE($4,'#6366f1'),$5)
         RETURNING id, name, description, color, created_at, updated_at",
    )
    .bind(Uuid::now_v7())
    .bind(name)
    .bind(r.description.trim())
    .bind(r.color)
    .bind(u.id)
    .fetch_one(&mut *tx)
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
            .execute(&mut *tx)
            .await?;
        if is_owner {
            owner_role = Some(id);
        }
    }
    sqlx::query("INSERT INTO board_members (board_id, user_id, role_id) VALUES ($1,$2,$3)")
        .bind(board.id)
        .bind(u.id)
        .bind(owner_role)
        .execute(&mut *tx)
        .await?;
    let names = r.lists.unwrap_or_else(|| vec!["To Do".into(), "In Progress".into(), "Done".into()]);
    let mut prev: Option<String> = None;
    for n in names.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let pos = position::between(prev.as_deref(), None);
        sqlx::query("INSERT INTO lists (id, board_id, name, position) VALUES ($1,$2,$3,$4)")
            .bind(Uuid::now_v7())
            .bind(board.id)
            .bind(n)
            .bind(&pos)
            .execute(&mut *tx)
            .await?;
        prev = Some(pos);
    }
    tx.commit().await?;
    Ok(Json(board))
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

#[derive(Serialize)]
pub struct BoardDetail {
    board: Board,
    my_permissions: Vec<String>,
    my_role_id: Option<Uuid>,
    all_permissions: Vec<&'static str>,
    lists: Vec<List>,
    cards: Vec<CardSummary>,
    labels: Vec<Label>,
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
        r#"SELECT id, name, position, color, folded, wip_limit FROM lists WHERE board_id = $1 ORDER BY position COLLATE "C""#,
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let cards = load_card_summaries(db, id, None).await?;
    let labels: Vec<Label> = sqlx::query_as("SELECT id, name, color FROM labels WHERE board_id = $1 ORDER BY name")
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
                r#"SELECT position FROM lists WHERE board_id = $1 AND id <> $2 ORDER BY position COLLATE "C" FOR UPDATE"#,
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

pub async fn delete_list(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let board_id = board_of_list(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::LISTS_MANAGE)?;
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM cards WHERE list_id = $1 AND archived_at IS NULL")
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if n > 0 {
        return Err(AppError::Conflict("list_not_empty"));
    }
    sqlx::query("DELETE FROM lists WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(board_id, "list", None, u.id);
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
