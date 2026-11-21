//! Attachments. The object store is private: every upload and download streams through
//! this service, which checks board permissions first. Nothing is presigned or public.

use std::sync::Arc;

use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures::TryStreamExt;
use object_store::{
    ObjectStore, ObjectStoreExt, PutPayload, WriteMultipart, aws::AmazonS3Builder, path::Path as ObjPath,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::CurrentUser,
    cards::{Attachment, log_event},
    config::Config,
    error::{AppError, AppResult},
    perms::{self, board_access, board_of_card},
};

/// Only these are ever rendered inline by the browser; everything else (incl. SVG/HTML) is a download.
const INLINE_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const MULTIPART_THRESHOLD: usize = 8 * 1024 * 1024;

pub fn build_store(c: &Config) -> anyhow::Result<Arc<dyn ObjectStore>> {
    let s3 = AmazonS3Builder::new()
        .with_endpoint(&c.s3_endpoint)
        .with_allow_http(true)
        .with_virtual_hosted_style_request(false)
        .with_bucket_name(&c.s3_bucket)
        .with_region(&c.s3_region)
        .with_access_key_id(&c.s3_access_key)
        .with_secret_access_key(&c.s3_secret_key)
        .build()?;
    Ok(Arc::new(s3))
}

fn clean_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let s: String = base.chars().filter(|c| !c.is_control() && *c != '"').take(200).collect();
    let s = s.trim().to_string();
    if s.is_empty() { "file".into() } else { s }
}

#[derive(Deserialize)]
pub struct UploadQuery {
    inline: Option<String>,
}

pub async fn upload(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(card_id): Path<Uuid>,
    Query(q): Query<UploadQuery>,
    mut mp: Multipart,
) -> AppResult<Json<Attachment>> {
    let inline = q.inline.as_deref().is_some_and(|v| !matches!(v, "0" | "false"));
    let board_id = board_of_card(&state.db, card_id).await?;
    let access = board_access(&state.db, &u, board_id).await?;
    // pasting an image into the description is part of editing the card
    if inline {
        if !(access.can(perms::ATTACHMENTS_UPLOAD) || access.can(perms::CARDS_EDIT) || access.can(perms::COMMENTS_CREATE)) {
            return Err(AppError::Forbidden);
        }
    } else {
        access.require(perms::ATTACHMENTS_UPLOAD)?;
    }
    let max = state.config.max_upload_mb * 1024 * 1024;

    let mut field = loop {
        match mp.next_field().await.map_err(|_| AppError::BadRequest("invalid_upload"))? {
            Some(f) if f.name() == Some("file") => break f,
            Some(_) => continue,
            None => return Err(AppError::BadRequest("invalid_upload")),
        }
    };
    let filename = clean_filename(field.file_name().unwrap_or("file"));
    let declared = field.content_type().map(|s| s.to_ascii_lowercase());
    let content_type = match declared {
        Some(ct) if !ct.is_empty() && ct != "application/octet-stream" => ct,
        _ => mime_guess::from_path(&filename).first_or_octet_stream().essence_str().to_string(),
    };
    if inline && !INLINE_TYPES.contains(&content_type.as_str()) {
        return Err(AppError::BadRequest("not_an_image"));
    }

    let id = Uuid::now_v7();
    let key = format!("boards/{board_id}/{id}");
    let path = ObjPath::from(key.as_str());

    // Small files: buffer and PUT once. Large files: switch to a streamed multipart upload.
    let mut buf: Vec<u8> = Vec::new();
    let mut writer: Option<WriteMultipart> = None;
    let mut size: usize = 0;
    let read_err = |_| AppError::BadRequest("invalid_upload");
    while let Some(chunk) = field.chunk().await.map_err(read_err)? {
        size += chunk.len();
        if size > max {
            if let Some(w) = writer.take() {
                let _ = w.abort().await;
            }
            return Err(AppError::TooLarge);
        }
        match writer.as_mut() {
            Some(w) => {
                w.wait_for_capacity(4).await?;
                w.write(&chunk);
            }
            None => {
                buf.extend_from_slice(&chunk);
                if buf.len() > MULTIPART_THRESHOLD {
                    let upload = state.store.put_multipart(&path).await?;
                    let mut w = WriteMultipart::new_with_chunk_size(upload, MULTIPART_THRESHOLD);
                    w.write(&buf);
                    buf = Vec::new();
                    writer = Some(w);
                }
            }
        }
    }
    match writer {
        Some(w) => {
            w.finish().await?;
        }
        None => {
            state.store.put(&path, PutPayload::from(Bytes::from(buf))).await?;
        }
    }

    let mut tx = state.db.begin().await?;
    let att: Attachment = sqlx::query_as(
        "INSERT INTO attachments (id, board_id, card_id, uploaded_by, filename, content_type, size, object_key, is_inline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, filename, content_type, size, is_inline, uploaded_by, created_at",
    )
    .bind(id)
    .bind(board_id)
    .bind(card_id)
    .bind(u.id)
    .bind(&filename)
    .bind(&content_type)
    .bind(size as i64)
    .bind(&key)
    .bind(inline)
    .fetch_one(&mut *tx)
    .await?;
    if !inline {
        log_event(&mut tx, card_id, board_id, u.id, "attachment_added", json!({ "filename": filename })).await?;
    }
    tx.commit().await?;
    state.hub.notify(board_id, "attachment", Some(card_id), u.id);
    Ok(Json(att))
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    /// `?download`, `?download=1` or `?download=true` force a download
    download: Option<String>,
}

impl DownloadQuery {
    fn forced(&self) -> bool {
        self.download.as_deref().is_some_and(|v| !matches!(v, "0" | "false"))
    }
}

/// RFC 6266 / 5987 header that survives non-ASCII (e.g. Thai) filenames.
pub(crate) fn content_disposition(kind: &str, filename: &str) -> String {
    let ascii: String = filename.chars().map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { '_' }).collect();
    let mut enc = String::new();
    for b in filename.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            enc.push(b as char);
        } else {
            enc.push_str(&format!("%{b:02X}"));
        }
    }
    format!("{kind}; filename=\"{ascii}\"; filename*=UTF-8''{enc}")
}

pub async fn download(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
    Query(q): Query<DownloadQuery>,
) -> AppResult<Response> {
    let row: (Uuid, String, String, String, i64) = sqlx::query_as(
        "SELECT board_id, filename, content_type, object_key, size FROM attachments WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await?;
    let (board_id, filename, content_type, key, size) = row;
    board_access(&state.db, &u, board_id).await?;
    let obj = state.store.get(&ObjPath::from(key.as_str())).await?;
    let stream = obj.into_stream().map_err(std::io::Error::other);

    let inline = !q.forced() && INLINE_TYPES.contains(&content_type.as_str());
    let ct = if inline { content_type.as_str() } else { "application/octet-stream" };
    let mut resp = Body::from_stream(stream).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(ct).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    if let Ok(v) = HeaderValue::from_str(&content_disposition(if inline { "inline" } else { "attachment" }, &filename)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    Ok(resp)
}

pub async fn delete_attachment(
    State(state): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let (board_id, card_id, uploaded_by, filename, key, is_inline): (Uuid, Option<Uuid>, Option<Uuid>, String, String, bool) =
        sqlx::query_as(
            "SELECT board_id, card_id, uploaded_by, filename, object_key, is_inline FROM attachments WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    let access = board_access(&state.db, &u, board_id).await?;
    if uploaded_by != Some(u.id) {
        access.require(perms::ATTACHMENTS_DELETE)?;
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE attachments SET deleted_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    if let (Some(card_id), false) = (card_id, is_inline) {
        log_event(&mut tx, card_id, board_id, u.id, "attachment_removed", json!({ "filename": filename })).await?;
    }
    tx.commit().await?;
    if let Err(e) = state.store.delete(&ObjPath::from(key.as_str())).await {
        tracing::warn!(error = %e, %key, "object delete failed (row already marked deleted)");
    }
    state.hub.notify(board_id, "attachment", card_id, u.id);
    Ok(Json(json!({ "ok": true })))
}

// ---------- permanent deletion helpers ----------

/// Best-effort removal of stored objects after their rows are gone (a failure only leaves an orphan file).
pub async fn delete_objects(store: &Arc<dyn ObjectStore>, keys: Vec<String>) {
    for key in keys {
        match store.delete(&ObjPath::from(key.as_str())).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => {}
            Err(e) => tracing::warn!(error = %e, %key, "object delete failed"),
        }
    }
}

/// Deletes every object under `boards/<id>/` (catches anything not tracked in the database too).
pub async fn delete_board_objects(store: &Arc<dyn ObjectStore>, board_id: Uuid) -> usize {
    let prefix = ObjPath::from(format!("boards/{board_id}"));
    let keys: Vec<String> = match store.list(Some(&prefix)).map_ok(|m| m.location.to_string()).try_collect().await {
        Ok(k) => k,
        Err(e) => {
            tracing::warn!(error = %e, %board_id, "listing board objects failed");
            return 0;
        }
    };
    let n = keys.len();
    delete_objects(store, keys).await;
    n
}

/// Permanently deletes a card and its comments/log/attachments, inside `tx`.
/// Returns the object keys to delete once the transaction commits. Images that another card or
/// comment on the board still references (e.g. after "Duplicate") are kept and detached instead.
pub async fn purge_card_rows(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    card_id: Uuid,
    board_id: Uuid,
) -> AppResult<Vec<String>> {
    let atts: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, object_key FROM attachments WHERE card_id = $1")
        .bind(card_id)
        .fetch_all(&mut **tx)
        .await?;
    let mut keys = Vec::new();
    for (aid, key) in atts {
        let needle = aid.to_string();
        let (used,): (bool,) = sqlx::query_as(
            "SELECT EXISTS (SELECT 1 FROM cards WHERE board_id = $1 AND id <> $2 AND strpos(description, $3) > 0)
                 OR EXISTS (SELECT 1 FROM comments cm JOIN cards c ON c.id = cm.card_id
                            WHERE c.board_id = $1 AND cm.card_id <> $2 AND strpos(cm.body, $3) > 0)
                 OR EXISTS (SELECT 1 FROM card_templates t WHERE t.board_id = $1 AND strpos(t.description, $3) > 0)",
        )
        .bind(board_id)
        .bind(card_id)
        .bind(&needle)
        .fetch_one(&mut **tx)
        .await?;
        if used {
            sqlx::query("UPDATE attachments SET card_id = NULL WHERE id = $1").bind(aid).execute(&mut **tx).await?;
        } else {
            keys.push(key);
        }
    }
    // comments, events, labels, assignees and attachment rows go with the card (ON DELETE CASCADE)
    sqlx::query("DELETE FROM cards WHERE id = $1").bind(card_id).execute(&mut **tx).await?;
    Ok(keys)
}
