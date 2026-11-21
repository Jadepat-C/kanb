-- Deleted users stay as tombstones so their comments/history can still say who did it
-- ("[Deleted User] Name (username)"). Their username and email become free for new accounts.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
-- Set when an admin chooses the password (create / reset); cleared when the user picks their own.
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

DROP INDEX users_username_key;
CREATE UNIQUE INDEX users_username_key ON users (lower(username)) WHERE deleted_at IS NULL;
DROP INDEX users_email_key;
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Instance-wide settings edited by super admins (e.g. SMTP for outgoing email).
CREATE TABLE app_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- One-time links: "set your password" (welcome email) and "reset password" (forgot password).
CREATE TABLE password_tokens (
    token_hash text PRIMARY KEY,                 -- sha256 of the token in the link
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    text NOT NULL,                    -- invite | reset
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz
);
CREATE INDEX password_tokens_user_idx ON password_tokens (user_id);
