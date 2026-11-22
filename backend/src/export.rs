//! Board export (Board settings → General → Export):
//! - csv:  one row per card, opens in Excel/Sheets (UTF-8 with BOM so Thai shows correctly)
//! - json: the whole board — columns, statuses, labels, members, cards, comments, dependencies, templates
//! - zip:  board.json + cards.csv + every attached file under attachments/<card number>/
//!
//! Anyone who can open the board can export it (it is exactly what they can already see).

use std::io::Write;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Local, Utc};
use object_store::{ObjectStoreExt, path::Path as ObjPath};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::CurrentUser,
    error::{AppError, AppResult},
    perms::board_access_incl_archived,
};

#[derive(Deserialize)]
pub struct ExportQuery {
    format: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct XCard {
    id: Uuid,
    number: i32,
    title: String,
    description: String,
    column: String,
    column_archived: bool,
    status: Option<String>,
    done: bool,
    done_at: Option<DateTime<Utc>>,
    priority: i16,
    color: Option<String>,
    labels: Vec<String>,
    assignees: Vec<String>,
    start_at: Option<DateTime<Utc>>,
    due_at: Option<DateTime<Utc>>,
    waits_for: Vec<i32>,
    created_at: DateTime<Utc>,
    created_by: Option<String>,
    updated_at: DateTime<Utc>,
    archived_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, sqlx::FromRow)]
struct XComment {
    card_id: Uuid,
    author: Option<String>,
    body: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize, sqlx::FromRow)]
struct XFile {
    card_id: Option<Uuid>,
    filename: String,
    content_type: String,
    size: i64,
    inline: bool,
    created_at: DateTime<Utc>,
    #[serde(skip)]
    object_key: String,
    /// where it goes in the ZIP (set by `assign_paths`); empty for files of deleted cards
    #[serde(skip)]
    #[sqlx(skip)]
    path: String,
}

struct Export {
    name: String,
    json: Value,
    cards: Vec<XCard>,
    files: Vec<XFile>,
}

async fn collect(state: &AppState, board_id: Uuid) -> AppResult<Export> {
    let dn = crate::auth::DISPLAY_NAME_SQL;
    let (name, description, color, created_at, archived_at): (String, String, String, DateTime<Utc>, Option<DateTime<Utc>>) =
        sqlx::query_as("SELECT name, description, color, created_at, archived_at FROM boards WHERE id = $1").bind(board_id).fetch_one(&state.db).await?;
    let lists: Vec<(String, Option<String>, Option<i32>, bool)> = sqlx::query_as(
        "SELECT name, color, wip_limit, archived_at IS NOT NULL FROM lists WHERE board_id = $1 ORDER BY archived_at IS NOT NULL, position COLLATE \"C\"",
    )
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    let statuses: Vec<(String, String, bool)> =
        sqlx::query_as("SELECT name, color, is_done FROM board_statuses WHERE board_id = $1 ORDER BY position, name").bind(board_id).fetch_all(&state.db).await?;
    let labels: Vec<(String, String)> = sqlx::query_as("SELECT name, color FROM labels WHERE board_id = $1 ORDER BY name").bind(board_id).fetch_all(&state.db).await?;
    let members: Vec<(String, String, String)> = sqlx::query_as(sqlf!(
        "SELECT {dn}, u.username, r.name FROM board_members m JOIN users u ON u.id = m.user_id JOIN board_roles r ON r.id = m.role_id
         WHERE m.board_id = $1 ORDER BY lower(u.display_name)"
    ))
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    let cards: Vec<XCard> = sqlx::query_as(sqlf!(
        "SELECT c.id, c.number, c.title, c.description, l.name AS column, l.archived_at IS NOT NULL AS column_archived,
                s.name AS status, COALESCE(s.is_done, false) AS done, c.done_at, c.priority, c.color,
                COALESCE((SELECT array_agg(x.name ORDER BY x.name) FROM card_labels cl JOIN labels x ON x.id = cl.label_id WHERE cl.card_id = c.id), '{{}}') AS labels,
                COALESCE((SELECT array_agg({dn} ORDER BY u.display_name) FROM card_assignees a JOIN users u ON u.id = a.user_id WHERE a.card_id = c.id), '{{}}') AS assignees,
                c.start_at, c.due_at,
                COALESCE((SELECT array_agg(p.number ORDER BY p.number) FROM card_dependencies d JOIN cards p ON p.id = d.depends_on WHERE d.card_id = c.id), '{{}}') AS waits_for,
                c.created_at, (SELECT {dn} FROM users u WHERE u.id = c.created_by) AS created_by, c.updated_at, c.archived_at
         FROM cards c JOIN lists l ON l.id = c.list_id LEFT JOIN board_statuses s ON s.id = c.status_id
         WHERE c.board_id = $1 ORDER BY c.number"
    ))
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    let comments: Vec<XComment> = sqlx::query_as(sqlf!(
        "SELECT cm.card_id, (SELECT {dn} FROM users u WHERE u.id = cm.author_id) AS author, cm.body, cm.created_at, cm.updated_at
         FROM comments cm JOIN cards c ON c.id = cm.card_id WHERE c.board_id = $1 AND cm.deleted_at IS NULL ORDER BY cm.created_at"
    ))
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    let mut files: Vec<XFile> = sqlx::query_as(
        "SELECT card_id, filename, content_type, size, is_inline AS inline, created_at, object_key FROM attachments
         WHERE board_id = $1 AND deleted_at IS NULL ORDER BY created_at",
    )
    .bind(board_id)
    .fetch_all(&state.db)
    .await?;
    let templates = crate::templates::for_board(&state.db, board_id).await?;

    assign_paths(&mut files, &cards);
    let number_of = |id: Option<Uuid>| id.and_then(|id| cards.iter().find(|c| c.id == id).map(|c| c.number));
    let json = json!({
        "format": "kanban-board-export", "version": 1, "exported_at": Utc::now(),
        "board": { "name": name, "description": description, "color": color, "created_at": created_at, "archived_at": archived_at },
        "columns": lists.iter().map(|(n, c, w, a)| json!({ "name": n, "color": c, "wip_limit": w, "archived": a })).collect::<Vec<_>>(),
        "statuses": statuses.iter().map(|(n, c, d)| json!({ "name": n, "color": c, "done": d })).collect::<Vec<_>>(),
        "labels": labels.iter().map(|(n, c)| json!({ "name": n, "color": c })).collect::<Vec<_>>(),
        "members": members.iter().map(|(n, u, r)| json!({ "name": n, "username": u, "role": r })).collect::<Vec<_>>(),
        "cards": cards.iter().map(|c| {
            let mut v = serde_json::to_value(c).unwrap_or_default();
            v["comments"] = comments.iter().filter(|m| m.card_id == c.id).map(|m| json!({ "author": m.author, "body": m.body, "created_at": m.created_at, "edited": m.updated_at > m.created_at })).collect();
            v["attachments"] = files.iter().filter(|f| f.card_id == Some(c.id)).map(|f| json!({ "filename": f.filename, "size": f.size, "content_type": f.content_type, "inline": f.inline, "path": f.path })).collect();
            v.as_object_mut().map(|o| o.remove("id"));
            v
        }).collect::<Vec<_>>(),
        "card_templates": templates,
        "files_without_card": files.iter().filter(|f| number_of(f.card_id).is_none()).count(),
    });
    Ok(Export { name, json, cards, files })
}

/// attachments/<card number>/[pasted/]<file name>, unique within the archive: also after unsafe characters are
/// replaced (a?b and a*b both become a_b) and ignoring case (Windows and macOS unzip into case-insensitive folders).
fn assign_paths(files: &mut [XFile], cards: &[XCard]) {
    let mut used = std::collections::HashSet::new();
    for f in files.iter_mut() {
        let Some(number) = f.card_id.and_then(|id| cards.iter().find(|c| c.id == id).map(|c| c.number)) else { continue };
        let mut safe: String = f.filename.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
        if safe.trim_matches('.').trim().is_empty() {
            safe = "file".into(); // "." and ".." would point at a folder
        }
        let dir = format!("attachments/{number}/{}", if f.inline { "pasted/" } else { "" });
        let (stem, ext) = match safe.rsplit_once('.') {
            Some((a, b)) if !a.is_empty() => (a.to_string(), format!(".{b}")),
            _ => (safe.clone(), String::new()),
        };
        for n in 0.. {
            let name = if n == 0 { format!("{dir}{safe}") } else { format!("{dir}{stem} ({n}){ext}") };
            if used.insert(name.to_lowercase()) {
                f.path = name;
                break;
            }
        }
    }
}

fn local(d: &Option<DateTime<Utc>>) -> String {
    d.map(|d| d.with_timezone(&Local).format("%d/%m/%Y %H:%M").to_string()).unwrap_or_default()
}

fn csv(cards: &[XCard]) -> Vec<u8> {
    let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    let mut out = String::from("\u{feff}");
    let head = [
        "Number", "Title", "Column", "Status", "Done", "Priority", "Labels", "Assignees", "Start", "Due", "Finished", "Waits for", "Created", "Created by", "Archived",
        "Description",
    ];
    out += &head.iter().map(|h| q(h)).collect::<Vec<_>>().join(",");
    out += "\r\n";
    for c in cards {
        let row = [
            c.number.to_string(),
            c.title.clone(),
            c.column.clone(),
            c.status.clone().unwrap_or_default(),
            if c.done { "yes".into() } else { String::new() },
            c.priority.to_string(),
            c.labels.join(", "),
            c.assignees.join(", "),
            local(&c.start_at),
            local(&c.due_at),
            local(&c.done_at),
            c.waits_for.iter().map(|n| format!("#{n}")).collect::<Vec<_>>().join(", "),
            local(&Some(c.created_at)),
            c.created_by.clone().unwrap_or_default(),
            local(&c.archived_at),
            c.description.clone(),
        ];
        out += &row.iter().map(|v| q(v)).collect::<Vec<_>>().join(",");
        out += "\r\n";
    }
    out.into_bytes()
}

fn download(bytes_or_body: Body, content_type: &'static str, filename: &str, len: Option<u64>) -> Response {
    let mut resp = bytes_or_body.into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Some(l) = len {
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(l));
    }
    if let Ok(v) = HeaderValue::from_str(&crate::files::content_disposition("attachment", filename)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

pub async fn export_board(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(board_id): Path<Uuid>,
    Query(q): Query<ExportQuery>,
) -> AppResult<Response> {
    board_access_incl_archived(&state.db, &u, board_id).await?;
    let _slot = crate::heavy(&state).await;
    let x = collect(&state, board_id).await?;
    let base = format!("{}-{}", x.name.trim(), Local::now().format("%Y-%m-%d"));
    let format = q.format.as_deref().unwrap_or("json");
    if !matches!(format, "csv" | "json" | "zip") {
        return Err(AppError::BadRequest("invalid_format"));
    }
    tracing::info!(board = %board_id, by = %u.username, format, "board exported");
    match format {
        "csv" => {
            let b = csv(&x.cards);
            let len = b.len() as u64;
            Ok(download(Body::from(b), "text/csv; charset=utf-8", &format!("{base}.csv"), Some(len)))
        }
        "json" => {
            let b = serde_json::to_vec_pretty(&x.json).map_err(|e| anyhow::anyhow!(e))?;
            let len = b.len() as u64;
            Ok(download(Body::from(b), "application/json", &format!("{base}.json"), Some(len)))
        }
        "zip" => {
            // built in a temporary file (attachments can be large), then streamed
            let tmp = tempfile::tempfile().map_err(|e| anyhow::anyhow!(e))?;
            let mut zw = zip::ZipWriter::new(tmp);
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            let put = |zw: &mut zip::ZipWriter<std::fs::File>, name: &str, o: zip::write::SimpleFileOptions, data: &[u8]| -> AppResult<()> {
                tokio::task::block_in_place(|| -> Result<(), anyhow::Error> {
                    zw.start_file(name, o)?;
                    zw.write_all(data)?;
                    Ok(())
                })
                .map_err(AppError::Internal)
            };
            put(&mut zw, "board.json", opts, &serde_json::to_vec_pretty(&x.json).map_err(|e| anyhow::anyhow!(e))?)?;
            put(&mut zw, "cards.csv", opts, &csv(&x.cards))?;
            for f in x.files.iter().filter(|f| !f.path.is_empty()) {
                let bytes = match state.store.get(&ObjPath::from(f.object_key.as_str())).await {
                    Ok(o) => o.bytes().await.map_err(|e| anyhow::anyhow!(e))?,
                    Err(e) => {
                        tracing::warn!(key = %f.object_key, error = %e, "export: file missing from storage");
                        continue;
                    }
                };
                // images and archives are already compressed
                let o = if f.content_type.starts_with("image/") || f.content_type.contains("zip") { stored } else { opts };
                put(&mut zw, &f.path, o, &bytes)?;
            }
            let file = tokio::task::block_in_place(|| zw.finish()).map_err(|e| anyhow::anyhow!(e))?;
            let len = file.metadata().map(|m| m.len()).ok();
            let mut file = tokio::fs::File::from_std(file);
            use tokio::io::AsyncSeekExt;
            file.seek(std::io::SeekFrom::Start(0)).await.map_err(|e| anyhow::anyhow!(e))?;
            let body = Body::from_stream(tokio_util::io::ReaderStream::new(file));
            Ok(download(body, "application/zip", &format!("{base}.zip"), len))
        }
        _ => Err(AppError::BadRequest("invalid_format")),
    }
}
