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
pub const ANALYTICS_VIEW: &str = "analytics.view"; // the board's Analytics view (KPIs)
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
    ("board", &[BOARD_MANAGE, STATUSES_MANAGE, LABELS_MANAGE, TEMPLATES_MANAGE, NOTIFICATIONS_MANAGE, ANALYTICS_VIEW, BOARD_ARCHIVE, BOARD_DELETE]),
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
    ANALYTICS_VIEW,
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

/// Permissions that a role's "only cards they created" setting narrows to the member's own cards.
pub const OWN_SCOPED: &[&str] = &[
    CARDS_EDIT,
    CARDS_STATUS,
    CARDS_DUE,
    CARDS_DEPENDENCIES,
    CARDS_ASSIGN,
    CARDS_LABELS,
    CARDS_MOVE,
    CARDS_ARCHIVE,
    CARDS_DELETE,
    ATTACHMENTS_UPLOAD,
    ATTACHMENTS_DELETE,
];

#[derive(Debug, Clone)]
pub struct BoardAccess {
    pub user_id: Uuid,
    pub perms: Vec<String>,
    pub role_id: Option<Uuid>,
    pub is_owner: bool,
    /// the role's card permissions only cover cards this member created
    pub own_cards_only: bool,
    /// columns this member may add cards to (None = any)
    pub card_list_ids: Option<Vec<Uuid>>,
}

impl BoardAccess {
    /// Holds the permission at all (for at least their own cards). Card handlers use [`Self::require_on`].
    pub fn can(&self, perm: &str) -> bool {
        self.is_owner || self.perms.iter().any(|p| p == perm)
    }
    pub fn require(&self, perm: &str) -> AppResult<()> {
        if self.can(perm) { Ok(()) } else { Err(AppError::Forbidden) }
    }
    fn limited(&self, perm: &str) -> bool {
        !self.is_owner && self.own_cards_only && OWN_SCOPED.contains(&perm)
    }
    /// The permission on one card, given who created it.
    pub fn can_on(&self, perm: &str, created_by: Option<Uuid>) -> bool {
        self.can(perm) && (!self.limited(perm) || created_by == Some(self.user_id))
    }
    pub fn require_on(&self, perm: &str, created_by: Option<Uuid>) -> AppResult<()> {
        if self.can_on(perm, created_by) { Ok(()) } else { Err(AppError::Forbidden) }
    }
    /// The permission on every card, e.g. to re-sort a whole column.
    pub fn require_all(&self, perm: &str) -> AppResult<()> {
        if self.can(perm) && !self.limited(perm) { Ok(()) } else { Err(AppError::Forbidden) }
    }
    /// May add a card to this column (cards.create, and the column is one the role allows).
    pub fn can_create_in(&self, list_id: Uuid) -> bool {
        self.can(CARDS_CREATE) && (self.is_owner || self.card_list_ids.as_ref().is_none_or(|l| l.contains(&list_id)))
    }
    pub fn require_create_in(&self, list_id: Uuid) -> AppResult<()> {
        if self.can_create_in(list_id) { Ok(()) } else { Err(AppError::Forbidden) }
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
    #[allow(clippy::type_complexity)]
    let row: Option<(Option<Uuid>, Option<Vec<String>>, Option<bool>, Option<bool>, Option<Vec<Uuid>>)> = sqlx::query_as(
        "SELECT m.role_id, r.permissions, r.is_owner, r.own_cards_only, r.card_list_ids
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
    let (role_id, perms, is_owner, own_cards_only, card_list_ids) = row.ok_or(AppError::NotFound)?;
    if user.is_super_admin {
        return Ok(BoardAccess {
            user_id: user.id,
            perms: ALL.iter().map(|s| s.to_string()).collect(),
            role_id,
            is_owner: true,
            own_cards_only: false,
            card_list_ids: None,
        });
    }
    match role_id {
        Some(_) => Ok(BoardAccess {
            user_id: user.id,
            perms: perms.unwrap_or_default(),
            role_id,
            is_owner: is_owner.unwrap_or(false),
            own_cards_only: own_cards_only.unwrap_or(false),
            card_list_ids,
        }),
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

/// Board of a card and who created it (for "only cards they created" roles).
pub async fn card_owner(db: &PgPool, card_id: Uuid) -> AppResult<(Uuid, Option<Uuid>)> {
    Ok(sqlx::query_as("SELECT board_id, created_by FROM cards WHERE id = $1 AND archived_at IS NULL")
        .bind(card_id)
        .fetch_one(db)
        .await?)
}

/// [`card_owner`] including archived cards (restore / permanent delete).
pub async fn card_owner_any(db: &PgPool, card_id: Uuid) -> AppResult<(Uuid, Option<Uuid>)> {
    Ok(sqlx::query_as("SELECT board_id, created_by FROM cards WHERE id = $1").bind(card_id).fetch_one(db).await?)
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

    fn member(perms: &[&str], own_cards_only: bool, card_list_ids: Option<Vec<Uuid>>) -> BoardAccess {
        BoardAccess {
            user_id: Uuid::from_u128(1),
            perms: perms.iter().map(|s| s.to_string()).collect(),
            role_id: Some(Uuid::from_u128(9)),
            is_owner: false,
            own_cards_only,
            card_list_ids,
        }
    }

    #[test]
    fn own_cards_only_limits_card_permissions_to_own_cards() {
        let a = member(&[CARDS_EDIT, CARDS_DELETE, COMMENTS_CREATE], true, None);
        let (me, other) = (Some(Uuid::from_u128(1)), Some(Uuid::from_u128(2)));
        assert!(a.can_on(CARDS_EDIT, me));
        assert!(!a.can_on(CARDS_EDIT, other));
        assert!(!a.can_on(CARDS_DELETE, None)); // creator account gone: not theirs
        assert!(a.can_on(COMMENTS_CREATE, other)); // commenting isn't limited
        assert!(a.require_all(CARDS_EDIT).is_err());
        assert!(!a.can_on(CARDS_MOVE, me)); // still needs the permission itself
        let owner = BoardAccess { is_owner: true, ..a.clone() };
        assert!(owner.can_on(CARDS_EDIT, other));
        assert!(owner.require_all(CARDS_DELETE).is_ok());
    }

    #[test]
    fn column_limits_apply_to_new_cards() {
        let (inbox, done) = (Uuid::from_u128(5), Uuid::from_u128(6));
        let a = member(&[CARDS_CREATE], false, Some(vec![inbox]));
        assert!(a.can_create_in(inbox));
        assert!(!a.can_create_in(done));
        assert!(member(&[CARDS_CREATE], false, None).can_create_in(done));
        assert!(!member(&[CARDS_CREATE], false, Some(vec![])).can_create_in(inbox));
        assert!(!member(&[], false, None).can_create_in(inbox));
        assert!(BoardAccess { is_owner: true, ..a }.can_create_in(done));
    }
}
