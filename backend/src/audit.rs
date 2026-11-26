//! Activity log for super admins: sign-ins (and failed ones), account and settings changes, board ownership.
//! Writing never fails a request: a database hiccup only leaves a warning in the server log.
//! Nothing secret goes in: settings changes record which fields changed, never their values.

use std::net::SocketAddr;

use axum::{
    Json,
    extract::{ConnectInfo, FromRequestParts, Query, State},
    http::request::Parts,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{AppState, auth::SuperAdmin, error::AppResult};

/// Entries older than this are deleted (checked daily).
const KEEP_DAYS: i32 = 365;

/// The client's address, by the same proxy rules as the rate limits (TRUST_PROXY).
pub struct ClientIp(pub Option<String>);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        Ok(ClientIp(peer.map(|p| crate::throttle::client_ip(p, &parts.headers, state.config.trust_proxy).to_string())))
    }
}

/// Records one event. `target` is the user or board it was about.
pub async fn log(state: &AppState, actor: Option<Uuid>, kind: &str, target: Option<Uuid>, ip: Option<&str>, data: Value) {
    let r = sqlx::query("INSERT INTO audit_log (actor_id, kind, target_id, ip, data) VALUES ($1, $2, $3, $4, $5)")
        .bind(actor)
        .bind(kind)
        .bind(target)
        .bind(ip)
        .bind(data)
        .execute(&state.db)
        .await;
    if let Err(e) = r {
        tracing::warn!(error = %e, kind, "could not write the activity log");
    }
}

/// Names of the fields that differ between two JSON objects (for settings changes: which, not what).
pub fn changed_fields(before: &Value, after: &Value) -> Vec<String> {
    let (Some(a), Some(b)) = (before.as_object(), after.as_object()) else { return vec![] };
    let mut keys: Vec<String> = a.keys().chain(b.keys()).filter(|k| a.get(*k) != b.get(*k)).cloned().collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Daily: drop entries older than a year.
pub fn spawn_pruner(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(24 * 3600));
        loop {
            tick.tick().await;
            match sqlx::query("DELETE FROM audit_log WHERE at < now() - make_interval(days => $1)").bind(KEEP_DAYS).execute(&state.db).await {
                Ok(r) if r.rows_affected() > 0 => tracing::info!(deleted = r.rows_affected(), "old activity log entries removed"),
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "activity log cleanup failed"),
            }
        }
    });
}

// ---------- reading ----------

/// Kinds by topic, for the filter on the Activity page.
const TOPICS: &[(&str, &[&str])] = &[
    ("signin", &["sign_in", "sign_out"]),
    ("failed", &["sign_in_failed", "totp_failed"]),
    ("account", &["password_changed", "password_reset", "twofa_enabled", "twofa_disabled", "recovery_code_used"]),
    ("signups", &["signed_up", "email_confirmed", "signup_approved", "signup_rejected"]),
    ("users", &["user_created", "user_updated", "user_deleted", "user_password_reset", "user_reset_link_sent", "user_twofa_reset", "sessions_revoked"]),
    ("settings", &["settings_changed"]),
    ("boards", &["board_owner_added", "board_deleted", "board_imported", "board_shared", "board_unshared", "board_share_reset", "board_share_changed"]),
];

#[derive(Deserialize)]
pub struct ListQuery {
    /// a topic from TOPICS
    topic: Option<String>,
    /// only events by or about this user
    user: Option<Uuid>,
    /// paging: entries older than this id
    before: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Entry {
    id: i64,
    at: DateTime<Utc>,
    kind: String,
    actor_id: Option<Uuid>,
    actor_name: Option<String>,
    target_id: Option<Uuid>,
    /// the target user's or board's name
    target_name: Option<String>,
    ip: Option<String>,
    data: Value,
}

const PAGE: i64 = 100;

pub async fn list(State(state): State<AppState>, _a: SuperAdmin, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    let kinds: Option<Vec<String>> = q
        .topic
        .as_deref()
        .and_then(|t| TOPICS.iter().find(|(name, _)| *name == t))
        .map(|(_, k)| k.iter().map(|s| s.to_string()).collect());
    let dn = crate::auth::DISPLAY_NAME_SQL;
    let rows: Vec<Entry> = sqlx::query_as(sqlf!(
        "SELECT a.id, a.at, a.kind, a.actor_id, a.target_id, a.ip, a.data,
                (SELECT {dn} FROM users u WHERE u.id = a.actor_id) AS actor_name,
                COALESCE((SELECT {dn} FROM users u WHERE u.id = a.target_id), (SELECT b.name FROM boards b WHERE b.id = a.target_id),
                         a.data->>'board_name') AS target_name
         FROM audit_log a
         WHERE ($1::text[] IS NULL OR a.kind = ANY($1))
           AND ($2::uuid IS NULL OR a.actor_id = $2 OR a.target_id = $2)
           AND ($3::bigint IS NULL OR a.id < $3)
         ORDER BY a.id DESC LIMIT $4"
    ))
    .bind(kinds)
    .bind(q.user)
    .bind(q.before)
    .bind(PAGE + 1)
    .fetch_all(&state.db)
    .await?;
    let more = rows.len() as i64 > PAGE;
    let rows: Vec<Entry> = rows.into_iter().take(PAGE as usize).collect();
    Ok(Json(json!({ "entries": rows, "more": more, "topics": TOPICS.iter().map(|(t, _)| *t).collect::<Vec<_>>() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_fields_lists_names_only() {
        let a = json!({ "host": "a", "password": "old", "port": 587 });
        let b = json!({ "host": "a", "password": "new", "port": 465, "extra": true });
        assert_eq!(changed_fields(&a, &b), vec!["extra", "password", "port"]);
    }

    #[test]
    fn every_kind_is_in_one_topic() {
        let mut all: Vec<&str> = TOPICS.iter().flat_map(|(_, k)| k.iter().copied()).collect();
        let n = all.len();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), n);
    }
}
