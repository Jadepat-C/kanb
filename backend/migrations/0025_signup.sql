-- Self sign-up (ALLOW_SIGNUP=true). An account that signed up itself waits here until it can be used:
--   'email'  = must click the link in the confirmation email first (only when the server can send email)
--   'review' = waiting for an admin to approve it
-- NULL = a normal account. Accounts in either state are inactive and never shown in the normal user list.
ALTER TABLE users
    ADD COLUMN signup text CHECK (signup IN ('email', 'review')),
    ADD COLUMN signed_up_at timestamptz;
CREATE INDEX users_signup_idx ON users (signed_up_at) WHERE signup IS NOT NULL;

-- Notifications that aren't about a board (e.g. "sign-ups waiting for approval" for admins).
ALTER TABLE notifications ALTER COLUMN board_id DROP NOT NULL;
