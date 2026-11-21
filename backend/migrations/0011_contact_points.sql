-- Personal notification channels ("contact points"): Discord, Slack, Teams, Google Chat, Telegram, LINE, ntfy, Gotify, webhook.
CREATE TABLE contact_points (
    id           uuid PRIMARY KEY,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         text NOT NULL,
    name         text NOT NULL,
    config       jsonb NOT NULL DEFAULT '{}',     -- url / token / chat id … (secrets are never sent back to the browser)
    events       text[] NOT NULL DEFAULT '{}',    -- which notification kinds; empty = all
    enabled      boolean NOT NULL DEFAULT true,
    last_sent_at timestamptz,
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_points_user_idx ON contact_points (user_id);
-- System switches (Admin → Notifications). Until a super admin turns them on, nothing leaves the server.
INSERT INTO app_settings (key, value) VALUES ('notifications', '{"email": false, "push": false, "allow_private": false}')
ON CONFLICT (key) DO NOTHING;
