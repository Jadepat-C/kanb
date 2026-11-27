-- Single sign-on (OpenID Connect): which provider accounts sign in as which Kanb account. Settings live in
-- app_settings (key 'sso'), with the client secret encrypted like the SMTP password.
CREATE TABLE user_identities (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- the provider's "iss" and "sub": together they name one person, for good (emails can change)
    issuer text NOT NULL,
    subject text NOT NULL,
    -- the email the provider gave last time, shown on the Profile page
    email text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    UNIQUE (issuer, subject)
);
CREATE INDEX user_identities_user ON user_identities (user_id);

-- A sign-in on its way through the provider (a few minutes at most). Bound to the browser by a cookie whose hash
-- is the key; state, nonce and the PKCE verifier are checked when the provider sends the browser back.
CREATE TABLE sso_flows (
    token_hash text PRIMARY KEY,
    state text NOT NULL,
    nonce text NOT NULL,
    verifier text NOT NULL,
    -- connecting the provider to this signed-in account (Profile), instead of signing in
    link_user uuid REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

-- how each session signed in: 'password', 'totp', 'recovery', 'sso', ... (SSO sessions skip Kanb's own 2FA rules:
-- the provider handles that)
ALTER TABLE sessions ADD COLUMN method text NOT NULL DEFAULT 'password';
