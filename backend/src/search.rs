//! Global / per-board search. Plain case-insensitive substring matching: correct for Thai
//! (no word segmentation needed) and fast enough for a small organization.

use axum::{
    Json,
    extract::{Query, State},
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AppState, auth::CurrentUser, error::AppResult};

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    board_id: Option<Uuid>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct BoardHit {
    id: Uuid,
    name: String,
    color: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct CardHit {
    id: Uuid,
    board_id: Uuid,
    board_name: String,
    list_name: String,
    number: i32,
    title: String,
    snippet: String,
}

#[derive(Serialize)]
pub struct SearchResult {
    boards: Vec<BoardHit>,
    cards: Vec<CardHit>,
}

pub async fn search(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Query(q): Query<SearchQuery>,
) -> AppResult<Json<SearchResult>> {
    let term = q.q.trim().to_lowercase();
    if term.is_empty() {
        return Ok(Json(SearchResult { boards: vec![], cards: vec![] }));
    }
    let number: Option<i32> = term.strip_prefix('#').unwrap_or(&term).parse().ok();

    // boards the user can see
    let visible = "SELECT b.id FROM boards b WHERE b.archived_at IS NULL AND
        (($1 AND NOT b.is_tutorial) OR EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = $2))";

    let boards: Vec<BoardHit> = if q.board_id.is_some() {
        vec![]
    } else {
        sqlx::query_as(sqlf!(
            "SELECT id, name, color FROM boards WHERE id IN ({visible})
             AND strpos(lower(name || ' ' || description), $3) > 0 ORDER BY updated_at DESC LIMIT 10"
        ))
        .bind(u.is_super_admin)
        .bind(u.id)
        .bind(&term)
        .fetch_all(&state.db)
        .await?
    };

    // snippet: ~120 chars of the description around the first match (char-based, Thai safe)
    let cards: Vec<CardHit> = sqlx::query_as(sqlf!(
        "SELECT c.id, c.board_id, b.name AS board_name, l.name AS list_name, c.number, c.title,
            CASE WHEN strpos(lower(c.description), $3) > 0
                 THEN substr(c.description, greatest(strpos(lower(c.description), $3) - 40, 1), 120)
                 ELSE left(c.description, 120) END AS snippet
         FROM cards c JOIN boards b ON b.id = c.board_id JOIN lists l ON l.id = c.list_id
         WHERE c.archived_at IS NULL AND l.archived_at IS NULL AND c.board_id IN ({visible})
           AND ($4::uuid IS NULL OR c.board_id = $4)
           AND (strpos(lower(c.title), $3) > 0 OR strpos(lower(c.description), $3) > 0 OR c.number = $5)
         ORDER BY (c.number = $5) DESC NULLS LAST, (strpos(lower(c.title), $3) > 0) DESC, c.updated_at DESC
         LIMIT 30"
    ))
    .bind(u.is_super_admin)
    .bind(u.id)
    .bind(&term)
    .bind(q.board_id)
    .bind(number)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(SearchResult { boards, cards }))
}
