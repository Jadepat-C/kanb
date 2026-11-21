-- Board channels: post a board's activity to a shared Discord/Slack/Teams/… channel.
CREATE TABLE board_contact_points (
    id           uuid PRIMARY KEY,
    board_id     uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    kind         text NOT NULL,
    name         text NOT NULL,
    config       jsonb NOT NULL DEFAULT '{}',
    events       text[] NOT NULL DEFAULT '{}',    -- empty = everything
    locale       text NOT NULL DEFAULT 'en',      -- language of the posts
    enabled      boolean NOT NULL DEFAULT true,
    last_sent_at timestamptz,
    last_error   text,
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX board_contact_points_board_idx ON board_contact_points (board_id);

-- Due/overdue reminders already posted to board channels (one per card, kind and due date).
CREATE TABLE board_due_posts (
    card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    kind    text NOT NULL,
    due_at  timestamptz NOT NULL,
    PRIMARY KEY (card_id, kind, due_at)
);

-- How far the activity sender has read card_events (starts now: no backlog is posted).
INSERT INTO app_settings (key, value)
SELECT 'board_events_cursor', jsonb_build_object('last', COALESCE(max(id), 0)) FROM card_events
ON CONFLICT (key) DO NOTHING;
