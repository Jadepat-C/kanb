//! Departments (Admin → Departments): super admins create, rename, colour and delete them, and put people in one.
//! Everyone signed in can read the list (names show next to people, and boards can group cards by department).

use axum::{
    Json,
    extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    audit::ClientIp,
    auth::{CurrentUser, SuperAdmin},
    error::{AppError, AppResult},
};

#[derive(Serialize, sqlx::FromRow)]
pub struct Department {
    id: Uuid,
    name: String,
    color: String,
    /// active people in it
    members: i64,
}

/// GET /departments
pub async fn list(State(state): State<AppState>, _u: CurrentUser) -> AppResult<Json<Vec<Department>>> {
    let rows: Vec<Department> = sqlx::query_as(
        "SELECT d.id, d.name, d.color,
                (SELECT count(*) FROM users u WHERE u.department_id = d.id AND u.deleted_at IS NULL AND u.is_active) AS members
         FROM departments d ORDER BY lower(d.name)",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct Upsert {
    name: Option<String>,
    color: Option<String>,
}

fn clean_name(n: &str) -> AppResult<String> {
    let n = n.trim();
    if n.is_empty() {
        return Err(AppError::BadRequest("name_required"));
    }
    Ok(n.chars().take(80).collect())
}

pub async fn create(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, ClientIp(ip): ClientIp, Json(r): Json<Upsert>) -> AppResult<Json<Value>> {
    let name = clean_name(r.name.as_deref().unwrap_or(""))?;
    crate::boards::check_color(r.color.as_deref())?;
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO departments (id, name, color) VALUES ($1, $2, COALESCE($3, '#64748b'))")
        .bind(id)
        .bind(&name)
        .bind(&r.color)
        .execute(&state.db)
        .await
        .map_err(|e| match AppError::from(e) {
            AppError::Conflict(_) => AppError::Conflict("department_exists"),
            e => e,
        })?;
    crate::audit::log(&state, Some(me.id), "department_created", None, ip.as_deref(), json!({ "name": name })).await;
    Ok(Json(json!({ "id": id })))
}

pub async fn update(
    State(state): State<AppState>,
    SuperAdmin(me): SuperAdmin,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
    Json(r): Json<Upsert>,
) -> AppResult<Json<Value>> {
    let name = r.name.as_deref().map(clean_name).transpose()?;
    crate::boards::check_color(r.color.as_deref())?;
    let old: Option<(String,)> = sqlx::query_as("SELECT name FROM departments WHERE id = $1").bind(id).fetch_optional(&state.db).await?;
    let (old,) = old.ok_or(AppError::NotFound)?;
    sqlx::query("UPDATE departments SET name = COALESCE($2, name), color = COALESCE($3, color) WHERE id = $1")
        .bind(id)
        .bind(&name)
        .bind(&r.color)
        .execute(&state.db)
        .await
        .map_err(|e| match AppError::from(e) {
            AppError::Conflict(_) => AppError::Conflict("department_exists"),
            e => e,
        })?;
    if let Some(n) = name.filter(|n| *n != old) {
        crate::audit::log(&state, Some(me.id), "department_renamed", None, ip.as_deref(), json!({ "from": old, "to": n })).await;
    }
    Ok(Json(json!({ "ok": true })))
}

/// The people in it keep their accounts and simply have no department.
pub async fn delete(State(state): State<AppState>, SuperAdmin(me): SuperAdmin, ClientIp(ip): ClientIp, Path(id): Path<Uuid>) -> AppResult<Json<Value>> {
    let gone: Option<(String,)> = sqlx::query_as("DELETE FROM departments WHERE id = $1 RETURNING name").bind(id).fetch_optional(&state.db).await?;
    let (name,) = gone.ok_or(AppError::NotFound)?;
    crate::audit::log(&state, Some(me.id), "department_deleted", None, ip.as_deref(), json!({ "name": name })).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct Members {
    #[serde(default)]
    add: Vec<Uuid>,
    #[serde(default)]
    remove: Vec<Uuid>,
}

/// PUT /admin/departments/{id}/members: put people in it (moving them from any other) or take them out.
pub async fn members(
    State(state): State<AppState>,
    SuperAdmin(me): SuperAdmin,
    ClientIp(ip): ClientIp,
    Path(id): Path<Uuid>,
    Json(r): Json<Members>,
) -> AppResult<Json<Value>> {
    let exists: Option<(String,)> = sqlx::query_as("SELECT name FROM departments WHERE id = $1").bind(id).fetch_optional(&state.db).await?;
    let (name,) = exists.ok_or(AppError::NotFound)?;
    let added = sqlx::query("UPDATE users SET department_id = $1, updated_at = now() WHERE id = ANY($2) AND deleted_at IS NULL AND signup IS NULL")
        .bind(id)
        .bind(&r.add)
        .execute(&state.db)
        .await?
        .rows_affected();
    let removed = sqlx::query("UPDATE users SET department_id = NULL, updated_at = now() WHERE id = ANY($2) AND department_id = $1")
        .bind(id)
        .bind(&r.remove)
        .execute(&state.db)
        .await?
        .rows_affected();
    if added + removed > 0 {
        crate::audit::log(&state, Some(me.id), "department_members", None, ip.as_deref(), json!({ "name": name, "added": added, "removed": removed })).await;
    }
    Ok(Json(json!({ "added": added, "removed": removed })))
}

/// For admin::update_user / create_user: the department must exist.
pub async fn check(db: &sqlx::PgPool, id: Option<Uuid>) -> AppResult<()> {
    if let Some(id) = id {
        let ok: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM departments WHERE id = $1").bind(id).fetch_optional(db).await?;
        if ok.is_none() {
            return Err(AppError::BadRequest("invalid_department"));
        }
    }
    Ok(())
}
