-- Browser (Web Push) notifications: one row per subscribed browser.
CREATE TABLE push_subscriptions (
    id         uuid PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   text NOT NULL UNIQUE,
    p256dh     text NOT NULL,
    auth       text NOT NULL,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_ok_at timestamptz
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
