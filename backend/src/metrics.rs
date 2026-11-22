//! Prometheus metrics, served on their own address (`METRICS_ADDR`, off by default) so they never appear on the
//! public site behind the reverse proxy. Without `METRICS_ADDR` no recorder is installed and every counter below is
//! a no-op.
//!
//! - `kanb_http_requests_total{method,route,status}`, `kanb_http_request_duration_seconds{route}`: API traffic, by
//!   route pattern (`/api/boards/{id}`), never by raw URL, so ids don't create new series
//! - `kanb_sign_ins_total{result}`: ok / failed / two_factor_failed / setup_code_failed
//! - `kanb_notifications_sent_total{channel,result}`: email / contact_point / board_channel / browser_push, ok / failed
//! - `kanb_job_failures_total{job}`: background jobs (due reminders, recurring cards, board channels)
//! - `kanb_internal_errors_total`: requests that ended in a server error
//! - `kanb_websocket_connections{kind}`: open live-update sockets (board / user)
//! - read from the database when scraped: `kanb_users`, `kanb_boards`, `kanb_cards{state}`, `kanb_attachments`,
//!   `kanb_attachment_bytes`, `kanb_db_pool_connections{state}`

use std::{fmt::Write as _, net::SocketAddr, sync::OnceLock, time::Instant};

use anyhow::Context;
use axum::{
    Router,
    extract::{MatchedPath, Request, State},
    http::header,
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
};
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};

use crate::AppState;

static HANDLE: OnceLock<PrometheusHandle> = OnceLock::new();

/// Installs the recorder and serves `GET /metrics` on `addr` (call once, at startup).
pub async fn serve(addr: &str, state: AppState) -> anyhow::Result<()> {
    let addr: SocketAddr = addr.parse().context("METRICS_ADDR")?;
    let recorder = PrometheusBuilder::new()
        .set_buckets_for_metric(
            Matcher::Full("kanb_http_request_duration_seconds".into()),
            &[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
        )?
        .build_recorder();
    let _ = HANDLE.set(recorder.handle());
    metrics::set_global_recorder(recorder).map_err(|e| anyhow::anyhow!("metrics recorder: {e}"))?;
    let listener = tokio::net::TcpListener::bind(addr).await.context("METRICS_ADDR")?;
    tracing::info!(%addr, "metrics on /metrics");
    let app = Router::new().route("/metrics", get(render)).with_state(state);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            tracing::warn!(error = %e, "metrics server stopped");
        }
    });
    Ok(())
}

async fn render(State(state): State<AppState>) -> Response {
    let Some(h) = HANDLE.get() else { return axum::http::StatusCode::NOT_FOUND.into_response() };
    h.run_upkeep();
    let mut out = h.render();
    out.push_str(&db_gauges(&state).await);
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], out).into_response()
}

/// Counts read straight from the database at scrape time (cheap: a few aggregate queries).
async fn db_gauges(state: &AppState) -> String {
    let mut s = String::new();
    let row: Result<(i64, i64, i64, i64, i64, i64), _> = sqlx::query_as(
        "SELECT (SELECT count(*) FROM users WHERE deleted_at IS NULL AND is_active),
                (SELECT count(*) FROM boards WHERE archived_at IS NULL),
                (SELECT count(*) FROM cards WHERE archived_at IS NULL),
                (SELECT count(*) FROM cards WHERE archived_at IS NOT NULL),
                (SELECT count(*) FROM attachments WHERE deleted_at IS NULL),
                (SELECT coalesce(sum(size), 0)::bigint FROM attachments WHERE deleted_at IS NULL)",
    )
    .fetch_one(&state.db)
    .await;
    match row {
        Ok((users, boards, open, archived, files, bytes)) => {
            let _ = write!(
                s,
                "# TYPE kanb_users gauge\nkanb_users {users}\n\
                 # TYPE kanb_boards gauge\nkanb_boards {boards}\n\
                 # TYPE kanb_cards gauge\nkanb_cards{{state=\"open\"}} {open}\nkanb_cards{{state=\"archived\"}} {archived}\n\
                 # TYPE kanb_attachments gauge\nkanb_attachments {files}\n\
                 # TYPE kanb_attachment_bytes gauge\nkanb_attachment_bytes {bytes}\n"
            );
            let _ = writeln!(s, "# TYPE kanb_db_up gauge\nkanb_db_up 1");
        }
        Err(e) => {
            tracing::warn!(error = %e, "metrics: database counts failed");
            let _ = writeln!(s, "# TYPE kanb_db_up gauge\nkanb_db_up 0");
        }
    }
    let (size, idle) = (state.db.size(), state.db.num_idle() as u32);
    let _ = write!(
        s,
        "# TYPE kanb_db_pool_connections gauge\nkanb_db_pool_connections{{state=\"idle\"}} {idle}\nkanb_db_pool_connections{{state=\"busy\"}} {}\n",
        size.saturating_sub(idle)
    );
    s
}

/// Router middleware (as a `route_layer`, so the matched route pattern is known): request count and duration.
pub async fn track(req: Request, next: Next) -> Response {
    let route = req.extensions().get::<MatchedPath>().map(|p| p.as_str().to_owned()).unwrap_or_else(|| "unmatched".into());
    let method = req.method().as_str().to_owned();
    let start = Instant::now();
    let res = next.run(req).await;
    let status = res.status().as_u16().to_string();
    metrics::counter!("kanb_http_requests_total", "method" => method, "route" => route.clone(), "status" => status).increment(1);
    metrics::histogram!("kanb_http_request_duration_seconds", "route" => route).record(start.elapsed().as_secs_f64());
    res
}

pub fn sign_in(result: &'static str) {
    metrics::counter!("kanb_sign_ins_total", "result" => result).increment(1);
}

pub fn delivery(channel: &'static str, ok: bool) {
    metrics::counter!("kanb_notifications_sent_total", "channel" => channel, "result" => if ok { "ok" } else { "failed" }).increment(1);
}

pub fn job_failed(job: &'static str) {
    metrics::counter!("kanb_job_failures_total", "job" => job).increment(1);
}

pub fn internal_error() {
    metrics::counter!("kanb_internal_errors_total").increment(1);
}

/// Counts an open WebSocket for as long as it's alive.
pub struct Socket(&'static str);

impl Socket {
    pub fn open(kind: &'static str) -> Self {
        metrics::gauge!("kanb_websocket_connections", "kind" => kind).increment(1.0);
        Socket(kind)
    }
}

impl Drop for Socket {
    fn drop(&mut self) {
        metrics::gauge!("kanb_websocket_connections", "kind" => self.0).decrement(1.0);
    }
}
