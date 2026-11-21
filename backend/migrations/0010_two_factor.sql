-- Optional authenticator-app sign-in (TOTP, RFC 6238). users.totp_secret already exists (reserved in 0001).
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN totp_pending_secret text;            -- during setup, before the first code is confirmed
ALTER TABLE users ADD COLUMN totp_last_step bigint;               -- last accepted 30 s step: a code can't be reused
ALTER TABLE users ADD COLUMN totp_recovery text[] NOT NULL DEFAULT '{}';   -- sha256 of unused recovery codes

-- Password accepted, waiting for the authenticator code (5 minutes, 5 tries).
CREATE TABLE login_challenges (
    token_hash text PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    attempts   integer NOT NULL DEFAULT 0
);
