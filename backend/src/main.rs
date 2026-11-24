/// `format!` for SQL built only from compile-time constants (column lists etc.) — never user input.
macro_rules! sqlf {
    ($($t:tt)*) => { sqlx::AssertSqlSafe(format!($($t)*)) };
}

mod admin;
mod admin_tools;
mod audit;
mod auth;
mod avatars;
mod boards;
mod cards;
mod config;
mod error;
mod metrics;
mod files;
mod mail;
mod notify;
mod perms;
mod position;
mod push;
mod realtime;
mod recurring;
mod search;
mod board_contacts;
mod board_templates;
mod contacts;
mod crypto;
mod export;
mod ical;
mod setup;
mod templates;
mod throttle;
mod twofa;
mod tutorial;

use std::{net::SocketAddr, sync::Arc};

use anyhow::Context;
use axum::{
    Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, header},
    middleware,
    routing::{get, patch, post, put},
};
use clap::{Parser, Subcommand};
use object_store::ObjectStore;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};

use crate::config::Config;

#[global_allocator]
static ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub origins: Arc<Vec<String>>,
    pub store: Arc<dyn ObjectStore>,
    pub hub: realtime::Hub,
    pub throttle: Arc<throttle::Limiter>,
    /// first-run setup code (see setup.rs)
    pub setup_code: Arc<String>,
    /// slots for building large responses (see `heavy`)
    pub heavy: Arc<tokio::sync::Semaphore>,
}

/// Waits for a slot to build a large response (board, calendar, export). Building one takes several times its size
/// in memory; on a small server many at once could run out. The work is CPU-bound, so queueing costs no throughput.
pub async fn heavy(state: &AppState) -> tokio::sync::SemaphorePermit<'_> {
    state.heavy.acquire().await.expect("semaphore never closed")
}

/// JSON response serialised while the caller still holds its `heavy` slot (axum's Json would do it afterwards).
pub fn json_now<T: serde::Serialize>(value: &T) -> error::AppResult<axum::response::Response> {
    use axum::response::IntoResponse;
    let body = serde_json::to_vec(value).map_err(|e| anyhow::anyhow!(e))?;
    Ok(([(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], body).into_response())
}

#[derive(Parser)]
#[command(version, about = "Kanb server")]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
    #[command(flatten)]
    config: Config,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the web server (default)
    Serve,
    /// Create a super admin. Password is read from KANBAN_ADMIN_PASSWORD or prompted on stdin.
    CreateAdmin {
        #[arg(long)]
        username: String,
        #[arg(long, default_value = "")]
        display_name: String,
        /// UI language (en or th), also used for the tutorial board
        #[arg(long, default_value = "en")]
        locale: String,
    },
    /// Turn off two-factor sign-in for a user (lost phone); they sign in with the password and can set it up again.
    #[command(name = "reset-2fa")]
    Reset2fa {
        #[arg(long)]
        username: String,
    },
    /// Print a new random SECRET_KEY (for encrypting stored secrets).
    GenKey,
    /// Exit 0 if the server on BIND_ADDR answers /api/health (container health checks; needs no database).
    Healthcheck,
    /// Reset a user's password (same password input as create-admin).
    SetPassword {
        #[arg(long)]
        username: String,
    },
}

fn read_password() -> anyhow::Result<String> {
    if let Ok(p) = std::env::var("KANBAN_ADMIN_PASSWORD") {
        return Ok(p);
    }
    eprint!("Password: ");
    let mut s = String::new();
    std::io::stdin().read_line(&mut s)?;
    Ok(s.trim_end_matches(['\r', '\n']).to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "kanban=info,tower_http=warn".into()),
        )
        .init();
    // needs no database or other settings
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(healthcheck());
    }
    if std::env::args().nth(1).as_deref() == Some("gen-key") {
        println!("{}", crypto::new_key());
        return Ok(());
    }
    let cli = Cli::parse();
    let config = cli.config;
    crypto::init(config.secret_key.as_deref())?;

    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .context("connecting to database")?;
    sqlx::migrate!("./migrations").run(&db).await.context("running migrations")?;

    match cli.cmd.unwrap_or(Cmd::Serve) {
        Cmd::CreateAdmin { username, display_name, locale } => {
            let pw = read_password()?;
            let u = admin::insert_user(&db, &username, &display_name, None, &pw, true, true, &locale, false)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            println!("created super admin {} ({})", u.username, u.id);
            Ok(())
        }
        Cmd::SetPassword { username } => {
            let pw = read_password()?;
            auth::validate_password(&pw).map_err(|e| anyhow::anyhow!("{e}"))?;
            let hash = auth::hash_password(&pw)?;
            let res = sqlx::query("UPDATE users SET password_hash = $2 WHERE lower(username) = lower($1)")
                .bind(&username)
                .bind(hash)
                .execute(&db)
                .await?;
            anyhow::ensure!(res.rows_affected() == 1, "no such user: {username}");
            sqlx::query("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE lower(username) = lower($1))")
                .bind(&username)
                .execute(&db)
                .await?;
            println!("password updated for {username}");
            Ok(())
        }
        Cmd::Reset2fa { username } => {
            let res = sqlx::query(
                "UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
                        totp_recovery = '{}' WHERE lower(username) = lower($1) AND deleted_at IS NULL",
            )
            .bind(&username)
            .execute(&db)
            .await?;
            anyhow::ensure!(res.rows_affected() == 1, "no such user: {username}");
            println!("two-factor sign-in turned off for {username}");
            Ok(())
        }
        Cmd::GenKey | Cmd::Healthcheck => Ok(()),
        Cmd::Serve => {
            crypto::seal_existing(&db).await.context("encrypting stored secrets")?;
            serve(db, config).await
        }
    }
}

/// PostgreSQL can't store the NUL character, so text containing one would fail deep inside a query with a server
/// error. Refuse it up front with a clear one: in the query string, or anywhere in a JSON body.
async fn reject_nul(req: axum::extract::Request, next: middleware::Next) -> axum::response::Response {
    use axum::response::IntoResponse;
    let refuse = |code: &'static str, status| (status, axum::Json(serde_json::json!({ "error": code }))).into_response();
    if req.uri().query().is_some_and(|q| q.contains("%00")) {
        return refuse("invalid_text", axum::http::StatusCode::BAD_REQUEST);
    }
    let json = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.starts_with("application/json"));
    if !json {
        return next.run(req).await;
    }
    let (parts, body) = req.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, 4 * 1024 * 1024).await else {
        return refuse("too_large", axum::http::StatusCode::PAYLOAD_TOO_LARGE);
    };
    // raw control characters aren't valid JSON, so a NUL can only arrive escaped; parse only when that's present
    fn has_nul(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::String(s) => s.contains('\0'),
            serde_json::Value::Array(a) => a.iter().any(has_nul),
            serde_json::Value::Object(o) => o.iter().any(|(k, v)| k.contains('\0') || has_nul(v)),
            _ => false,
        }
    }
    if bytes.windows(6).any(|w| w == b"\\u0000") && serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|v| has_nul(&v)) {
        return refuse("invalid_text", axum::http::StatusCode::BAD_REQUEST);
    }
    next.run(axum::extract::Request::from_parts(parts, axum::body::Body::from(bytes))).await
}

/// `kanban healthcheck`: the image has no shell or curl, so the binary checks itself (plain HTTP to localhost).
fn healthcheck() -> i32 {
    use std::io::{Read, Write};
    let port = std::env::var("BIND_ADDR").ok().and_then(|a| a.rsplit(':').next().and_then(|p| p.parse::<u16>().ok())).unwrap_or(8080);
    let timeout = std::time::Duration::from_secs(3);
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), timeout) else {
        return 1;
    };
    let _ = s.set_read_timeout(Some(timeout));
    if s.write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n").is_err() {
        return 1;
    }
    let mut buf = [0u8; 16];
    let n = s.read(&mut buf).unwrap_or(0);
    let status = String::from_utf8_lossy(&buf[..n]);
    if status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200") { 0 } else { 1 }
}

async fn health(State(state): State<AppState>) -> Result<&'static str, error::AppError> {
    sqlx::query("SELECT 1").execute(&state.db).await?;
    Ok("ok")
}

async fn serve(db: PgPool, config: Config) -> anyhow::Result<()> {
    let store = files::build_store(&config)?;
    let state = AppState {
        db,
        origins: Arc::new(config.origins()),
        config: Arc::new(config.clone()),
        store,
        hub: realtime::Hub::new(),
        throttle: Arc::new(throttle::Limiter::new()),
        setup_code: Arc::new(setup::code(&config)),
        heavy: Arc::new(tokio::sync::Semaphore::new(config.heavy_requests.max(1))),
    };
    setup::announce(&state).await;
    if let Some(addr) = config.metrics_addr.as_deref().filter(|a| !a.trim().is_empty()) {
        metrics::serve(addr, state.clone()).await?;
    }
    notify::spawn_due_job(state.clone());
    board_contacts::spawn_dispatch(state.clone());
    recurring::spawn_job(state.clone());
    audit::spawn_pruner(state.clone());
    let _ = admin_tools::STARTED.set(chrono::Utc::now());
    let upload_limit = config.max_upload_mb * 1024 * 1024 + 1024 * 1024;

    let api = Router::new()
        .route("/health", get(health))
        .route("/auth/login", post(auth::login))
        .route("/auth/setup", post(setup::create_first_admin))
        .route("/auth/login/code", post(twofa::login_code))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/options", get(auth::options))
        .route("/auth/forgot", post(auth::forgot))
        .route("/auth/reset/check", post(auth::check_token))
        .route("/auth/reset", post(auth::reset))
        .route("/admin/email", get(mail::get_settings).put(mail::save_settings))
        .route("/admin/email/test", post(mail::test))
        .route("/me", get(auth::me).patch(auth::update_me))
        .route("/me/password", post(auth::change_password))
        .route("/me/contact-points", get(contacts::list).post(contacts::create))
        .route("/me/contact-points/test", post(contacts::test))
        .route("/me/contact-points/{id}", patch(contacts::update).delete(contacts::delete))
        .route("/me/calendar-feed", get(ical::status).post(ical::reset).patch(ical::update).delete(ical::disable))
        .route("/cards/{id}/calendar", axum::routing::put(ical::pick))
        .route("/calendar/{file}", get(ical::feed))
        .route("/push", get(push::info))
        .route("/me/push", post(push::subscribe).delete(push::unsubscribe))
        .route("/me/push/test", post(push::test))
        .route("/me/2fa/setup", post(twofa::setup))
        .route("/me/2fa/enable", post(twofa::enable))
        .route("/me/2fa/disable", post(twofa::disable))
        .route("/me/2fa/recovery", post(twofa::regenerate_codes))
        .route("/me/tutorial", post(tutorial::create_for_me))
        .route("/me/avatar", post(avatars::upload).delete(avatars::remove).layer(DefaultBodyLimit::max(11 * 1024 * 1024)))
        .route("/avatars/{id}", get(avatars::serve))
        .route("/users", get(admin::directory))
        .route("/admin/users", get(admin::list_users).post(admin::create_user))
        .route("/admin/users/{id}", patch(admin::update_user).delete(admin::delete_user))
        .route("/admin/users/{id}/delete-preview", get(admin::delete_preview))
        .route("/admin/users/{id}/send-reset", post(admin::send_reset))
        .route("/admin/users/{id}/password", post(admin::reset_password))
        .route("/admin/users/{id}/2fa", axum::routing::delete(twofa::admin_reset))
        .route("/admin/notifications", get(contacts::admin_get).put(contacts::admin_save))
        .route("/admin/storage", get(files::storage_report))
        .route("/admin/security", get(admin::get_security).put(admin::save_security))
        .route("/admin/audit", get(audit::list))
        .route("/admin/users/{id}/sessions", get(admin_tools::sessions).delete(admin_tools::revoke_all))
        .route("/admin/sessions/{id}", axum::routing::delete(admin_tools::revoke_one))
        .route("/me/sessions", get(admin_tools::my_sessions).delete(admin_tools::revoke_my_others))
        .route("/me/sessions/{id}", axum::routing::delete(admin_tools::revoke_my_one))
        .route("/admin/boards", get(admin_tools::boards))
        .route("/admin/boards/{id}/owners", post(admin_tools::add_owner))
        .route("/admin/system", get(admin_tools::system))
        .route("/admin/announcement", get(admin_tools::admin_announcement).put(admin_tools::save_announcement))
        .route("/announcement", get(admin_tools::announcement))
        .route("/boards", get(boards::list_boards).post(boards::create_board))
        .route("/boards/{id}", get(boards::get_board).patch(boards::update_board).delete(boards::delete_board))
        .route("/boards/{id}/ws", get(realtime::board_ws))
        .route("/boards/{id}/restore", post(boards::restore_board))
        .route("/boards/{id}/permanent", axum::routing::delete(boards::purge_board))
        .route("/boards/{id}/archived-cards", get(cards::archived_cards))
        .route("/boards/{id}/lists", post(boards::create_list))
        .route("/boards/{id}/labels", post(boards::create_label))
        .route("/boards/{id}/roles", post(boards::create_role))
        .route("/boards/{id}/statuses", post(boards::create_status))
        .route("/boards/{id}/templates", post(templates::create))
        .route("/boards/{id}/recurrences", get(recurring::list).post(recurring::create))
        .route("/recurrences/{id}", patch(recurring::update).delete(recurring::delete))
        .route("/boards/{id}/contact-points", get(board_contacts::list).post(board_contacts::create))
        .route("/boards/{id}/contact-points/test", post(board_contacts::test))
        .route("/board-contact-points/{id}", patch(board_contacts::update).delete(board_contacts::delete))
        .route("/templates/{id}", patch(templates::update).delete(templates::delete))
        .route("/cards/{id}/save-template", post(templates::from_card))
        .route("/cards/{id}/dependencies", axum::routing::put(cards::set_dependencies))
        .route("/card-templates", get(board_templates::all_card_templates))
        .route("/templates/{id}/copy", post(board_templates::copy_card_template))
        .route("/board-templates", get(board_templates::list).post(board_templates::create))
        .route("/board-templates/{id}", patch(board_templates::update).delete(board_templates::delete))
        .route("/boards/{id}/save-as-template", post(board_templates::from_board))
        .route("/boards/{id}/export", get(export::export_board))
        .route("/statuses/{id}", patch(boards::update_status).delete(boards::delete_status))
        .route("/lists/{id}/sort", post(boards::sort_list))
        .route("/lists/{id}/archive", post(boards::archive_list))
        .route("/lists/{id}/restore", post(boards::restore_list))
        .route("/boards/{id}/archived-lists", get(boards::archived_lists))
        .route("/boards-order", put(boards::set_board_order))
        .route("/boards/{id}/members", post(boards::add_member))
        .route("/boards/{id}/members/{user_id}", patch(boards::update_member).delete(boards::remove_member))
        .route("/lists/{id}", patch(boards::update_list).delete(boards::delete_list))
        .route("/lists/{id}/cards", post(cards::create_card))
        .route("/labels/{id}", patch(boards::update_label).delete(boards::delete_label))
        .route("/roles/{id}", patch(boards::update_role).delete(boards::delete_role))
        .route("/cards/{id}", get(cards::get_card).patch(cards::update_card).delete(cards::archive_card))
        .route("/cards/{id}/move", post(cards::move_card))
        .route("/cards/{id}/duplicate", post(cards::duplicate_card))
        .route("/cards/{id}/restore", post(cards::restore_card))
        .route("/cards/{id}/permanent", axum::routing::delete(cards::purge_card))
        .route("/cards/{id}/labels", put(cards::set_labels))
        .route("/cards/{id}/assignees", put(cards::set_assignees))
        .route("/cards/{id}/timeline", get(cards::timeline))
        .route("/cards/{id}/comments", post(cards::create_comment))
        .route(
            "/cards/{id}/attachments",
            post(files::upload).layer(DefaultBodyLimit::max(upload_limit)),
        )
        .route("/comments/{id}", patch(cards::update_comment).delete(cards::delete_comment))
        .route("/files/{id}", get(files::download))
        .route("/attachments/{id}", axum::routing::delete(files::delete_attachment))
        .route("/search", get(search::search))
        .route("/notifications", get(notify::list))
        .route("/notifications/read", post(notify::mark_read))
        .route("/notifications/ws", get(realtime::user_ws))
        .route("/calendar", get(cards::calendar))
        .route_layer(middleware::from_fn(metrics::track))
        .layer(middleware::from_fn_with_state(state.clone(), auth::csrf_guard))
        .layer(middleware::from_fn(reject_nul))
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-store")));

    let mut app = Router::new().nest("/api", api);

    if !config.static_dir.is_empty() {
        let index = format!("{}/index.html", config.static_dir);
        let spa = ServeDir::new(&config.static_dir).fallback(ServeFile::new(index));
        app = app.fallback_service(spa).layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; \
                 font-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
            ),
        ));
    }

    let app = app
        .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY, HeaderValue::from_static("same-origin")))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = config.bind_addr.parse().context("BIND_ADDR")?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "listening");
    // the peer address feeds the sign-in rate limits (throttle.rs)
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// SIGINT (Ctrl+C) or SIGTERM (`docker stop`).
async fn shutdown_signal() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}
