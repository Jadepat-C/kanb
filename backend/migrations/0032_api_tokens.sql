-- Personal API tokens (Profile → API tokens): scripts call the API as their owner with
-- "Authorization: Bearer kanb_…". Only a hash is stored; the token is shown once.
CREATE TABLE api_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    -- the first characters, so people can tell their tokens apart (and match one found in a log)
    prefix text NOT NULL,
    -- 'read': GET only; 'write': everything the owner may do, except account security
    scope text NOT NULL CHECK (scope IN ('read', 'write')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    expires_at timestamptz
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);
