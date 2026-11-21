//! Board templates (Templates page → Board templates): a blueprint for new boards — columns, statuses, labels,
//! card templates and optionally the cards themselves. Shared by everyone in the organization; anyone who can create
//! boards can make one (from scratch or from an existing board); only its author or a super admin can change it.
//! Also the cross-board card template list for the same page.

use axum::{
    Json,
    extract::{Path, State},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{CurrentUser, User},
    error::{AppError, AppResult},
    perms::{self, board_access},
    position,
};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TList {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub wip_limit: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TNamed {
    pub name: String,
    pub color: String,
    /// statuses only: counts as done
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TCardTemplate {
    pub name: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub priority: i16,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub due_in_days: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct TCard {
    /// index into `lists`
    pub list: usize,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub priority: i16,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Data {
    #[serde(default)]
    pub lists: Vec<TList>,
    #[serde(default)]
    pub statuses: Vec<TNamed>,
    #[serde(default)]
    pub labels: Vec<TNamed>,
    #[serde(default)]
    pub card_templates: Vec<TCardTemplate>,
    #[serde(default)]
    pub cards: Vec<TCard>,
}

fn clean_color(c: &str) -> Option<String> {
    let c = c.trim();
    (c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())).then(|| c.to_lowercase())
}

fn trim_to(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

/// Drops empty / oversized entries so a template always produces a valid board.
fn sanitize(mut d: Data) -> AppResult<Data> {
    d.lists = d
        .lists
        .into_iter()
        .filter(|l| !l.name.trim().is_empty())
        .take(50)
        .map(|l| TList { name: trim_to(&l.name, 100), color: l.color.as_deref().and_then(clean_color), wip_limit: l.wip_limit.filter(|w| (1..=999).contains(w)) })
        .collect();
    if d.lists.is_empty() {
        return Err(AppError::BadRequest("template_needs_column"));
    }
    let named = |v: Vec<TNamed>| -> Vec<TNamed> {
        v.into_iter()
            .filter(|x| !x.name.trim().is_empty())
            .take(50)
            .map(|x| TNamed { name: trim_to(&x.name, 60), color: clean_color(&x.color).unwrap_or_else(|| "#a1a1aa".into()), done: x.done })
            .collect()
    };
    d.statuses = named(d.statuses);
    d.labels = named(d.labels);
    d.card_templates = d
        .card_templates
        .into_iter()
        .filter(|t| !t.title.trim().is_empty())
        .take(100)
        .map(|mut t| {
            t.name = trim_to(if t.name.trim().is_empty() { &t.title } else { &t.name }, 100);
            t.title = trim_to(&t.title, 300);
            t.priority = t.priority.clamp(0, 3);
            t.due_in_days = t.due_in_days.filter(|d| (0..=3650).contains(d));
            t
        })
        .collect();
    let n = d.lists.len();
    d.cards = d
        .cards
        .into_iter()
        .filter(|c| !c.title.trim().is_empty())
        .take(500)
        .map(|mut c| {
            c.list = c.list.min(n - 1);
            c.title = trim_to(&c.title, 300);
            c.priority = c.priority.clamp(0, 3);
            c.color = c.color.as_deref().and_then(clean_color);
            c
        })
        .collect();
    Ok(d)
}

fn can_make(u: &User) -> AppResult<()> {
    if u.is_super_admin || u.can_create_boards { Ok(()) } else { Err(AppError::Forbidden) }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: Uuid,
    name: String,
    description: String,
    color: String,
    data: Value,
    created_by: Option<Uuid>,
    author: Option<String>,
    updated_at: DateTime<Utc>,
}

const SELECT: &str = "SELECT t.id, t.name, t.description, t.color, t.data, t.created_by,
    (SELECT {dn} FROM users u WHERE u.id = t.created_by) AS author, t.updated_at FROM board_templates t";

fn view(r: &Row, u: &User) -> Value {
    let d: Data = serde_json::from_value(r.data.clone()).unwrap_or_default();
    json!({
        "id": r.id, "name": r.name, "description": r.description, "color": r.color, "author": r.author, "updated_at": r.updated_at,
        "can_edit": u.is_super_admin || (r.created_by == Some(u.id) && u.can_create_boards),
        "counts": { "lists": d.lists.len(), "statuses": d.statuses.len(), "labels": d.labels.len(), "card_templates": d.card_templates.len(), "cards": d.cards.len() },
        "data": d,
    })
}

async fn get(state: &AppState, id: Uuid) -> AppResult<Row> {
    Ok(sqlx::query_as(sqlf!("{sel} WHERE t.id = $1", sel = SELECT.replace("{dn}", crate::auth::DISPLAY_NAME_SQL)))
        .bind(id)
        .fetch_one(&state.db)
        .await?)
}

pub async fn list(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Vec<Value>>> {
    let rows: Vec<Row> = sqlx::query_as(sqlf!("{sel} ORDER BY lower(t.name)", sel = SELECT.replace("{dn}", crate::auth::DISPLAY_NAME_SQL)))
        .fetch_all(&state.db)
        .await?;
    Ok(Json(rows.iter().map(|r| view(r, &u)).collect()))
}

#[derive(Deserialize)]
pub struct Req {
    name: Option<String>,
    description: Option<String>,
    color: Option<String>,
    data: Option<Data>,
}

pub async fn create(State(state): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<Req>) -> AppResult<Json<Value>> {
    can_make(&u)?;
    let name = r.name.map(|n| trim_to(&n, 100)).filter(|n| !n.is_empty()).ok_or(AppError::BadRequest("name_required"))?;
    let data = sanitize(r.data.unwrap_or_default())?;
    insert(&state, &u, &name, r.description.as_deref().unwrap_or(""), r.color.as_deref(), data).await
}

async fn insert(state: &AppState, u: &User, name: &str, description: &str, color: Option<&str>, data: Data) -> AppResult<Json<Value>> {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO board_templates (id, name, description, color, data, created_by) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(id)
        .bind(name)
        .bind(trim_to(description, 500))
        .bind(color.and_then(clean_color).unwrap_or_else(|| "#2f5bd3".into()))
        .bind(serde_json::to_value(&data).map_err(|e| anyhow::anyhow!(e))?)
        .bind(u.id)
        .execute(&state.db)
        .await?;
    Ok(Json(view(&get(state, id).await?, u)))
}

pub async fn update(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, Json(r): Json<Req>) -> AppResult<Json<Value>> {
    let old = get(&state, id).await?;
    if !(u.is_super_admin || (old.created_by == Some(u.id) && u.can_create_boards)) {
        return Err(AppError::Forbidden);
    }
    let name = match r.name {
        Some(n) => Some(trim_to(&n, 100)).filter(|n| !n.is_empty()).ok_or(AppError::BadRequest("name_required"))?,
        None => old.name,
    };
    let data = match r.data {
        Some(d) => serde_json::to_value(sanitize(d)?).map_err(|e| anyhow::anyhow!(e))?,
        None => old.data,
    };
    sqlx::query("UPDATE board_templates SET name = $2, description = $3, color = $4, data = $5, updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(name)
        .bind(r.description.map(|d| trim_to(&d, 500)).unwrap_or(old.description))
        .bind(r.color.as_deref().and_then(clean_color).unwrap_or(old.color))
        .bind(data)
        .execute(&state.db)
        .await?;
    Ok(Json(view(&get(&state, id).await?, &u)))
}

pub async fn delete(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let old = get(&state, id).await?;
    if !(u.is_super_admin || (old.created_by == Some(u.id) && u.can_create_boards)) {
        return Err(AppError::Forbidden);
    }
    sqlx::query("DELETE FROM board_templates WHERE id = $1").bind(id).execute(&state.db).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct FromBoard {
    name: Option<String>,
    description: Option<String>,
    #[serde(default)]
    include_cards: bool,
}

/// "Save as board template" from an existing board (any member who can create boards).
pub async fn from_board(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(board_id): Path<Uuid>, Json(r): Json<FromBoard>) -> AppResult<Json<Value>> {
    can_make(&u)?;
    board_access(&state.db, &u, board_id).await?;
    let (bname, bdesc, bcolor): (String, String, String) =
        sqlx::query_as("SELECT name, description, color FROM boards WHERE id = $1").bind(board_id).fetch_one(&state.db).await?;
    let lists: Vec<(Uuid, String, Option<String>, Option<i32>)> = sqlx::query_as(
        "SELECT id, name, color, wip_limit FROM lists WHERE board_id = $1 AND archived_at IS NULL ORDER BY position COLLATE \"C\"",
    )
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    let statuses: Vec<(String, String, bool)> =
        sqlx::query_as("SELECT name, color, is_done FROM board_statuses WHERE board_id = $1 ORDER BY position, name").bind(board_id).fetch_all(&state.db).await?;
    let labels: Vec<(String, String)> = sqlx::query_as("SELECT name, color FROM labels WHERE board_id = $1 ORDER BY name").bind(board_id).fetch_all(&state.db).await?;
    let tpls: Vec<(String, String, String, i16, Option<String>, Vec<String>, Option<i32>)> = sqlx::query_as(
        "SELECT t.name, t.title, t.description, t.priority, s.name,
                COALESCE((SELECT array_agg(l.name ORDER BY l.name) FROM labels l WHERE l.id = ANY(t.label_ids)), '{}'), t.due_in_days
         FROM card_templates t LEFT JOIN board_statuses s ON s.id = t.status_id WHERE t.board_id = $1 ORDER BY lower(t.name)",
    )
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    let mut cards = Vec::new();
    if r.include_cards {
        let rows: Vec<(Uuid, String, String, i16, Option<String>, Vec<String>, Option<String>)> = sqlx::query_as(
            "SELECT c.list_id, c.title, c.description, c.priority, s.name,
                    COALESCE((SELECT array_agg(l.name ORDER BY l.name) FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = c.id), '{}'),
                    c.color
             FROM cards c JOIN lists li ON li.id = c.list_id LEFT JOIN board_statuses s ON s.id = c.status_id
             WHERE c.board_id = $1 AND c.archived_at IS NULL AND li.archived_at IS NULL
             ORDER BY li.position COLLATE \"C\", c.position COLLATE \"C\"",
        )
        .bind(board_id)
        .fetch_all(&state.db)
        .await?;
        for (list_id, title, description, priority, status, labels, color) in rows {
            let Some(list) = lists.iter().position(|l| l.0 == list_id) else { continue };
            cards.push(TCard { list, title, description, priority, status, labels, color });
        }
    }
    let data = sanitize(Data {
        lists: lists.into_iter().map(|(_, name, color, wip_limit)| TList { name, color, wip_limit }).collect(),
        statuses: statuses.into_iter().map(|(name, color, done)| TNamed { name, color, done }).collect(),
        labels: labels.into_iter().map(|(name, color)| TNamed { name, color, done: false }).collect(),
        card_templates: tpls
            .into_iter()
            .map(|(name, title, description, priority, status, labels, due_in_days)| TCardTemplate { name, title, description, priority, status, labels, due_in_days })
            .collect(),
        cards,
    })?;
    let name = r.name.map(|n| trim_to(&n, 100)).filter(|n| !n.is_empty()).unwrap_or(bname);
    insert(&state, &u, &name, r.description.as_deref().unwrap_or(&bdesc), Some(&bcolor), data).await
}

/// Fills a freshly created board (columns already made from `data.lists`) with the template's contents.
pub async fn apply(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    board_id: Uuid,
    user_id: Uuid,
    list_ids: &[Uuid],
    default_status_ids: &[Uuid],
    d: &Data,
) -> AppResult<()> {
    for (i, l) in d.lists.iter().enumerate() {
        if let Some(id) = list_ids.get(i) {
            sqlx::query("UPDATE lists SET color = $2, wip_limit = $3 WHERE id = $1").bind(id).bind(&l.color).bind(l.wip_limit).execute(&mut **tx).await?;
        }
    }
    // statuses: the template's replace the defaults (if it has any)
    let mut statuses: Vec<(String, Uuid)> = Vec::new();
    if d.statuses.is_empty() {
        let rows: Vec<(String, Uuid)> = sqlx::query_as("SELECT name, id FROM board_statuses WHERE board_id = $1").bind(board_id).fetch_all(&mut **tx).await?;
        statuses = rows;
    } else {
        sqlx::query("DELETE FROM board_statuses WHERE id = ANY($1)").bind(default_status_ids).execute(&mut **tx).await?;
        for (i, s) in d.statuses.iter().enumerate() {
            let id = Uuid::now_v7();
            sqlx::query("INSERT INTO board_statuses (id, board_id, name, color, position, is_done) VALUES ($1,$2,$3,$4,$5,$6)")
                .bind(id)
                .bind(board_id)
                .bind(&s.name)
                .bind(&s.color)
                .bind(i as i32)
                .bind(s.done)
                .execute(&mut **tx)
                .await?;
            statuses.push((s.name.clone(), id));
        }
    }
    let status = |n: &Option<String>| n.as_ref().and_then(|n| statuses.iter().find(|s| s.0.eq_ignore_ascii_case(n)).map(|s| s.1));
    let first_status = statuses.first().map(|s| s.1);
    let mut labels: Vec<(String, Uuid)> = Vec::new();
    for l in &d.labels {
        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO labels (id, board_id, name, color) VALUES ($1,$2,$3,$4)").bind(id).bind(board_id).bind(&l.name).bind(&l.color).execute(&mut **tx).await?;
        labels.push((l.name.clone(), id));
    }
    let label_ids = |names: &[String]| -> Vec<Uuid> { names.iter().filter_map(|n| labels.iter().find(|l| l.0.eq_ignore_ascii_case(n)).map(|l| l.1)).collect() };
    for t in &d.card_templates {
        sqlx::query(
            "INSERT INTO card_templates (id, board_id, name, title, description, priority, status_id, label_ids, due_in_days, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        )
        .bind(Uuid::now_v7())
        .bind(board_id)
        .bind(&t.name)
        .bind(&t.title)
        .bind(&t.description)
        .bind(t.priority)
        .bind(status(&t.status))
        .bind(label_ids(&t.labels))
        .bind(t.due_in_days)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    }
    let mut last_pos: Vec<Option<String>> = vec![None; list_ids.len()];
    for (n, c) in d.cards.iter().enumerate() {
        let Some(list_id) = list_ids.get(c.list) else { continue };
        let pos = position::between(last_pos[c.list].as_deref(), None);
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO cards (id, board_id, list_id, number, title, description, position, priority, status_id, color, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        )
        .bind(id)
        .bind(board_id)
        .bind(list_id)
        .bind(n as i32 + 1)
        .bind(&c.title)
        .bind(&c.description)
        .bind(&pos)
        .bind(c.priority)
        .bind(status(&c.status).or(first_status))
        .bind(&c.color)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
        for lid in label_ids(&c.labels) {
            sqlx::query("INSERT INTO card_labels (card_id, label_id) VALUES ($1,$2)").bind(id).bind(lid).execute(&mut **tx).await?;
        }
        last_pos[c.list] = Some(pos);
    }
    sqlx::query("UPDATE boards SET card_seq = $2 WHERE id = $1").bind(board_id).bind(d.cards.len() as i32).execute(&mut **tx).await?;
    sqlx::query("UPDATE cards c SET done_at = now() FROM board_statuses s WHERE s.id = c.status_id AND s.is_done AND c.board_id = $1")
        .bind(board_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub async fn load_data(state: &AppState, id: Uuid) -> AppResult<Data> {
    let (v,): (Value,) = sqlx::query_as("SELECT data FROM board_templates WHERE id = $1").bind(id).fetch_one(&state.db).await?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

// ---------- card templates across boards ----------

/// Every card template on boards I can see, grouped by board (Templates page → Card templates).
pub async fn all_card_templates(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Vec<Value>>> {
    let boards: Vec<(Uuid, String, String, bool)> = sqlx::query_as(
        "SELECT b.id, b.name, b.color,
                ($2 OR COALESCE(r.is_owner OR 'templates.manage' = ANY(r.permissions), false)) AS can_manage
         FROM boards b
         LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = $1
         LEFT JOIN board_roles r ON r.id = m.role_id
         WHERE b.archived_at IS NULL AND ($2 OR m.user_id IS NOT NULL)
         ORDER BY lower(b.name)",
    )
    .bind(u.id)
    .bind(u.is_super_admin)
    .fetch_all(&state.db)
    .await?;
    let mut out = Vec::new();
    for (id, name, color, can_manage) in boards {
        out.push(json!({ "board_id": id, "board_name": name, "board_color": color, "can_manage": can_manage, "templates": crate::templates::for_board(&state.db, id).await? }));
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct CopyReq {
    board_id: Uuid,
}

/// Copy a card template to another board: status matched by name; labels matched by name, missing ones created.
pub async fn copy_card_template(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>, Json(r): Json<CopyReq>) -> AppResult<Json<Value>> {
    let (src_board, t) = crate::templates::get(&state.db, id).await?;
    board_access(&state.db, &u, src_board).await?;
    board_access(&state.db, &u, r.board_id).await?.require(perms::TEMPLATES_MANAGE)?;
    let mut tx = state.db.begin().await?;
    let status: Option<(Uuid,)> = sqlx::query_as(
        "SELECT d.id FROM board_statuses s JOIN board_statuses d ON lower(d.name) = lower(s.name) AND d.board_id = $2 WHERE s.id = $1 LIMIT 1",
    )
    .bind(t.status_id)
    .bind(r.board_id)
    .fetch_optional(&mut *tx)
    .await?;
    let src_labels: Vec<(String, String)> = sqlx::query_as("SELECT name, color FROM labels WHERE id = ANY($1)").bind(&t.label_ids).fetch_all(&mut *tx).await?;
    let mut label_ids = Vec::new();
    for (name, color) in src_labels {
        let found: Option<(Uuid,)> =
            sqlx::query_as("SELECT id FROM labels WHERE board_id = $1 AND lower(name) = lower($2) LIMIT 1").bind(r.board_id).bind(&name).fetch_optional(&mut *tx).await?;
        let lid = match found {
            Some((l,)) => l,
            None => {
                let l = Uuid::now_v7();
                sqlx::query("INSERT INTO labels (id, board_id, name, color) VALUES ($1,$2,$3,$4)").bind(l).bind(r.board_id).bind(&name).bind(&color).execute(&mut *tx).await?;
                l
            }
        };
        label_ids.push(lid);
    }
    let new_id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO card_templates (id, board_id, name, title, description, priority, status_id, label_ids, due_in_days, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    )
    .bind(new_id)
    .bind(r.board_id)
    .bind(&t.name)
    .bind(&t.title)
    .bind(&t.description)
    .bind(t.priority)
    .bind(status.map(|s| s.0))
    .bind(&label_ids)
    .bind(t.due_in_days)
    .bind(u.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    state.hub.notify(r.board_id, "template", None, u.id);
    Ok(Json(json!({ "id": new_id })))
}
