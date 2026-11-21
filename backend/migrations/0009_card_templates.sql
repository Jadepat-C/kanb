-- Reusable card blueprints per board.
CREATE TABLE card_templates (
    id          uuid PRIMARY KEY,
    board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name        text NOT NULL,                          -- what the menu shows
    title       text NOT NULL,                          -- title of cards made from it
    description text NOT NULL DEFAULT '',
    priority    smallint NOT NULL DEFAULT 0,
    status_id   uuid REFERENCES board_statuses(id) ON DELETE SET NULL,
    label_ids   uuid[] NOT NULL DEFAULT '{}',
    due_in_days integer,                                -- due date = creation day + N (NULL = none)
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_templates_board_idx ON card_templates (board_id);
