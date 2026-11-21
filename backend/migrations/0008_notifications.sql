-- In-app (and optionally emailed) notifications.
CREATE TABLE notifications (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       text NOT NULL,                     -- assigned | mentioned | commented | due_soon | overdue
    board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    card_id    uuid REFERENCES cards(id) ON DELETE CASCADE,
    actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    data       jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at    timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);
-- due reminders are sent once per card, person and due date
CREATE UNIQUE INDEX notifications_due_once ON notifications (user_id, card_id, kind, (data->>'due_at'))
    WHERE kind IN ('due_soon', 'overdue');

ALTER TABLE users ADD COLUMN notify_email boolean NOT NULL DEFAULT true;
