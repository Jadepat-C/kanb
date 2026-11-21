-- Kanban: single-organization schema.
-- Ordering columns (`position`) hold fractional-index keys; always ORDER BY position COLLATE "C".

CREATE TABLE users (
    id                uuid PRIMARY KEY,
    username          text NOT NULL,
    display_name      text NOT NULL,
    email             text,
    password_hash     text,                       -- NULL = no local password (future SSO-only users)
    totp_secret       text,                       -- reserved for 2FA
    is_super_admin    boolean NOT NULL DEFAULT false,
    can_create_boards boolean NOT NULL DEFAULT true,
    is_active         boolean NOT NULL DEFAULT true,
    locale            text NOT NULL DEFAULT 'en',
    theme             text NOT NULL DEFAULT 'system',
    avatar_color      text NOT NULL DEFAULT '#6366f1',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE sessions (
    token_hash   text PRIMARY KEY,                -- sha256(cookie token); the raw token is never stored
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE boards (
    id          uuid PRIMARY KEY,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    color       text NOT NULL DEFAULT '#6366f1',
    card_seq    integer NOT NULL DEFAULT 0,       -- last issued card number (#1, #2 ...)
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz
);

-- Board roles are per board and fully customizable (a set of permission strings).
CREATE TABLE board_roles (
    id          uuid PRIMARY KEY,
    board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name        text NOT NULL,
    permissions text[] NOT NULL DEFAULT '{}',
    is_owner    boolean NOT NULL DEFAULT false,   -- owner role: all permissions, cannot be deleted
    position    integer NOT NULL DEFAULT 0
);
CREATE INDEX board_roles_board_idx ON board_roles (board_id);

CREATE TABLE board_members (
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id  uuid NOT NULL REFERENCES board_roles(id),
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (board_id, user_id)
);
CREATE INDEX board_members_user_idx ON board_members (user_id);

CREATE TABLE lists (
    id         uuid PRIMARY KEY,
    board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name       text NOT NULL,
    position   text NOT NULL,
    color      text,
    folded     boolean NOT NULL DEFAULT false,
    wip_limit  integer,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lists_board_idx ON lists (board_id);

CREATE TABLE cards (
    id          uuid PRIMARY KEY,
    board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    list_id     uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    number      integer NOT NULL,
    title       text NOT NULL,
    description text NOT NULL DEFAULT '',          -- markdown
    position    text NOT NULL,
    priority    smallint NOT NULL DEFAULT 0,       -- 0..3 stars
    status      text NOT NULL DEFAULT 'normal',    -- normal | blocked | ready
    color       text,
    due_at      timestamptz,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    UNIQUE (board_id, number)
);
CREATE INDEX cards_list_idx ON cards (list_id);
CREATE INDEX cards_board_idx ON cards (board_id);

CREATE TABLE labels (
    id       uuid PRIMARY KEY,
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name     text NOT NULL,
    color    text NOT NULL
);
CREATE INDEX labels_board_idx ON labels (board_id);

CREATE TABLE card_labels (
    card_id  uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    label_id uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, label_id)
);

CREATE TABLE card_assignees (
    card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, user_id)
);

CREATE TABLE comments (
    id         uuid PRIMARY KEY,
    card_id    uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    body       text NOT NULL,                      -- markdown
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX comments_card_idx ON comments (card_id);

-- Append-only activity log ("chatter"). Written in the same transaction as the change.
CREATE TABLE card_events (
    id         bigserial PRIMARY KEY,
    card_id    uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    kind       text NOT NULL,
    data       jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_events_card_idx ON card_events (card_id, id);

CREATE TABLE attachments (
    id           uuid PRIMARY KEY,
    board_id     uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    card_id      uuid REFERENCES cards(id) ON DELETE CASCADE,
    uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    filename     text NOT NULL,
    content_type text NOT NULL,
    size         bigint NOT NULL,
    object_key   text NOT NULL,
    is_inline    boolean NOT NULL DEFAULT false,   -- pasted into markdown (not listed as a regular attachment)
    created_at   timestamptz NOT NULL DEFAULT now(),
    deleted_at   timestamptz
);
CREATE INDEX attachments_card_idx ON attachments (card_id);
