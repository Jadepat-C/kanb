//! Import a board from a file (Boards page → Import): Trello or Wekan JSON, Kanb's own JSON or ZIP export, or any
//! CSV. Always makes a NEW board owned by the person importing (who must be allowed to create boards).
//!
//! 1. POST /import/preview  (file [+ options]): what's in it, which people match accounts here, and for a CSV its
//!    columns and a guess at which is which.
//! 2. POST /import          (file + options): creates the board.
//!
//! Imported content is history, not new activity: no notifications, no board-channel posts (one "imported" event per
//! card, which nothing reacts to). Comments keep their author as a name (`imported_author`), not linked to an account,
//! so nobody here can be made to "say" something. Original dates are kept, so analytics see the real history.

use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read},
};

use axum::{
    Json,
    extract::{Multipart, State},
};
use bytes::Bytes;
use object_store::{ObjectStoreExt, PutPayload, path::Path as ObjPath};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    audit::ClientIp,
    auth::{CurrentUser, User},
    error::{AppError, AppResult},
    import_formats::{self as fmt, CsvMap, Format, Model},
    position,
};

#[derive(Deserialize, Default)]
pub struct Options {
    /// name for the new board (default: the one in the file)
    name: Option<String>,
    /// add the people who match accounts here to the board (as Editors), so they can be assigned
    #[serde(default = "yes")]
    add_members: bool,
    /// CSV: which column is which (default: guessed from the headers)
    csv: Option<CsvMap>,
    /// cards in a column called Done / Completed / Closed… count as finished (many teams finish by moving there)
    #[serde(default = "yes")]
    done_columns: bool,
}

fn yes() -> bool {
    true
}

struct Upload {
    filename: String,
    bytes: Vec<u8>,
    options: Options,
}

async fn read_upload(state: &AppState, mut mp: Multipart) -> AppResult<Upload> {
    let max = state.config.max_upload_mb * 1024 * 1024;
    let (mut file, mut options) = (None, Options { add_members: true, done_columns: true, ..Default::default() });
    while let Some(mut f) = mp.next_field().await.map_err(|_| AppError::BadRequest("invalid_upload"))? {
        match f.name() {
            Some("file") => {
                let filename = f.file_name().unwrap_or("board").to_string();
                let mut bytes = Vec::new();
                while let Some(chunk) = f.chunk().await.map_err(|_| AppError::BadRequest("invalid_upload"))? {
                    bytes.extend_from_slice(&chunk);
                    if bytes.len() > max {
                        return Err(AppError::TooLarge);
                    }
                }
                file = Some((filename, bytes));
            }
            Some("options") => {
                let t = f.text().await.map_err(|_| AppError::BadRequest("invalid_upload"))?;
                options = serde_json::from_str(&t).map_err(|_| AppError::BadRequest("invalid_upload"))?;
            }
            _ => {}
        }
    }
    let (filename, bytes) = file.ok_or(AppError::BadRequest("invalid_upload"))?;
    Ok(Upload { filename, bytes, options })
}

struct Parsed {
    format: Format,
    model: Model,
    /// CSV: headers, the first rows and the column choice used
    csv: Option<(Vec<String>, Vec<Vec<String>>, CsvMap)>,
    zip: Option<zip::ZipArchive<Cursor<Vec<u8>>>>,
}

/// ZIP limits: entries, and the size of board.json itself.
const MAX_ZIP_ENTRIES: usize = 50_000;
const MAX_JSON: u64 = 200 * 1024 * 1024;
/// all the files of one ZIP import together (each one is also limited to MAX_UPLOAD_MB)
const MAX_ZIP_FILES_BYTES: u64 = 20 * 1024 * 1024 * 1024;

fn json_of(bytes: &[u8]) -> AppResult<Value> {
    serde_json::from_slice(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)).map_err(|_| AppError::BadRequest("import_bad_file"))
}

fn parse(up: Upload) -> AppResult<Parsed> {
    let format = fmt::detect(&up.bytes, &up.filename).ok_or(AppError::BadRequest("import_unknown_format"))?;
    let base = up.filename.rsplit_once('.').map(|x| x.0).unwrap_or(&up.filename).to_string();
    Ok(match format {
        Format::Trello => Parsed { format, model: fmt::trello(&json_of(&up.bytes)?), csv: None, zip: None },
        Format::Wekan => Parsed { format, model: fmt::wekan(&json_of(&up.bytes)?), csv: None, zip: None },
        Format::Kanb => Parsed { format, model: fmt::kanb(&json_of(&up.bytes)?), csv: None, zip: None },
        Format::Zip => {
            let mut z = zip::ZipArchive::new(Cursor::new(up.bytes)).map_err(|_| AppError::BadRequest("import_bad_file"))?;
            if z.len() > MAX_ZIP_ENTRIES {
                return Err(AppError::BadRequest("import_bad_file"));
            }
            let mut raw = Vec::new();
            {
                let f = z.by_name("board.json").map_err(|_| AppError::BadRequest("import_unknown_format"))?;
                f.take(MAX_JSON).read_to_end(&mut raw).map_err(|_| AppError::BadRequest("import_bad_file"))?;
            }
            let v = json_of(&raw)?;
            if v.get("format").and_then(|x| x.as_str()) != Some("kanban-board-export") {
                return Err(AppError::BadRequest("import_unknown_format"));
            }
            Parsed { format, model: fmt::kanb(&v), csv: None, zip: Some(z) }
        }
        Format::Csv => {
            let rows = fmt::parse_csv(&up.bytes).map_err(AppError::BadRequest)?;
            let map = up.options.csv.clone().unwrap_or_else(|| fmt::guess(&rows[0]));
            let model = fmt::csv(&rows, &map, &base);
            let sample = rows.iter().skip(1).take(5).cloned().collect();
            Parsed { format, model, csv: Some((rows[0].clone(), sample, map)), zip: None }
        }
    })
}

fn may_create(u: &User) -> AppResult<()> {
    if u.is_super_admin || u.can_create_boards { Ok(()) } else { Err(AppError::Forbidden) }
}

#[derive(Serialize, Clone, sqlx::FromRow)]
struct Account {
    id: Uuid,
    display_name: String,
    username: String,
}

/// Accounts here for the people in the file: same username, or same email; a display name only when exactly one
/// active account has it. Inactive, deleted and still-waiting accounts never match. Matching by email is for super
/// admins only: otherwise anyone could upload a list of addresses to learn who has an account here.
async fn match_people(db: &sqlx::PgPool, people: &[fmt::Person], by_email: bool) -> AppResult<Vec<Option<Account>>> {
    const BY_USERNAME: &str = "SELECT id, display_name, username FROM users
        WHERE is_active AND deleted_at IS NULL AND signup IS NULL AND lower(username) = lower($1)";
    const BY_EMAIL: &str = "SELECT id, display_name, username FROM users
        WHERE is_active AND deleted_at IS NULL AND signup IS NULL AND lower(email) = lower($1)";
    const BY_NAME: &str = "SELECT id, display_name, username FROM users
        WHERE is_active AND deleted_at IS NULL AND signup IS NULL AND lower(display_name) = lower($1) LIMIT 2";
    let mut out = Vec::new();
    for p in people {
        let mut hit = None;
        for (sql, v) in [(BY_USERNAME, p.username.clone()), (BY_EMAIL, p.email.clone().filter(|_| by_email)), (BY_NAME, Some(p.name.trim().to_string()))] {
            let Some(v) = v.filter(|v| !v.is_empty()) else { continue };
            let rows: Vec<Account> = sqlx::query_as(sql).bind(v).fetch_all(db).await?;
            // a display name counts only when it's unique
            if rows.len() == 1 {
                hit = rows.into_iter().next();
                break;
            }
        }
        out.push(hit);
    }
    Ok(out)
}

// ---------- preview ----------

pub async fn preview(State(state): State<AppState>, CurrentUser(u): CurrentUser, mp: Multipart) -> AppResult<Json<Value>> {
    may_create(&u)?;
    let up = read_upload(&state, mp).await?;
    let p = {
        let _slot = crate::heavy(&state).await;
        tokio::task::spawn_blocking(move || parse(up)).await.map_err(|e| AppError::Internal(e.into()))??
    };
    let m = &p.model;
    let matched = match_people(&state.db, &m.people, u.is_super_admin).await?;
    let files: usize = m.cards.iter().map(|c| c.files.len()).sum();
    Ok(Json(json!({
        "format": p.format,
        "source": m.source,
        "name": m.name,
        "lists": m.lists.len(),
        "cards": m.cards.len(),
        "archived_cards": m.cards.iter().filter(|c| c.archived).count(),
        "labels": m.labels.len(),
        "comments": m.cards.iter().map(|c| c.comments.len()).sum::<usize>(),
        "files": files,
        "people": m.people.iter().zip(&matched).map(|(p, a)| json!({ "name": p.name, "username": p.username, "email": p.email, "account": a })).collect::<Vec<_>>(),
        "warnings": m.warnings,
        "csv": p.csv.as_ref().map(|(h, rows, map)| json!({ "headers": h, "rows": rows, "map": map })),
        "sample": m.cards.iter().take(5).map(|c| json!({
            "title": c.title, "column": m.lists.get(c.list).map(|l| l.name.clone()), "due_at": c.due_at, "start_at": c.start_at,
            "labels": c.labels.iter().filter_map(|i| m.labels.get(*i).map(|l| l.name.clone())).collect::<Vec<_>>(),
            "assignees": c.assignees.iter().filter_map(|i| m.people.get(*i).map(|p| p.name.clone())).collect::<Vec<_>>(),
            "done": c.done,
        })).collect::<Vec<_>>(),
    })))
}

// ---------- import ----------

pub async fn import(State(state): State<AppState>, CurrentUser(u): CurrentUser, ClientIp(ip): ClientIp, mp: Multipart) -> AppResult<Json<Value>> {
    may_create(&u)?;
    let up = read_upload(&state, mp).await?;
    let (name, add_members, done_columns) = (up.options.name.clone(), up.options.add_members, up.options.done_columns);
    let _slot = crate::heavy(&state).await;
    let mut p = tokio::task::spawn_blocking(move || parse(up)).await.map_err(|e| AppError::Internal(e.into()))??;
    if p.model.cards.is_empty() && p.model.lists.is_empty() {
        return Err(AppError::BadRequest("import_empty"));
    }
    // the ZIP's files must fit under MAX_STORAGE_GB
    if let (Some(z), Some(limit)) = (p.zip.as_mut(), crate::files::storage_limit(&state)) {
        let mut total = 0u64;
        for c in &p.model.cards {
            for f in &c.files {
                total += z.by_name(&f.path).map(|e| e.size()).unwrap_or(0);
            }
        }
        if crate::files::storage_used(&state.db).await? + total > limit {
            return Err(AppError::StorageFull);
        }
    }
    let matched = match_people(&state.db, &p.model.people, u.is_super_admin).await?;
    let (board_id, card_ids) = create(&state, &u, &p.model, name, add_members, done_columns, &matched).await?;
    let mut warnings = p.model.warnings.clone();
    if let Some(z) = p.zip.as_mut() {
        let failed = copy_files(&state, &u, board_id, &p.model, &card_ids, z).await;
        if failed > 0 {
            warnings.push(format!("files_failed:{failed}"));
        }
    }
    crate::audit::log(&state, Some(u.id), "board_imported", Some(board_id), ip.as_deref(), json!({ "from": p.model.source, "cards": card_ids.len() })).await;
    Ok(Json(json!({ "board_id": board_id, "cards": card_ids.len(), "warnings": warnings })))
}

/// Creates the board and everything in it in one transaction. Returns the board and the new id of each card.
#[allow(clippy::too_many_arguments)]
async fn create(
    state: &AppState,
    u: &User,
    m: &Model,
    name: Option<String>,
    add_members: bool,
    done_columns: bool,
    matched: &[Option<Account>],
) -> AppResult<(Uuid, Vec<Uuid>)> {
    let board_name = name.map(|n| n.trim().chars().take(200).collect::<String>()).filter(|n| !n.is_empty()).unwrap_or_else(|| {
        if m.name.trim().is_empty() { "Imported board".into() } else { m.name.clone() }
    });
    let mut tx = state.db.begin().await?;
    let names: Vec<String> = m.lists.iter().map(|l| if l.name.trim().is_empty() { "(untitled)".into() } else { l.name.clone() }).collect();
    let (board, list_ids, default_status_ids) =
        crate::boards::insert_board(&mut tx, Some(u.id), u.id, &u.locale, &board_name, &m.description, m.color.as_deref(), &names).await?;
    let bid = board.id;
    for (l, id) in m.lists.iter().zip(&list_ids) {
        sqlx::query("UPDATE lists SET color = $2, wip_limit = $3, archived_at = CASE WHEN $4 THEN now() END WHERE id = $1")
            .bind(id)
            .bind(&l.color)
            .bind(l.wip_limit)
            .bind(l.archived)
            .execute(&mut *tx)
            .await?;
    }
    // statuses: the file's replace the defaults; names the cards use that don't exist yet are added
    let mut statuses: Vec<(String, Uuid, bool)> = Vec::new();
    if m.statuses.is_empty() {
        statuses = sqlx::query_as("SELECT name, id, is_done FROM board_statuses WHERE board_id = $1 ORDER BY position").bind(bid).fetch_all(&mut *tx).await?;
    } else {
        sqlx::query("DELETE FROM board_statuses WHERE id = ANY($1)").bind(&default_status_ids).execute(&mut *tx).await?;
        for s in &m.statuses {
            statuses.push((s.name.clone(), Uuid::now_v7(), s.done));
        }
    }
    for c in &m.cards {
        if let Some(n) = &c.status
            && !statuses.iter().any(|s| s.0.eq_ignore_ascii_case(n))
            && statuses.len() < 50
        {
            let done = fmt::is_done_word(n);
            statuses.push((n.clone(), Uuid::now_v7(), done));
        }
    }
    let existing: HashSet<Uuid> = default_status_ids.iter().copied().filter(|_| m.statuses.is_empty()).collect();
    for (i, (n, id, done)) in statuses.iter().enumerate() {
        if existing.contains(id) {
            continue;
        }
        let color = m.statuses.iter().find(|s| &s.name == n).map(|s| s.color.clone()).unwrap_or_else(|| if *done { "#2f5bd3".into() } else { "#a1a1aa".into() });
        sqlx::query("INSERT INTO board_statuses (id, board_id, name, color, position, is_done) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(id)
            .bind(bid)
            .bind(n)
            .bind(color)
            .bind(i as i32)
            .bind(done)
            .execute(&mut *tx)
            .await?;
    }
    let first_status = statuses.iter().find(|s| !s.2).or(statuses.first()).map(|s| s.1);
    let done_status = statuses.iter().find(|s| s.2).map(|s| s.1);
    let status_named = |n: &str| statuses.iter().find(|s| s.0.eq_ignore_ascii_case(n)).map(|s| (s.1, s.2));
    let mut label_ids = Vec::new();
    for l in &m.labels {
        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO labels (id, board_id, name, color) VALUES ($1,$2,$3,$4)").bind(id).bind(bid).bind(&l.name).bind(&l.color).execute(&mut *tx).await?;
        label_ids.push(id);
    }
    for t in m.card_templates.iter().take(200) {
        let g = |k: &str| t.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        sqlx::query(
            "INSERT INTO card_templates (id, board_id, name, title, description, priority, label_ids, due_in_days, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8)",
        )
        .bind(Uuid::now_v7())
        .bind(bid)
        .bind(fmt::title(&g("name")))
        .bind(g("title").chars().take(500).collect::<String>())
        .bind(fmt::body(&g("description")))
        .bind(t.get("priority").and_then(|v| v.as_i64()).unwrap_or(0).clamp(0, 3) as i16)
        .bind(t.get("due_in_days").and_then(|v| v.as_i64()).map(|d| d.clamp(0, 3650) as i32))
        .bind(u.id)
        .execute(&mut *tx)
        .await?;
    }
    // people who match accounts here join the board as Editors (when asked), so they can be assigned
    let members: HashSet<Uuid> = if add_members {
        let (editor,): (Uuid,) = sqlx::query_as("SELECT id FROM board_roles WHERE board_id = $1 AND name = 'Editor'").bind(bid).fetch_one(&mut *tx).await?;
        let ids: HashSet<Uuid> = matched.iter().flatten().map(|a| a.id).filter(|id| *id != u.id).collect();
        for id in &ids {
            sqlx::query("INSERT INTO board_members (board_id, user_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING")
                .bind(bid)
                .bind(id)
                .bind(editor)
                .execute(&mut *tx)
                .await?;
        }
        ids.into_iter().chain([u.id]).collect()
    } else {
        [u.id].into()
    };
    // keep the source's card numbers when they're all there and unique (so "#12" in a text still points right)
    let keep_numbers = {
        let nums: Vec<i32> = m.cards.iter().filter_map(|c| c.number.filter(|n| *n > 0)).collect();
        nums.len() == m.cards.len() && nums.iter().collect::<HashSet<_>>().len() == nums.len()
    };
    let mut last_pos: Vec<Option<String>> = vec![None; list_ids.len()];
    let mut card_ids = Vec::with_capacity(m.cards.len());
    let mut by_number: HashMap<i32, Uuid> = HashMap::new();
    let mut max_number = 0;
    for (i, c) in m.cards.iter().enumerate() {
        let number = if keep_numbers { c.number.unwrap_or(i as i32 + 1) } else { i as i32 + 1 };
        max_number = max_number.max(number);
        let list_id = list_ids[c.list.min(list_ids.len() - 1)];
        let pos = position::between(last_pos[c.list].as_deref(), None);
        last_pos[c.list] = Some(pos.clone());
        // (a Kanb export says exactly which cards are finished; other apps often only by the column)
        let in_done_column = done_columns && m.source != "Kanb" && m.lists.get(c.list).is_some_and(|l| fmt::is_done_word(&l.name));
        let (status_id, done) = match (c.done || in_done_column, c.status.as_deref().and_then(status_named)) {
            (true, _) if done_status.is_some() => (done_status, true),
            (_, Some((id, d))) => (Some(id), d),
            _ => (first_status, false),
        };
        // when it was finished is unknown unless the file says so: better no date than "today" (it would skew analytics)
        let done_at = if done { c.done_at } else { None };
        // assignees who aren't accounts (or members) here stay readable in the text
        let who: Vec<(usize, Option<Uuid>)> = c.assignees.iter().map(|&p| (p, matched.get(p).cloned().flatten().map(|a| a.id).filter(|id| members.contains(id)))).collect();
        let others: Vec<String> = who.iter().filter(|w| w.1.is_none()).filter_map(|w| m.people.get(w.0).map(|p| p.name.clone())).collect();
        let mut description = c.description.clone();
        if !others.is_empty() {
            description += &format!("\n\n_Assigned in {}: {}_", m.source, others.join(", "));
        }
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO cards (id, board_id, list_id, number, title, description, position, priority, status_id, color, start_at, due_at,
                                done_at, created_by, created_at, updated_at, archived_at, imported_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE($15, now()),
                     LEAST(now(), GREATEST(COALESCE($17, $13, $15, now()), COALESCE($15, now()))), CASE WHEN $16 THEN now() END, now())",
        )
        .bind(id)
        .bind(bid)
        .bind(list_id)
        .bind(number)
        .bind(&c.title)
        .bind(&description)
        .bind(&pos)
        .bind(c.priority)
        .bind(status_id)
        .bind(&c.color)
        .bind(c.start_at.filter(|s| c.due_at.is_none_or(|d| *s <= d)))
        .bind(c.due_at)
        .bind(done_at)
        .bind(u.id)
        .bind(c.created_at)
        .bind(c.archived)
        .bind(c.updated_at)
        .execute(&mut *tx)
        .await?;
        let labels: Vec<Uuid> = c.labels.iter().filter_map(|i| label_ids.get(*i).copied()).collect::<HashSet<_>>().into_iter().collect();
        if !labels.is_empty() {
            sqlx::query("INSERT INTO card_labels (card_id, label_id) SELECT $1, unnest($2::uuid[])").bind(id).bind(&labels).execute(&mut *tx).await?;
        }
        let assignees: Vec<Uuid> = who.iter().filter_map(|w| w.1).collect::<HashSet<_>>().into_iter().collect();
        if !assignees.is_empty() {
            sqlx::query("INSERT INTO card_assignees (card_id, user_id) SELECT $1, unnest($2::uuid[])").bind(id).bind(&assignees).execute(&mut *tx).await?;
        }
        for cm in &c.comments {
            sqlx::query("INSERT INTO comments (id, card_id, author_id, imported_author, body, created_at, updated_at) VALUES ($1,$2,NULL,$3,$4,COALESCE($5, now()),COALESCE($5, now()))")
                .bind(Uuid::now_v7())
                .bind(id)
                .bind(cm.author.chars().take(200).collect::<String>())
                .bind(&cm.body)
                .bind(cm.created_at)
                .execute(&mut *tx)
                .await?;
        }
        // history: one event that no notification or channel reacts to
        sqlx::query("INSERT INTO card_events (card_id, board_id, actor_id, kind, data, created_at) VALUES ($1,$2,$3,'imported',$4, now())")
            .bind(id)
            .bind(bid)
            .bind(u.id)
            .bind(json!({ "from": m.source }))
            .execute(&mut *tx)
            .await?;
        if let Some(n) = c.number {
            by_number.insert(n, id);
        }
        card_ids.push(id);
    }
    for (c, id) in m.cards.iter().zip(&card_ids) {
        for n in &c.waits_for {
            if let Some(dep) = by_number.get(n).filter(|d| *d != id) {
                sqlx::query("INSERT INTO card_dependencies (card_id, depends_on) VALUES ($1,$2) ON CONFLICT DO NOTHING").bind(id).bind(dep).execute(&mut *tx).await?;
            }
        }
    }
    sqlx::query("UPDATE boards SET card_seq = $2 WHERE id = $1").bind(bid).bind(max_number).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok((bid, card_ids))
}

/// Kanb ZIP: copies each card's files into storage and points `/api/files/<old id>` links at the copies. Returns how
/// many couldn't be copied (the board is already made; a missing file is reported, not fatal).
async fn copy_files(state: &AppState, u: &User, board_id: Uuid, m: &Model, card_ids: &[Uuid], z: &mut zip::ZipArchive<Cursor<Vec<u8>>>) -> usize {
    let max = (state.config.max_upload_mb * 1024 * 1024) as u64;
    // the sizes a ZIP declares can't be trusted: count what is actually written, within the space left
    let mut budget = match crate::files::storage_limit(state) {
        Some(limit) => limit.saturating_sub(crate::files::storage_used(&state.db).await.unwrap_or(limit)),
        None => u64::MAX,
    }
    .min(MAX_ZIP_FILES_BYTES);
    let mut failed = 0;
    let mut renamed: Vec<(String, Uuid)> = Vec::new();
    for (c, card_id) in m.cards.iter().zip(card_ids) {
        for f in &c.files {
            let data = match z.by_name(&f.path) {
                Ok(e) if e.size() <= max => {
                    let mut buf = Vec::new();
                    match e.take(max + 1).read_to_end(&mut buf) {
                        Ok(_) if buf.len() as u64 <= max => Some(buf),
                        _ => None,
                    }
                }
                _ => None,
            };
            let Some(data) = data.filter(|d| d.len() as u64 <= budget) else {
                failed += 1;
                continue;
            };
            budget -= data.len() as u64;
            let id = Uuid::now_v7();
            let key = format!("boards/{board_id}/{id}");
            let size = data.len() as i64;
            let ct = if f.content_type.is_empty() {
                mime_guess::from_path(&f.filename).first_or_octet_stream().essence_str().to_string()
            } else {
                f.content_type.clone()
            };
            if state.store.put(&ObjPath::from(key.as_str()), PutPayload::from(Bytes::from(data))).await.is_err() {
                failed += 1;
                continue;
            }
            let res = sqlx::query(
                "INSERT INTO attachments (id, board_id, card_id, uploaded_by, filename, content_type, size, object_key, is_inline)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            )
            .bind(id)
            .bind(board_id)
            .bind(card_id)
            .bind(u.id)
            .bind(crate::files::clean_filename(&f.filename))
            .bind(&ct)
            .bind(size)
            .bind(&key)
            .bind(f.inline)
            .execute(&state.db)
            .await;
            if res.is_err() {
                let _ = state.store.delete(&ObjPath::from(key.as_str())).await;
                failed += 1;
                continue;
            }
            if let Some(old) = &f.old_id {
                renamed.push((old.clone(), id));
            }
        }
    }
    for (old, new) in renamed {
        let (from, to) = (format!("/api/files/{old}"), format!("/api/files/{new}"));
        let _ = sqlx::query("UPDATE cards SET description = replace(description, $2, $3) WHERE board_id = $1 AND strpos(description, $2) > 0")
            .bind(board_id)
            .bind(&from)
            .bind(&to)
            .execute(&state.db)
            .await;
        let _ = sqlx::query(
            "UPDATE comments SET body = replace(body, $2, $3) WHERE card_id IN (SELECT id FROM cards WHERE board_id = $1) AND strpos(body, $2) > 0",
        )
        .bind(board_id)
        .bind(&from)
        .bind(&to)
        .execute(&state.db)
        .await;
    }
    failed
}
