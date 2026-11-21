//! Card templates: per-board blueprints (title, Markdown description/checklist, priority, status, labels,
//! "due N days after creation"). Anyone who can create cards can use and manage them.

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
    auth::CurrentUser,
    error::{AppError, AppResult},
    perms::{self, board_access, board_of_card},
};

#[derive(Serialize, sqlx::FromRow, Clone)]
pub struct Template {
    pub id: Uuid,
    pub name: String,
    pub title: String,
    pub description: String,
    pub priority: i16,
    pub status_id: Option<Uuid>,
    pub label_ids: Vec<Uuid>,
    pub due_in_days: Option<i32>,
    pub updated_at: DateTime<Utc>,
}

const COLS: &str = "id, name, title, description, priority, status_id, label_ids, due_in_days, updated_at";

pub async fn for_board(db: &sqlx::PgPool, board_id: Uuid) -> AppResult<Vec<Template>> {
    Ok(sqlx::query_as(sqlf!("SELECT {COLS} FROM card_templates WHERE board_id = $1 ORDER BY lower(name)"))
        .bind(board_id)
        .fetch_all(db)
        .await?)
}

pub async fn get(db: &sqlx::PgPool, id: Uuid) -> AppResult<(Uuid, Template)> {
    let (board_id,): (Uuid,) = sqlx::query_as("SELECT board_id FROM card_templates WHERE id = $1").bind(id).fetch_one(db).await?;
    let t: Template = sqlx::query_as(sqlf!("SELECT {COLS} FROM card_templates WHERE id = $1")).bind(id).fetch_one(db).await?;
    Ok((board_id, t))
}

#[derive(Deserialize)]
pub struct TemplateReq {
    name: Option<String>,
    title: Option<String>,
    description: Option<String>,
    priority: Option<i16>,
    #[serde(default, deserialize_with = "crate::boards::double_option")]
    status_id: Option<Option<Uuid>>,
    label_ids: Option<Vec<Uuid>>,
    #[serde(default, deserialize_with = "crate::boards::double_option")]
    due_in_days: Option<Option<i32>>,
}

/// Keeps only statuses/labels that belong to the board, and sane numbers.
async fn validate(state: &AppState, board_id: Uuid, r: &mut TemplateReq) -> AppResult<()> {
    if r.priority.is_some_and(|p| !(0..=3).contains(&p)) {
        return Err(AppError::BadRequest("invalid_priority"));
    }
    if let Some(Some(d)) = r.due_in_days
        && !(0..=3650).contains(&d)
    {
        return Err(AppError::BadRequest("invalid_due_days"));
    }
    if let Some(Some(sid)) = r.status_id {
        let ok: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM board_statuses WHERE id = $1 AND board_id = $2")
            .bind(sid)
            .bind(board_id)
            .fetch_optional(&state.db)
            .await?;
        if ok.is_none() {
            r.status_id = Some(None);
        }
    }
    if let Some(ids) = &r.label_ids {
        let valid: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM labels WHERE board_id = $1 AND id = ANY($2)")
            .bind(board_id)
            .bind(ids)
            .fetch_all(&state.db)
            .await?;
        r.label_ids = Some(ids.iter().copied().filter(|i| valid.iter().any(|v| v.0 == *i)).collect());
    }
    Ok(())
}

pub async fn create(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
    Json(mut r): Json<TemplateReq>,
) -> AppResult<Json<Template>> {
    board_access(&state.db, &u, board_id).await?.require(perms::TEMPLATES_MANAGE)?;
    validate(&state, board_id, &mut r).await?;
    let title = r.title.clone().unwrap_or_default().trim().to_string();
    let name = r.name.clone().map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| title.clone());
    if name.is_empty() || title.is_empty() {
        return Err(AppError::BadRequest("name_required"));
    }
    let t: Template = sqlx::query_as(sqlf!(
        "INSERT INTO card_templates (id, board_id, name, title, description, priority, status_id, label_ids, due_in_days, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING {COLS}"
    ))
    .bind(Uuid::now_v7())
    .bind(board_id)
    .bind(name)
    .bind(title)
    .bind(r.description.unwrap_or_default())
    .bind(r.priority.unwrap_or(0))
    .bind(r.status_id.flatten())
    .bind(r.label_ids.unwrap_or_default())
    .bind(r.due_in_days.flatten())
    .bind(u.id)
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(board_id, "template", None, u.id);
    Ok(Json(t))
}

pub async fn update(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Json(mut r): Json<TemplateReq>,
) -> AppResult<Json<Template>> {
    let (board_id, _) = get(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::TEMPLATES_MANAGE)?;
    validate(&state, board_id, &mut r).await?;
    if r.name.as_deref().is_some_and(|n| n.trim().is_empty()) || r.title.as_deref().is_some_and(|t| t.trim().is_empty()) {
        return Err(AppError::BadRequest("name_required"));
    }
    let t: Template = sqlx::query_as(sqlf!(
        "UPDATE card_templates SET name = COALESCE($2, name), title = COALESCE($3, title), description = COALESCE($4, description),
            priority = COALESCE($5, priority),
            status_id = CASE WHEN $6 THEN $7 ELSE status_id END,
            label_ids = COALESCE($8, label_ids),
            due_in_days = CASE WHEN $9 THEN $10 ELSE due_in_days END,
            updated_at = now()
         WHERE id = $1 RETURNING {COLS}"
    ))
    .bind(id)
    .bind(r.name.map(|s| s.trim().to_string()))
    .bind(r.title.map(|s| s.trim().to_string()))
    .bind(r.description)
    .bind(r.priority)
    .bind(r.status_id.is_some())
    .bind(r.status_id.flatten())
    .bind(r.label_ids)
    .bind(r.due_in_days.is_some())
    .bind(r.due_in_days.flatten())
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(board_id, "template", None, u.id);
    Ok(Json(t))
}

pub async fn delete(State(state): State<AppState>, CurrentUser(u): CurrentUser, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let (board_id, _) = get(&state.db, id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::TEMPLATES_MANAGE)?;
    sqlx::query("DELETE FROM card_templates WHERE id = $1").bind(id).execute(&state.db).await?;
    state.hub.notify(board_id, "template", None, u.id);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct FromCardReq {
    name: Option<String>,
    due_in_days: Option<i32>,
}

/// "Save as template" from an existing card.
pub async fn from_card(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(card_id): Path<Uuid>,
    Json(r): Json<FromCardReq>,
) -> AppResult<Json<Template>> {
    let board_id = board_of_card(&state.db, card_id).await?;
    board_access(&state.db, &u, board_id).await?.require(perms::CARDS_CREATE)?;
    if r.due_in_days.is_some_and(|d| !(0..=3650).contains(&d)) {
        return Err(AppError::BadRequest("invalid_due_days"));
    }
    let t: Template = sqlx::query_as(sqlf!(
        "INSERT INTO card_templates (id, board_id, name, title, description, priority, status_id, label_ids, due_in_days, created_by)
         SELECT $2, c.board_id, COALESCE(NULLIF(trim($3), ''), c.title), c.title, c.description, c.priority, c.status_id,
                COALESCE((SELECT array_agg(label_id) FROM card_labels WHERE card_id = c.id), '{{}}'), $4, $5
         FROM cards c WHERE c.id = $1
         RETURNING {COLS}"
    ))
    .bind(card_id)
    .bind(Uuid::now_v7())
    .bind(r.name.unwrap_or_default())
    .bind(r.due_in_days)
    .bind(u.id)
    .fetch_one(&state.db)
    .await?;
    state.hub.notify(board_id, "template", None, u.id);
    Ok(Json(t))
}
