use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

/// API errors carry a stable machine-readable `code`; the frontend translates it (EN/TH).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    /// two-factor sign-in is required and this account hasn't set it up yet
    #[error("two-factor sign-in required")]
    TwoFactorRequired,
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(&'static str),
    /// a wrong password / two-factor code / setup code at sign-in: 401 so fail2ban, CrowdSec and the like recognise
    /// a brute-force attempt, with a code the sign-in page can show
    #[error("{0}")]
    SignInFailed(&'static str),
    #[error("{0}")]
    Conflict(&'static str),
    #[error("payload too large")]
    TooLarge,
    /// uploads together reached MAX_STORAGE_GB
    #[error("storage full")]
    StorageFull,
    /// rate limited; seconds until the next attempt is allowed
    #[error("too many attempts")]
    TooManyRequests(u64),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::RowNotFound => AppError::NotFound,
            sqlx::Error::Database(db) if db.is_unique_violation() => AppError::Conflict("already_exists"),
            _ => AppError::Internal(e.into()),
        }
    }
}

impl From<object_store::Error> for AppError {
    fn from(e: object_store::Error) -> Self {
        match e {
            object_store::Error::NotFound { .. } => AppError::NotFound,
            other => AppError::Internal(other.into()),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            AppError::TwoFactorRequired => (StatusCode::FORBIDDEN, "two_factor_required"),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            AppError::BadRequest(c) => (StatusCode::BAD_REQUEST, *c),
            AppError::SignInFailed(c) => (StatusCode::UNAUTHORIZED, *c),
            AppError::Conflict(c) => (StatusCode::CONFLICT, *c),
            AppError::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
            // 413, not 507: a full budget is expected behaviour, not a server fault (5xx is logged and counted as one)
            AppError::StorageFull => (StatusCode::PAYLOAD_TOO_LARGE, "storage_full"),
            AppError::TooManyRequests(secs) => {
                let mut r = (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": "too_many_attempts", "retry_after": secs }))).into_response();
                if let Ok(v) = axum::http::HeaderValue::from_str(&secs.to_string()) {
                    r.headers_mut().insert(axum::http::header::RETRY_AFTER, v);
                }
                return r;
            }
            AppError::Internal(e) => {
                tracing::error!(error = ?e, "internal error");
                crate::metrics::internal_error();
                (StatusCode::INTERNAL_SERVER_ERROR, "internal")
            }
        };
        (status, Json(json!({ "error": code }))).into_response()
    }
}
