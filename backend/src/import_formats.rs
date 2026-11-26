//! Readers for board exports from other apps (and Kanb itself), each turned into the one [`Model`] that
//! `import.rs` creates a board from. Parsing never touches the database.
//!
//! - Trello: the board's JSON export (Menu → Print, export and share → Export as JSON)
//! - Wekan: its board JSON export (`_format: wekan-board-1.0.0`)
//! - Kanb: Board settings → Export as JSON, or the ZIP (board.json + the files)
//! - CSV: any spreadsheet, with the columns matched to card fields by the person importing

use std::collections::HashMap;

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------- the common model ----------

#[derive(Default)]
pub struct Model {
    pub source: &'static str,
    pub name: String,
    pub description: String,
    pub color: Option<String>,
    pub lists: Vec<MList>,
    /// empty = the board gets the usual default statuses
    pub statuses: Vec<MStatus>,
    pub labels: Vec<MLabel>,
    pub people: Vec<Person>,
    pub cards: Vec<MCard>,
    /// Kanb exports: card templates, as exported
    pub card_templates: Vec<Value>,
    pub warnings: Vec<String>,
}

pub struct MList {
    pub name: String,
    pub archived: bool,
    pub color: Option<String>,
    pub wip_limit: Option<i32>,
}

pub struct MStatus {
    pub name: String,
    pub color: String,
    pub done: bool,
}

pub struct MLabel {
    pub name: String,
    pub color: String,
}

/// Someone named in the export, matched to an account here by `import.rs`.
#[derive(Clone, Default, Serialize)]
pub struct Person {
    pub name: String,
    pub username: Option<String>,
    pub email: Option<String>,
}

#[derive(Default)]
pub struct MCard {
    /// the number it had in the source (#12), kept when the numbers are unique
    pub number: Option<i32>,
    pub list: usize,
    pub title: String,
    pub description: String,
    pub priority: i16,
    pub color: Option<String>,
    /// a status name (matched to `statuses` or the defaults); `done` picks the board's done status
    pub status: Option<String>,
    pub done: bool,
    pub done_at: Option<DateTime<Utc>>,
    pub start_at: Option<DateTime<Utc>>,
    pub due_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    /// last activity in the source (for "stale" in analytics); None = its finish or creation date
    pub updated_at: Option<DateTime<Utc>>,
    pub archived: bool,
    pub labels: Vec<usize>,
    pub assignees: Vec<usize>,
    pub comments: Vec<MComment>,
    /// files inside a Kanb ZIP: (path in the ZIP, file name, content type, inline picture, old id)
    pub files: Vec<MFile>,
    /// source numbers of the cards this one waits for
    pub waits_for: Vec<i32>,
}

pub struct MComment {
    pub author: String,
    pub body: String,
    pub created_at: Option<DateTime<Utc>>,
}

pub struct MFile {
    pub path: String,
    pub filename: String,
    pub content_type: String,
    pub inline: bool,
    /// its id in the source Kanb, so /api/files/<id> in descriptions can be pointed at the new copy
    pub old_id: Option<String>,
}

// ---------- shared helpers ----------

pub const MAX_LISTS: usize = 500;
pub const MAX_CARDS: usize = 20_000;
pub const MAX_LABELS: usize = 500;

fn text(s: &str, max: usize) -> String {
    s.chars().filter(|c| *c != '\0').take(max).collect()
}
pub fn title(s: &str) -> String {
    let t = text(s.trim(), 500);
    if t.trim().is_empty() { "(untitled)".into() } else { t }
}
pub fn body(s: &str) -> String {
    text(s, 100_000)
}
fn name(s: &str) -> String {
    text(s.trim(), 200)
}

/// `#rrggbb`, or None: colours end up in style attributes, so nothing else may pass.
pub fn hex(c: &str) -> Option<String> {
    let c = c.trim().to_ascii_lowercase();
    let h = c.strip_prefix('#')?;
    match h.len() {
        6 if h.chars().all(|x| x.is_ascii_hexdigit()) => Some(format!("#{h}")),
        3 if h.chars().all(|x| x.is_ascii_hexdigit()) => Some(h.chars().flat_map(|x| [x, x]).fold("#".to_string(), |mut s, x| {
            s.push(x);
            s
        })),
        _ => None,
    }
}

/// Named colours used by Trello and Wekan (with Trello's _dark / _light variants), as hex.
pub fn named(c: &str) -> Option<String> {
    let base = c.trim().to_ascii_lowercase();
    let base = base.trim_end_matches("_dark").trim_end_matches("_light");
    Some(
        match base {
            "green" => "#22c55e",
            "yellow" => "#eab308",
            "orange" => "#f97316",
            "red" => "#ef4444",
            "purple" => "#a855f7",
            "blue" => "#3b82f6",
            "sky" | "lightblue" | "navy" => "#0ea5e9",
            "lime" | "lightgreen" => "#84cc16",
            "pink" | "plum" | "magenta" => "#ec4899",
            "black" | "midnight" => "#3f3f46",
            "white" | "silver" | "gray" | "grey" => "#a1a1aa",
            "crimson" => "#dc2626",
            "darkgreen" | "forest" => "#15803d",
            "peachpuff" | "gold" => "#f59e0b",
            "indigo" | "slateblue" => "#6366f1",
            "saddlebrown" | "brown" => "#92400e",
            "paleturquoise" | "aqua" | "teal" => "#14b8a6",
            "mistyrose" | "coral" => "#fb7185",
            _ => return hex(c),
        }
        .to_string(),
    )
}

fn date(v: Option<&Value>) -> Option<DateTime<Utc>> {
    v.and_then(|v| v.as_str()).and_then(|s| s.parse::<DateTime<Utc>>().ok())
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}
fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}
fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}
fn num(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0.0)
}

/// Checklists become Markdown task lines in the description (that's how Kanb's checklist works).
fn checklist_md(title: &str, items: &[(String, bool)]) -> String {
    let mut out = String::new();
    if !title.trim().is_empty() {
        out += &format!("\n\n**{}**\n", title.trim());
    } else {
        out += "\n\n";
    }
    for (t, done) in items {
        out += &format!("- [{}] {}\n", if *done { "x" } else { " " }, t.replace('\n', " "));
    }
    out
}

/// Index of a person (added if new), by username or name.
fn person(people: &mut Vec<Person>, p: Person) -> usize {
    if let Some(i) = people.iter().position(|x| {
        (p.username.is_some() && x.username.as_deref().map(str::to_lowercase) == p.username.as_deref().map(str::to_lowercase)) || (p.username.is_none() && x.name == p.name)
    }) {
        return i;
    }
    people.push(p);
    people.len() - 1
}

// ---------- detection ----------

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Trello,
    Wekan,
    Kanb,
    Zip,
    Csv,
}

pub fn detect(bytes: &[u8], filename: &str) -> Option<Format> {
    if bytes.starts_with(b"PK\x03\x04") {
        return Some(Format::Zip);
    }
    let lower = filename.to_ascii_lowercase();
    let start = bytes.iter().position(|c| !c.is_ascii_whitespace() && *c != 0xEF && *c != 0xBB && *c != 0xBF);
    if start.map(|i| bytes[i]) == Some(b'{') {
        let v: Value = serde_json::from_slice(bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)).ok()?;
        if s(&v, "format") == "kanban-board-export" {
            return Some(Format::Kanb);
        }
        if s(&v, "_format").starts_with("wekan-board") {
            return Some(Format::Wekan);
        }
        if v.get("lists").is_some() && v.get("cards").is_some() && (v.get("idOrganization").is_some() || v.get("shortLink").is_some() || v.get("prefs").is_some()) {
            return Some(Format::Trello);
        }
        return None;
    }
    if lower.ends_with(".csv") || lower.ends_with(".tsv") || lower.ends_with(".txt") {
        return Some(Format::Csv);
    }
    None
}

// ---------- Trello ----------

pub fn trello(v: &Value) -> Model {
    let mut m = Model { source: "Trello", name: name(s(v, "name")), description: body(s(v, "desc")), ..Default::default() };
    // lists in board order
    let mut lists: Vec<&Value> = arr(v, "lists").iter().collect();
    lists.sort_by(|a, b| num(a, "pos").total_cmp(&num(b, "pos")));
    let list_index: HashMap<&str, usize> = lists.iter().enumerate().map(|(i, l)| (s(l, "id"), i)).collect();
    m.lists = lists.iter().take(MAX_LISTS).map(|l| MList { name: name(s(l, "name")), archived: b(l, "closed"), color: None, wip_limit: None }).collect();
    let label_index: HashMap<&str, usize> = arr(v, "labels")
        .iter()
        .take(MAX_LABELS)
        .enumerate()
        .map(|(i, l)| {
            let n = s(l, "name");
            let color = l.get("color").and_then(|c| c.as_str()).and_then(named);
            m.labels.push(MLabel {
                // an unnamed Trello label is just its colour
                name: if n.trim().is_empty() {
                    l.get("color").and_then(|c| c.as_str()).unwrap_or("label").trim_end_matches("_dark").trim_end_matches("_light").to_string()
                } else {
                    name(n)
                },
                color: color.unwrap_or_else(|| "#a1a1aa".into()),
            });
            (s(l, "id"), i)
        })
        .collect();
    let mut people = Vec::new();
    let member_index: HashMap<&str, usize> = arr(v, "members")
        .iter()
        .map(|p| {
            let i = person(&mut people, Person { name: name(s(p, "fullName")), username: Some(s(p, "username").to_string()).filter(|x| !x.is_empty()), email: None });
            (s(p, "id"), i)
        })
        .collect();
    // checklists by card
    let mut checklists: HashMap<&str, Vec<&Value>> = HashMap::new();
    for c in arr(v, "checklists") {
        checklists.entry(s(c, "idCard")).or_default().push(c);
    }
    // comments live in the action log; Trello's export only includes the latest actions (up to 1000)
    let mut comments: HashMap<&str, Vec<MComment>> = HashMap::new();
    let actions = arr(v, "actions");
    for a in actions.iter().filter(|a| s(a, "type") == "commentCard") {
        let card = a.pointer("/data/card/id").and_then(|x| x.as_str()).unwrap_or("");
        let who = a.get("memberCreator").map(|p| s(p, "fullName").to_string()).filter(|x| !x.is_empty()).unwrap_or_else(|| "Trello".into());
        comments.entry(card).or_default().push(MComment {
            author: who,
            body: body(a.pointer("/data/text").and_then(|x| x.as_str()).unwrap_or("")),
            created_at: date(a.get("date")),
        });
    }
    if actions.len() >= 1000 {
        m.warnings.push("trello_actions_limit".into());
    }
    let mut cards: Vec<&Value> = arr(v, "cards").iter().collect();
    cards.sort_by(|a, b| num(a, "pos").total_cmp(&num(b, "pos")));
    for c in cards.into_iter().take(MAX_CARDS) {
        let Some(&list) = list_index.get(s(c, "idList")) else { continue };
        if list >= m.lists.len() {
            continue;
        }
        let mut desc = body(s(c, "desc"));
        let mut cls: Vec<&&Value> = checklists.get(s(c, "id")).map(|v| v.iter().collect()).unwrap_or_default();
        cls.sort_by(|a, b| num(a, "pos").total_cmp(&num(b, "pos")));
        for cl in cls {
            let mut items: Vec<&Value> = arr(cl, "checkItems").iter().collect();
            items.sort_by(|a, b| num(a, "pos").total_cmp(&num(b, "pos")));
            desc += &checklist_md(s(cl, "name"), &items.iter().map(|i| (s(i, "name").to_string(), s(i, "state") == "complete")).collect::<Vec<_>>());
        }
        let links: Vec<String> = arr(c, "attachments")
            .iter()
            .filter(|a| !s(a, "url").is_empty())
            .map(|a| format!("- [{}]({})", s(a, "name").replace(['[', ']'], ""), s(a, "url").replace(' ', "%20")))
            .collect();
        if !links.is_empty() {
            desc += &format!("\n\n**Attachments (in Trello)**\n{}\n", links.join("\n"));
        }
        let mut cm = comments.remove(s(c, "id")).unwrap_or_default();
        cm.sort_by_key(|x| x.created_at);
        let done = b(c, "dueComplete");
        m.cards.push(MCard {
            number: c.get("idShort").and_then(|x| x.as_i64()).map(|x| x as i32),
            list,
            title: title(s(c, "name")),
            description: body(desc.trim_start()),
            start_at: date(c.get("start")),
            due_at: date(c.get("due")),
            created_at: trello_created(s(c, "id")),
            done,
            done_at: if done { date(c.get("dateLastActivity")) } else { None },
            updated_at: date(c.get("dateLastActivity")),
            archived: b(c, "closed"),
            labels: arr(c, "idLabels").iter().filter_map(|x| x.as_str().and_then(|x| label_index.get(x).copied())).collect(),
            assignees: arr(c, "idMembers").iter().filter_map(|x| x.as_str().and_then(|x| member_index.get(x).copied())).collect(),
            comments: cm,
            ..Default::default()
        });
    }
    m.people = people;
    m
}

/// Trello ids start with the creation time: the first 8 hex digits are seconds since 1970.
fn trello_created(id: &str) -> Option<DateTime<Utc>> {
    if id.len() != 24 {
        return None;
    }
    let secs = i64::from_str_radix(id.get(..8)?, 16).ok()?;
    DateTime::from_timestamp(secs, 0).filter(|d| d.timestamp() > 1_200_000_000)
}

// ---------- Wekan ----------

pub fn wekan(v: &Value) -> Model {
    let mut m = Model { source: "Wekan", name: name(s(v, "title")), description: body(s(v, "description")), color: None, ..Default::default() };
    let id = |x: &Value| x.get("_id").or_else(|| x.get("id")).and_then(|i| i.as_str()).unwrap_or("").to_string();
    let mut lists: Vec<&Value> = arr(v, "lists").iter().collect();
    lists.sort_by(|a, b| num(a, "sort").total_cmp(&num(b, "sort")));
    let list_index: HashMap<String, usize> = lists.iter().enumerate().map(|(i, l)| (id(l), i)).collect();
    m.lists = lists
        .iter()
        .take(MAX_LISTS)
        .map(|l| MList { name: name(s(l, "title")), archived: b(l, "archived"), color: l.get("color").and_then(|c| c.as_str()).and_then(named), wip_limit: None })
        .collect();
    let label_index: HashMap<String, usize> = arr(v, "labels")
        .iter()
        .take(MAX_LABELS)
        .enumerate()
        .map(|(i, l)| {
            let color = l.get("color").and_then(|c| c.as_str()).and_then(named).unwrap_or_else(|| "#a1a1aa".into());
            let n = s(l, "name");
            m.labels.push(MLabel { name: if n.trim().is_empty() { s(l, "color").to_string() } else { name(n) }, color });
            (id(l), i)
        })
        .collect();
    let mut people = Vec::new();
    let user_index: HashMap<String, usize> = arr(v, "users")
        .iter()
        .map(|u| {
            let full = u.pointer("/profile/fullname").and_then(|x| x.as_str()).unwrap_or("");
            let username = s(u, "username");
            let i = person(
                &mut people,
                Person { name: name(if full.is_empty() { username } else { full }), username: Some(username.to_string()).filter(|x| !x.is_empty()), email: None },
            );
            (id(u), i)
        })
        .collect();
    let user_name = |uid: &str| user_index.get(uid).map(|&i| people[i].name.clone()).unwrap_or_else(|| "Wekan".into());
    // checklists and their items, by card
    let mut items: HashMap<String, Vec<&Value>> = HashMap::new();
    for it in arr(v, "checklistItems") {
        items.entry(s(it, "checklistId").to_string()).or_default().push(it);
    }
    let mut checklists: HashMap<String, Vec<&Value>> = HashMap::new();
    for cl in arr(v, "checklists") {
        checklists.entry(s(cl, "cardId").to_string()).or_default().push(cl);
    }
    // a comment's card: its own cardId, or the "addComment" activity that points at it
    let via_activity: HashMap<&str, &str> =
        arr(v, "activities").iter().filter(|a| s(a, "activityType") == "addComment").map(|a| (s(a, "commentId"), s(a, "cardId"))).collect();
    let mut comments: HashMap<String, Vec<MComment>> = HashMap::new();
    for c in arr(v, "comments") {
        let cid = id(c);
        let card = match s(c, "cardId") {
            "" => via_activity.get(cid.as_str()).copied().unwrap_or(""),
            x => x,
        };
        comments.entry(card.to_string()).or_default().push(MComment { author: user_name(s(c, "userId")), body: body(s(c, "text")), created_at: date(c.get("createdAt")) });
    }
    let mut cards: Vec<&Value> = arr(v, "cards").iter().collect();
    cards.sort_by(|a, b| num(a, "sort").total_cmp(&num(b, "sort")));
    for c in cards.into_iter().take(MAX_CARDS) {
        let Some(&list) = list_index.get(s(c, "listId")) else { continue };
        if list >= m.lists.len() {
            continue;
        }
        let cid = id(c);
        let mut desc = body(s(c, "description"));
        let mut cls = checklists.remove(&cid).unwrap_or_default();
        cls.sort_by(|a, b| num(a, "sort").total_cmp(&num(b, "sort")));
        for cl in cls {
            let mut its = items.remove(&id(cl)).unwrap_or_default();
            its.sort_by(|a, b| num(a, "sort").total_cmp(&num(b, "sort")));
            desc += &checklist_md(s(cl, "title"), &its.iter().map(|i| (s(i, "title").to_string(), b(i, "isFinished"))).collect::<Vec<_>>());
        }
        let mut who: Vec<usize> = arr(c, "assignees").iter().chain(arr(c, "members")).filter_map(|x| x.as_str().and_then(|x| user_index.get(x).copied())).collect();
        who.dedup();
        let mut cm = comments.remove(&cid).unwrap_or_default();
        cm.sort_by_key(|x| x.created_at);
        let end = date(c.get("endAt"));
        m.cards.push(MCard {
            number: c.get("cardNumber").and_then(|x| x.as_i64()).map(|x| x as i32).filter(|n| *n > 0),
            list,
            title: title(s(c, "title")),
            description: body(desc.trim_start()),
            color: c.get("color").and_then(|x| x.as_str()).and_then(named),
            start_at: date(c.get("startAt")),
            due_at: date(c.get("dueAt")),
            created_at: date(c.get("createdAt")),
            updated_at: date(c.get("dateLastActivity")).or_else(|| date(c.get("modifiedAt"))),
            done: end.is_some(),
            done_at: end,
            archived: b(c, "archived"),
            labels: arr(c, "labelIds").iter().filter_map(|x| x.as_str().and_then(|x| label_index.get(x).copied())).collect(),
            assignees: who,
            comments: cm,
            ..Default::default()
        });
    }
    if !arr(v, "attachments").is_empty() {
        m.warnings.push("wekan_attachments".into());
    }
    m.people = people;
    m
}

// ---------- Kanb ----------

/// "Name · @username" (how Kanb writes people) → (name, username).
fn kanb_person(s: &str) -> Person {
    match s.rsplit_once(" · @") {
        Some((n, u)) => Person { name: name(n.trim_start_matches("[Deleted User] ")), username: Some(u.trim().to_string()), email: None },
        None => Person { name: name(s), username: None, email: None },
    }
}

pub fn kanb(v: &Value) -> Model {
    let bd = v.get("board").cloned().unwrap_or(Value::Null);
    let mut m = Model { source: "Kanb", name: name(s(&bd, "name")), description: body(s(&bd, "description")), color: hex(s(&bd, "color")), ..Default::default() };
    m.lists = arr(v, "columns")
        .iter()
        .take(MAX_LISTS)
        .map(|l| MList {
            name: name(s(l, "name")),
            archived: b(l, "archived"),
            color: l.get("color").and_then(|c| c.as_str()).and_then(hex),
            wip_limit: l.get("wip_limit").and_then(|x| x.as_i64()).map(|x| x as i32).filter(|x| *x > 0),
        })
        .collect();
    m.statuses = arr(v, "statuses")
        .iter()
        .map(|st| MStatus { name: name(s(st, "name")), color: hex(s(st, "color")).unwrap_or_else(|| "#a1a1aa".into()), done: b(st, "done") })
        .collect();
    m.labels = arr(v, "labels").iter().take(MAX_LABELS).map(|l| MLabel { name: name(s(l, "name")), color: hex(s(l, "color")).unwrap_or_else(|| "#a1a1aa".into()) }).collect();
    let mut people = Vec::new();
    for p in arr(v, "members") {
        person(&mut people, Person { name: name(s(p, "name")).split(" · @").next().unwrap_or("").to_string(), username: Some(s(p, "username").to_string()), email: None });
    }
    for c in arr(v, "cards").iter().take(MAX_CARDS) {
        // newer exports say which column by position; older ones only by name (the first one with that name)
        let list = c
            .get("column_index")
            .and_then(|x| x.as_u64())
            .map(|x| x as usize)
            .or_else(|| {
                let (n, a) = (s(c, "column"), b(c, "column_archived"));
                m.lists.iter().position(|l| l.name == n && l.archived == a).or_else(|| m.lists.iter().position(|l| l.name == n))
            })
            .filter(|i| *i < m.lists.len());
        let Some(list) = list else { continue };
        let labels: Vec<usize> = arr(c, "labels").iter().filter_map(|x| x.as_str()).filter_map(|n| m.labels.iter().position(|l| l.name == n)).collect();
        let assignees: Vec<usize> = arr(c, "assignees").iter().filter_map(|x| x.as_str()).map(|x| person(&mut people, kanb_person(x))).collect();
        m.cards.push(MCard {
            number: c.get("number").and_then(|x| x.as_i64()).map(|x| x as i32),
            list,
            title: title(s(c, "title")),
            description: body(s(c, "description")),
            priority: c.get("priority").and_then(|x| x.as_i64()).unwrap_or(0).clamp(0, 3) as i16,
            color: c.get("color").and_then(|x| x.as_str()).and_then(hex),
            status: c.get("status").and_then(|x| x.as_str()).map(str::to_string),
            done: b(c, "done"),
            done_at: date(c.get("done_at")),
            start_at: date(c.get("start_at")),
            due_at: date(c.get("due_at")),
            created_at: date(c.get("created_at")),
            updated_at: date(c.get("updated_at")),
            archived: c.get("archived_at").is_some_and(|x| !x.is_null()),
            labels,
            assignees,
            comments: arr(c, "comments")
                .iter()
                .map(|x| MComment {
                    author: x.get("author").and_then(|a| a.as_str()).map(|a| kanb_person(a).name).unwrap_or_else(|| "Kanb".into()),
                    body: body(s(x, "body")),
                    created_at: date(x.get("created_at")),
                })
                .collect(),
            files: arr(c, "attachments")
                .iter()
                .filter(|f| !s(f, "path").is_empty())
                .map(|f| MFile {
                    path: s(f, "path").to_string(),
                    filename: s(f, "filename").to_string(),
                    content_type: s(f, "content_type").to_string(),
                    inline: b(f, "inline"),
                    old_id: f.get("id").and_then(|x| x.as_str()).map(str::to_string),
                })
                .collect(),
            waits_for: arr(c, "waits_for").iter().filter_map(|x| x.as_i64()).map(|x| x as i32).collect(),
        });
    }
    m.card_templates = arr(v, "card_templates").to_vec();
    m.people = people;
    m
}

// ---------- CSV ----------

/// Which CSV column (by index) holds each card field.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct CsvMap {
    pub title: Option<usize>,
    pub column: Option<usize>,
    pub description: Option<usize>,
    pub status: Option<usize>,
    pub done: Option<usize>,
    pub labels: Option<usize>,
    pub assignees: Option<usize>,
    pub priority: Option<usize>,
    pub start: Option<usize>,
    pub due: Option<usize>,
    pub created: Option<usize>,
    pub number: Option<usize>,
    pub finished: Option<usize>,
    /// any value here (e.g. the date it was archived) = the card is archived
    pub archived: Option<usize>,
    /// dates like 03/04/2025 are day/month (true, the default) or month/day
    #[serde(default = "yes")]
    pub day_first: bool,
}

fn yes() -> bool {
    true
}

/// RFC 4180 CSV (quoted fields may hold the delimiter, quotes and line breaks). The delimiter is guessed from the
/// first line: comma, semicolon (Excel in many countries) or tab.
pub fn parse_csv(bytes: &[u8]) -> Result<Vec<Vec<String>>, &'static str> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| "csv_not_utf8")?;
    let first = text.lines().next().unwrap_or("");
    let delim = [',', ';', '\t'].into_iter().max_by_key(|d| first.matches(*d).count()).unwrap_or(',');
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(ch);
            }
        } else if ch == '"' && field.is_empty() {
            quoted = true;
        } else if ch == delim {
            row.push(std::mem::take(&mut field));
        } else if ch == '\n' || ch == '\r' {
            if ch == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            row.push(std::mem::take(&mut field));
            if row.iter().any(|f| !f.trim().is_empty()) {
                rows.push(std::mem::take(&mut row));
            } else {
                row.clear();
            }
            if rows.len() > MAX_CARDS + 1 {
                break;
            }
        } else {
            field.push(ch);
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        if row.iter().any(|f| !f.trim().is_empty()) {
            rows.push(row);
        }
    }
    if rows.is_empty() {
        return Err("csv_empty");
    }
    Ok(rows)
}

/// A first guess at which column is which, from the header names (English and Thai, plus Jira / Asana / Trello /
/// GitHub / Kanb export names).
pub fn guess(headers: &[String]) -> CsvMap {
    let find = |words: &[&str]| headers.iter().position(|h| words.iter().any(|w| h.trim().eq_ignore_ascii_case(w)));
    let mut m = CsvMap {
        title: find(&["title", "name", "summary", "task", "task name", "card name", "subject", "ชื่อ", "ชื่องาน", "หัวข้อ"]),
        column: find(&["column", "list", "list name", "section", "section/column", "stage", "board column", "คอลัมน์"]),
        description: find(&["description", "desc", "notes", "body", "details", "card description", "รายละเอียด"]),
        status: find(&["status", "state", "สถานะ"]),
        done: find(&["done", "completed", "complete", "is done", "เสร็จ"]),
        labels: find(&["labels", "label", "tags", "tag", "ป้ายกำกับ"]),
        assignees: find(&["assignees", "assignee", "assigned to", "owner", "members", "ผู้รับผิดชอบ"]),
        priority: find(&["priority", "ความสำคัญ"]),
        start: find(&["start", "start date", "start_date", "started", "วันเริ่ม"]),
        due: find(&["due", "due date", "due_date", "deadline", "due on", "กำหนดส่ง"]),
        created: find(&["created", "created at", "created_at", "created date", "created on"]),
        number: find(&["number", "#", "card number"]),
        archived: find(&["archived", "archived at", "archived on", "closed"]),
        finished: find(&["finished", "finished at", "done at", "completed at", "completed on", "resolved", "resolved at"]),
        day_first: true,
    };
    if m.title.is_none() && !headers.is_empty() {
        m.title = Some(0);
    }
    // with no column field, a status (To Do / In Progress / Done) is the natural column
    if m.column.is_none() {
        m.column = m.status.take();
    }
    m
}

/// A date in whatever way a spreadsheet wrote it; times without a zone are the server's local time.
pub fn csv_date(s: &str, day_first: bool) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(d) = s.parse::<DateTime<Utc>>() {
        return Some(d);
    }
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    let dm = if day_first { ["%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y", "%d.%m.%Y %H:%M", "%d.%m.%Y", "%d-%m-%Y"] } else { ["%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m/%d/%Y", "%m.%d.%Y %H:%M", "%m.%d.%Y", "%m-%d-%Y"] };
    let iso = ["%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y/%m/%d %H:%M", "%Y-%m-%d", "%Y/%m/%d"];
    for f in iso.iter().chain(dm.iter()) {
        let parsed = NaiveDateTime::parse_from_str(s, f).ok().or_else(|| NaiveDate::parse_from_str(s, f).ok().and_then(|d| d.and_hms_opt(9, 0, 0)));
        if let Some(n) = parsed {
            // Thai Buddhist years (2568 = 2025)
            let n = if n.year() > 2400 { n.with_year(n.year() - 543).unwrap_or(n) } else { n };
            return Local.from_local_datetime(&n).single().map(|d| d.with_timezone(&Utc));
        }
    }
    None
}

/// A column or status name that means "finished" (English and Thai).
pub fn is_done_word(s: &str) -> bool {
    matches!(
        s.trim().to_lowercase().as_str(),
        "done" | "completed" | "complete" | "closed" | "finished" | "resolved" | "shipped" | "released" | "เสร็จ" | "เสร็จแล้ว" | "เสร็จสิ้น"
    )
}

fn split_list(s: &str) -> Vec<String> {
    s.split([',', ';', '\n']).map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

fn csv_priority(s: &str) -> i16 {
    let s = s.trim().to_lowercase();
    if let Ok(n) = s.parse::<i16>() {
        return n.clamp(0, 3);
    }
    match s.as_str() {
        "highest" | "high" | "urgent" | "critical" | "สูง" => 3,
        "medium" | "normal" | "กลาง" => 2,
        "low" | "lowest" | "minor" | "ต่ำ" => 1,
        _ if s.chars().all(|c| c == '★' || c == '*') && !s.is_empty() => s.chars().count().min(3) as i16,
        _ => 0,
    }
}

fn truthy(s: &str) -> bool {
    matches!(s.trim().to_lowercase().as_str(), "yes" | "y" | "true" | "1" | "x" | "done" | "completed" | "complete" | "✓" | "✔" | "ใช่" | "เสร็จ")
}

pub fn csv(rows: &[Vec<String>], map: &CsvMap, file_name: &str) -> Model {
    let mut m = Model { source: "CSV", name: name(file_name.rsplit_once('.').map(|x| x.0).unwrap_or(file_name)), ..Default::default() };
    let get = |r: &Vec<String>, i: Option<usize>| i.and_then(|i| r.get(i)).map(|x| x.trim().to_string()).unwrap_or_default();
    let mut people = Vec::new();
    let mut bad_dates = 0;
    let map = &CsvMap { title: map.title.or(Some(0)), ..map.clone() };
    for r in rows.iter().skip(1).take(MAX_CARDS) {
        let t = get(r, map.title);
        if t.is_empty() {
            continue;
        }
        let col = match get(r, map.column) {
            c if c.is_empty() => "Imported".to_string(),
            c => name(&c),
        };
        let list = match m.lists.iter().position(|l| l.name == col) {
            Some(i) => i,
            None if m.lists.len() < MAX_LISTS => {
                m.lists.push(MList { name: col, archived: false, color: None, wip_limit: None });
                m.lists.len() - 1
            }
            None => continue,
        };
        let mut labels = Vec::new();
        for l in split_list(&get(r, map.labels)) {
            let i = match m.labels.iter().position(|x| x.name.eq_ignore_ascii_case(&l)) {
                Some(i) => i,
                None if m.labels.len() < MAX_LABELS => {
                    const PALETTE: [&str; 8] = ["#3b82f6", "#22c55e", "#eab308", "#f97316", "#ef4444", "#a855f7", "#14b8a6", "#ec4899"];
                    m.labels.push(MLabel { name: name(&l), color: PALETTE[m.labels.len() % PALETTE.len()].into() });
                    m.labels.len() - 1
                }
                None => continue,
            };
            labels.push(i);
        }
        let assignees: Vec<usize> = split_list(&get(r, map.assignees))
            .into_iter()
            .map(|a| {
                let p = if a.contains('@') && !a.contains(' ') {
                    Person { name: a.clone(), username: None, email: Some(a) }
                } else {
                    kanb_person(&a)
                };
                person(&mut people, p)
            })
            .collect();
        let mut d = |i: Option<usize>| {
            let raw = get(r, i);
            let v = csv_date(&raw, map.day_first);
            if v.is_none() && !raw.is_empty() {
                bad_dates += 1;
            }
            v
        };
        let (start_at, due_at, created_at, done_at) = (d(map.start), d(map.due), d(map.created), d(map.finished));
        let status = Some(get(r, map.status)).filter(|x| !x.is_empty() && map.status != map.column);
        let done = (map.done.is_some() && truthy(&get(r, map.done))) || done_at.is_some();
        m.cards.push(MCard {
            number: get(r, map.number).trim_start_matches('#').parse().ok(),
            archived: map.archived.is_some() && !get(r, map.archived).is_empty() && !matches!(get(r, map.archived).to_lowercase().as_str(), "no" | "false" | "0"),
            done_at,
            list,
            title: title(&t),
            description: body(&get(r, map.description)),
            priority: csv_priority(&get(r, map.priority)),
            status,
            done,
            start_at,
            due_at,
            created_at,
            labels,
            assignees,
            ..Default::default()
        });
    }
    if bad_dates > 0 {
        m.warnings.push(format!("csv_bad_dates:{bad_dates}"));
    }
    m.people = people;
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_with_quotes_breaks_and_bom() {
        let rows = parse_csv("\u{feff}Title;Notes\r\n\"a; b\";\"line1\nline2 \"\"q\"\"\"\r\nplain;x\r\n".as_bytes()).unwrap();
        assert_eq!(rows, vec![vec!["Title", "Notes"], vec!["a; b", "line1\nline2 \"q\""], vec!["plain", "x"]]);
    }

    #[test]
    fn trello_ids_carry_the_creation_time() {
        assert_eq!(trello_created("5f2b8c1e0000000000000000").unwrap().to_rfc3339(), "2020-08-06T04:50:38+00:00");
        assert!(trello_created("c1").is_none());
    }

    #[test]
    fn colours_are_only_hex() {
        assert_eq!(hex("#ABC").as_deref(), Some("#aabbcc"));
        assert_eq!(hex("url(https://x)"), None);
        assert_eq!(named("green_dark").as_deref(), Some("#22c55e"));
        assert_eq!(named("red;background:url(x)"), None);
    }

    #[test]
    fn dates() {
        let d = csv_date("2025-03-04", true).unwrap();
        assert_eq!(d.with_timezone(&Local).format("%m").to_string(), "03");
        let a = csv_date("04/03/2025", true).unwrap();
        let b = csv_date("03/04/2025", false).unwrap();
        assert_eq!(a, b);
        assert!(csv_date("not a date", true).is_none());
        assert_eq!(csv_date("04/03/2568", true).unwrap().with_timezone(&Local).format("%Y").to_string(), "2025");
    }

    #[test]
    fn guesses_kanb_csv() {
        let h: Vec<String> = ["Number", "Title", "Column", "Status", "Done", "Priority", "Labels", "Assignees", "Start", "Due"].iter().map(|s| s.to_string()).collect();
        let g = guess(&h);
        assert_eq!((g.title, g.column, g.status, g.done, g.due), (Some(1), Some(2), Some(3), Some(4), Some(9)));
    }
}
