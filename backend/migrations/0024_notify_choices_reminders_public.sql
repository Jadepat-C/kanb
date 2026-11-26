-- "Clear" in the bell hides notifications without deleting them: a due reminder's row is what stops the
-- due job from sending it again.
ALTER TABLE notifications ADD COLUMN cleared_at timestamptz;
DROP INDEX notifications_user_idx;
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC) WHERE cleared_at IS NULL;

-- What each person wants to be notified about (Profile → Notifications). The five that existed before stay on;
-- the new card-activity kinds start off.
ALTER TABLE users ADD COLUMN notify_events text[] NOT NULL
    DEFAULT '{assigned,mentioned,commented,due_soon,overdue}';

-- Card activity for personal notifications is read from card_events with its own cursor (starting now, so
-- nothing old is sent).
INSERT INTO app_settings (key, value)
SELECT 'personal_events_cursor', jsonb_build_object('last', COALESCE(max(id), 0)) FROM card_events
ON CONFLICT (key) DO NOTHING;

-- Per-card "due soon" reminder: minutes before the due date (NULL = 1 day, 0 = no reminder).
ALTER TABLE cards ADD COLUMN remind_minutes int CHECK (remind_minutes BETWEEN 0 AND 43200);
-- one reminder per card, person, due date and reminder time (changing the time reminds again)
DROP INDEX notifications_due_once;
CREATE UNIQUE INDEX notifications_due_once
    ON notifications (user_id, card_id, kind, (data->>'due_at'), (COALESCE(data->>'remind', '1440')))
    WHERE kind IN ('due_soon', 'overdue');

-- Read-only public link to a board (Board settings → Share). The token is the link's secret; anyone who can read
-- this table can read the board anyway.
ALTER TABLE boards
    ADD COLUMN public_token text UNIQUE,
    ADD COLUMN public_comments boolean NOT NULL DEFAULT false,
    ADD COLUMN public_files boolean NOT NULL DEFAULT false;
