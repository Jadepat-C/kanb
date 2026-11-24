-- Admin tools: activity log, signed-in devices, last active.

-- What happened, by whom, when. Names are joined from users when read (deleted accounts show as "[Deleted User]").
-- `data` never holds secret values: settings changes list the fields that changed, not what they were set to.
CREATE TABLE audit_log (
    id         bigserial PRIMARY KEY,
    at         timestamptz NOT NULL DEFAULT now(),
    actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    kind       text NOT NULL,
    target_id  uuid,          -- a user or board, depending on kind
    ip         text,
    data       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX audit_log_kind_idx ON audit_log (kind, at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_id, at DESC);

-- Signed-in devices: an id the admin page can name (the token hash stays on the server) and where it signed in from.
ALTER TABLE sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX sessions_id_key ON sessions (id);
ALTER TABLE sessions ADD COLUMN ip text;

-- Last time the account used Kanb (updated with the session, at most every 10 minutes).
-- NULL = not recorded yet, which is not the same as "never signed in".
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;
UPDATE users u SET last_seen_at = s.seen FROM (SELECT user_id, max(last_seen_at) AS seen FROM sessions GROUP BY user_id) s
WHERE s.user_id = u.id;
