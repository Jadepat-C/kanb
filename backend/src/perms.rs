//! Board-level permissions. Super admins implicitly hold every permission on every board;
//! everyone else needs a membership whose role lists the permission.

use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    auth::User,
    error::{AppError, AppResult},
};

// Board setup
pub const BOARD_MANAGE: &str = "board.manage"; // name, description, colour
pub const BOARD_ARCHIVE: &str = "board.archive"; // archive / restore the board
pub const BOARD_DELETE: &str = "board.delete"; // delete permanently
pub const STATUSES_MANAGE: &str = "statuses.manage";
pub const LABELS_MANAGE: &str = "labels.manage";
pub const TEMPLATES_MANAGE: &str = "templates.manage";
pub const NOTIFICATIONS_MANAGE: &str = "notifications.manage"; // board chat/push channels
// Members & roles
pub const MEMBERS_MANAGE: &str = "members.manage"; // add / remove members, change their role
pub const ROLES_MANAGE: &str = "roles.manage"; // create / edit / delete roles
// Columns
pub const LISTS_CREATE: &str = "lists.create";
pub const LISTS_EDIT: &str = "lists.edit"; // rename, reorder, fold, colour
pub const LISTS_ARCHIVE: &str = "lists.archive"; // archive / restore
pub const LISTS_DELETE: &str = "lists.delete"; // delete permanently (+ cards.delete when it has cards)
// Cards
pub const CARDS_CREATE: &str = "cards.create"; // new, duplicate, from template
pub const CARDS_EDIT: &str = "cards.edit"; // title, description, priority, colour
pub const CARDS_STATUS: &str = "cards.status";
pub const CARDS_DUE: &str = "cards.due"; // start and due dates
pub const CARDS_DEPENDENCIES: &str = "cards.dependencies";
pub const CARDS_ASSIGN: &str = "cards.assign";
pub const CARDS_LABELS: &str = "cards.labels";
pub const CARDS_MOVE: &str = "cards.move"; // drag between / within columns, sort a column
pub const CARDS_ARCHIVE: &str = "cards.archive"; // archive / restore
pub const CARDS_DELETE: &str = "cards.delete"; // delete permanently
// Comments
pub const COMMENTS_CREATE: &str = "comments.create";
pub const COMMENTS_MODERATE: &str = "comments.moderate";
// Attachments
pub const ATTACHMENTS_UPLOAD: &str = "attachments.upload";
pub const ATTACHMENTS_DELETE: &str = "attachments.delete";

/// Permissions by topic, in display order (the role editor shows these groups).
pub const GROUPS: &[(&str, &[&str])] = &[
    ("board", &[BOARD_MANAGE, STATUSES_MANAGE, LABELS_MANAGE, TEMPLATES_MANAGE, NOTIFICATIONS_MANAGE, BOARD_ARCHIVE, BOARD_DELETE]),
    ("members", &[MEMBERS_MANAGE, ROLES_MANAGE]),
    ("lists", &[LISTS_CREATE, LISTS_EDIT, LISTS_ARCHIVE, LISTS_DELETE]),
    ("cards", &[CARDS_CREATE, CARDS_EDIT, CARDS_STATUS, CARDS_DUE, CARDS_DEPENDENCIES, CARDS_ASSIGN, CARDS_LABELS, CARDS_MOVE, CARDS_ARCHIVE, CARDS_DELETE]),
    ("comments", &[COMMENTS_CREATE, COMMENTS_MODERATE]),
    ("attachments", &[ATTACHMENTS_UPLOAD, ATTACHMENTS_DELETE]),
];

pub const ALL: &[&str] = &[
    BOARD_MANAGE,
    STATUSES_MANAGE,
    LABELS_MANAGE,
    TEMPLATES_MANAGE,
    NOTIFICATIONS_MANAGE,
    BOARD_ARCHIVE,
    BOARD_DELETE,
    MEMBERS_MANAGE,
    ROLES_MANAGE,
    LISTS_CREATE,
    LISTS_EDIT,
    LISTS_ARCHIVE,
    LISTS_DELETE,
    CARDS_CREATE,
    CARDS_EDIT,
    CARDS_STATUS,
    CARDS_DUE,
    CARDS_DEPENDENCIES,
    CARDS_ASSIGN,
    CARDS_LABELS,
    CARDS_MOVE,
    CARDS_ARCHIVE,
    CARDS_DELETE,
    COMMENTS_CREATE,
    COMMENTS_MODERATE,
    ATTACHMENTS_UPLOAD,
    ATTACHMENTS_DELETE,
];

/// Roles created with every new board: (name, is_owner, permissions).
pub fn default_roles() -> Vec<(&'static str, bool, Vec<&'static str>)> {
    vec![
        ("Owner", true, ALL.to_vec()),
        ("Admin", false, ALL.iter().copied().filter(|p| *p != BOARD_DELETE).collect()),
        (
            "Editor",
            false,
            vec![
                LABELS_MANAGE,
                TEMPLATES_MANAGE,
                CARDS_CREATE,
                CARDS_EDIT,
                CARDS_STATUS,
                CARDS_DUE,
                CARDS_DEPENDENCIES,
                CARDS_ASSIGN,
                CARDS_LABELS,
                CARDS_MOVE,
                CARDS_ARCHIVE,
                CARDS_DELETE,
                COMMENTS_CREATE,
                ATTACHMENTS_UPLOAD,
                ATTACHMENTS_DELETE,
            ],
        ),
        ("Commenter", false, vec![COMMENTS_CREATE]),
        ("Viewer", false, vec![]),
    ]
}

#[derive(Debug, Clone)]
pub struct BoardAccess {
    pub perms: Vec<String>,
    pub role_id: Option<Uuid>,
    pub is_owner: bool,
}

impl BoardAccess {
    pub fn can(&self, perm: &str) -> bool {
        self.is_owner || self.perms.iter().any(|p| p == perm)
    }
    pub fn require(&self, perm: &str) -> AppResult<()> {
        if self.can(perm) { Ok(()) } else { Err(AppError::Forbidden) }
    }
    pub fn granted(&self) -> Vec<String> {
        ALL.iter().filter(|p| self.can(p)).map(|p| p.to_string()).collect()
    }
}

/// Returns NotFound (not Forbidden) for boards the user cannot see, so board ids don't leak.
pub async fn board_access(db: &PgPool, user: &User, board_id: Uuid) -> AppResult<BoardAccess> {
    access(db, user, board_id, false).await
}

/// Same as [`board_access`] but also for archived boards (restore / permanent delete / archive view).
pub async fn board_access_incl_archived(db: &PgPool, user: &User, board_id: Uuid) -> AppResult<BoardAccess> {
    access(db, user, board_id, true).await
}

async fn access(db: &PgPool, user: &User, board_id: Uuid, include_archived: bool) -> AppResult<BoardAccess> {
    let row: Option<(Option<Uuid>, Option<Vec<String>>, Option<bool>)> = sqlx::query_as(
        "SELECT m.role_id, r.permissions, r.is_owner
         FROM boards b
         LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = $2
         LEFT JOIN board_roles r ON r.id = m.role_id
         WHERE b.id = $1 AND ($3 OR b.archived_at IS NULL)",
    )
    .bind(board_id)
    .bind(user.id)
    .bind(include_archived)
    .fetch_optional(db)
    .await?;
    let (role_id, perms, is_owner) = row.ok_or(AppError::NotFound)?;
    if user.is_super_admin {
        return Ok(BoardAccess { perms: ALL.iter().map(|s| s.to_string()).collect(), role_id, is_owner: true });
    }
    match role_id {
        Some(_) => Ok(BoardAccess { perms: perms.unwrap_or_default(), role_id, is_owner: is_owner.unwrap_or(false) }),
        None => Err(AppError::NotFound),
    }
}

pub async fn board_of_list(db: &PgPool, list_id: Uuid) -> AppResult<Uuid> {
    let (b,): (Uuid,) = sqlx::query_as("SELECT board_id FROM lists WHERE id = $1 AND archived_at IS NULL")
        .bind(list_id)
        .fetch_one(db)
        .await?;
    Ok(b)
}

/// Board of a column, including archived columns (archive view: restore / delete).
pub async fn board_of_list_any(db: &PgPool, list_id: Uuid) -> AppResult<Uuid> {
    let (b,): (Uuid,) = sqlx::query_as("SELECT board_id FROM lists WHERE id = $1").bind(list_id).fetch_one(db).await?;
    Ok(b)
}

pub async fn board_of_card(db: &PgPool, card_id: Uuid) -> AppResult<Uuid> {
    let (b,): (Uuid,) = sqlx::query_as("SELECT board_id FROM cards WHERE id = $1 AND archived_at IS NULL")
        .bind(card_id)
        .fetch_one(db)
        .await?;
    Ok(b)
}

/// Board of a card, including archived cards (for restore / permanent delete).
pub async fn board_of_card_any(db: &PgPool, card_id: Uuid) -> AppResult<Uuid> {
    let (b,): (Uuid,) = sqlx::query_as("SELECT board_id FROM cards WHERE id = $1").bind(card_id).fetch_one(db).await?;
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_cover_every_permission_once() {
        let mut grouped: Vec<&str> = GROUPS.iter().flat_map(|(_, p)| p.iter().copied()).collect();
        let mut all = ALL.to_vec();
        grouped.sort();
        all.sort();
        assert_eq!(grouped, all);
    }
}
