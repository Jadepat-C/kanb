-- Users can sign in with their email, so an email must identify exactly one account (case-insensitive).
UPDATE users SET email = NULL WHERE email IS NOT NULL AND trim(email) = '';
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL;
