//! Profile pictures. Uploads are decoded, center-cropped to a square, resized to 256 px and re-encoded as
//! JPEG: small files, no EXIF/GPS metadata leaks, and nothing but a real image is ever stored or served.

use std::io::Cursor;

use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use futures::TryStreamExt;
use image::{ImageFormat, ImageReader, Limits, imageops::FilterType};
use object_store::{ObjectStoreExt, PutPayload, path::Path as ObjPath};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{CurrentUser, USER_COLUMNS, User},
    error::{AppError, AppResult},
};

const MAX_UPLOAD: usize = 10 * 1024 * 1024;
const SIZE: u32 = 256;

fn key(id: Uuid) -> ObjPath {
    ObjPath::from(format!("avatars/{id}"))
}

/// Decode + square-crop + resize + re-encode (CPU work: run on a blocking thread).
fn process(bytes: Vec<u8>) -> Result<Vec<u8>, &'static str> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|_| "not_an_image")?;
    if !matches!(reader.format(), Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif)) {
        return Err("not_an_image");
    }
    // refuse decompression bombs
    let mut limits = Limits::default();
    limits.max_image_width = Some(8000);
    limits.max_image_height = Some(8000);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|_| "not_an_image")?;
    let side = img.width().min(img.height());
    let square = img.crop_imm((img.width() - side) / 2, (img.height() - side) / 2, side, side);
    let small = square.resize_exact(SIZE, SIZE, FilterType::Lanczos3).to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86).encode_image(&small).map_err(|_| "not_an_image")?;
    Ok(out)
}

pub async fn upload(State(state): State<AppState>, CurrentUser(u): CurrentUser, mut mp: Multipart) -> AppResult<Json<User>> {
    let mut field = loop {
        match mp.next_field().await.map_err(|_| AppError::BadRequest("invalid_upload"))? {
            Some(f) if f.name() == Some("file") => break f,
            Some(_) => continue,
            None => return Err(AppError::BadRequest("invalid_upload")),
        }
    };
    let mut buf = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(|_| AppError::BadRequest("invalid_upload"))? {
        if buf.len() + chunk.len() > MAX_UPLOAD {
            return Err(AppError::TooLarge);
        }
        buf.extend_from_slice(&chunk);
    }
    let jpeg = tokio::task::spawn_blocking(move || process(buf)).await.map_err(|e| anyhow::anyhow!(e))?.map_err(AppError::BadRequest)?;

    let id = Uuid::now_v7();
    state.store.put(&key(id), PutPayload::from(Bytes::from(jpeg))).await?;
    let (old,): (Option<Uuid>,) = sqlx::query_as("SELECT avatar_id FROM users WHERE id = $1").bind(u.id).fetch_one(&state.db).await?;
    let user: User = sqlx::query_as(sqlf!("UPDATE users SET avatar_id = $2, updated_at = now() WHERE id = $1 RETURNING {USER_COLUMNS}"))
        .bind(u.id)
        .bind(id)
        .fetch_one(&state.db)
        .await?;
    if let Some(old) = old {
        let _ = state.store.delete(&key(old)).await;
    }
    Ok(Json(user))
}

pub async fn remove(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<User>> {
    let (old,): (Option<Uuid>,) = sqlx::query_as("SELECT avatar_id FROM users WHERE id = $1").bind(u.id).fetch_one(&state.db).await?;
    let user: User = sqlx::query_as(sqlf!("UPDATE users SET avatar_id = NULL, updated_at = now() WHERE id = $1 RETURNING {USER_COLUMNS}"))
        .bind(u.id)
        .fetch_one(&state.db)
        .await?;
    if let Some(old) = old {
        let _ = state.store.delete(&key(old)).await;
    }
    Ok(Json(user))
}

/// Any signed-in user can see profile pictures. Only current avatars are served; ids never change content,
/// so they're cached for a long time.
pub async fn serve(State(state): State<AppState>, _u: CurrentUser, Path(id): Path<Uuid>) -> AppResult<Response> {
    let exists: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE avatar_id = $1").bind(id).fetch_optional(&state.db).await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }
    let obj = state.store.get(&key(id)).await?;
    let stream = obj.into_stream().map_err(std::io::Error::other);
    let mut resp = Body::from_stream(stream).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    Ok(resp)
}

/// Used when an account is deleted: the picture goes with it.
pub async fn purge_for_user(state: &AppState, user_id: Uuid) {
    if let Ok(Some((Some(id),))) =
        sqlx::query_as::<_, (Option<Uuid>,)>("SELECT avatar_id FROM users WHERE id = $1").bind(user_id).fetch_optional(&state.db).await
    {
        let _ = state.store.delete(&key(id)).await;
    }
}
