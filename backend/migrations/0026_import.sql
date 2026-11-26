-- Comments brought in by a board import keep their original author's name as text: they weren't written in this
-- Kanb, so they aren't linked to (or editable by) any account here.
ALTER TABLE comments ADD COLUMN imported_author text;

-- When a card arrived by import. Due dates before that are history, not something to remind anyone about.
ALTER TABLE cards ADD COLUMN imported_at timestamptz;
