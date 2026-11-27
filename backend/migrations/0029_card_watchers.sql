-- People who watch a card: they're notified about it as if it were theirs (Profile → Notifications decides which
-- kinds), without being assigned.
CREATE TABLE card_watchers (
    card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (card_id, user_id)
);
CREATE INDEX card_watchers_user ON card_watchers (user_id);
