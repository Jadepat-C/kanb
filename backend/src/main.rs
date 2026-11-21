/// `format!` for SQL built only from compile-time constants (column lists etc.) — never user input.
macro_rules! sqlf {
    ($($t:tt)*) => { sqlx::AssertSqlSafe(format!($($t)*)) };
}

mod admin;
mod auth;
mod boards;
mod cards;
mod config;
mod error;
mod files;
mod perms;
mod position;
mod realtime;
mod search;

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

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub origins: Arc<Vec<String>>,
    pub store: Arc<dyn ObjectStore>,
    pub hub: realtime::Hub,
}

#[derive(Parser)]
#[command(version, about = "Kanban server")]
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
    },
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
    let cli = Cli::parse();
    let config = cli.config;

    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .context("connecting to database")?;
    sqlx::migrate!("./migrations").run(&db).await.context("running migrations")?;

    match cli.cmd.unwrap_or(Cmd::Serve) {
        Cmd::CreateAdmin { username, display_name } => {
            let pw = read_password()?;
            let u = admin::insert_user(&db, &username, &display_name, None, &pw, true, true)
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
        Cmd::Serve => serve(db, config).await,
    }
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
    };
    let upload_limit = config.max_upload_mb * 1024 * 1024 + 1024 * 1024;

    let api = Router::new()
        .route("/health", get(health))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/me", get(auth::me).patch(auth::update_me))
        .route("/me/password", post(auth::change_password))
        .route("/users", get(admin::directory))
        .route("/admin/users", get(admin::list_users).post(admin::create_user))
        .route("/admin/users/{id}", patch(admin::update_user))
        .route("/admin/users/{id}/password", post(admin::reset_password))
        .route("/boards", get(boards::list_boards).post(boards::create_board))
        .route("/boards/{id}", get(boards::get_board).patch(boards::update_board).delete(boards::delete_board))
        .route("/boards/{id}/ws", get(realtime::board_ws))
        .route("/boards/{id}/lists", post(boards::create_list))
        .route("/boards/{id}/labels", post(boards::create_label))
        .route("/boards/{id}/roles", post(boards::create_role))
        .route("/boards/{id}/statuses", post(boards::create_status))
        .route("/statuses/{id}", patch(boards::update_status).delete(boards::delete_status))
        .route("/lists/{id}/sort", post(boards::sort_list))
        .route("/boards/{id}/members", post(boards::add_member))
        .route("/boards/{id}/members/{user_id}", patch(boards::update_member).delete(boards::remove_member))
        .route("/lists/{id}", patch(boards::update_list).delete(boards::delete_list))
        .route("/lists/{id}/cards", post(cards::create_card))
        .route("/labels/{id}", patch(boards::update_label).delete(boards::delete_label))
        .route("/roles/{id}", patch(boards::update_role).delete(boards::delete_role))
        .route("/cards/{id}", get(cards::get_card).patch(cards::update_card).delete(cards::archive_card))
        .route("/cards/{id}/move", post(cards::move_card))
        .route("/cards/{id}/duplicate", post(cards::duplicate_card))
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
        .route("/calendar", get(cards::calendar))
        .layer(middleware::from_fn_with_state(state.clone(), auth::csrf_guard))
        .layer(SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-store")));

    let mut app = Router::new().nest("/api", api);

    if !config.static_dir.is_empty() {
        let index = format!("{}/index.html", config.static_dir);
        let spa = ServeDir::new(&config.static_dir).fallback(ServeFile::new(index));
        app = app.fallback_service(spa).layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; \
                 font-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
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
    axum::serve(listener, app)
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
