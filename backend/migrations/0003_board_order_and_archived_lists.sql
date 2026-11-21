-- Each user arranges their own Boards page (drag & drop); boards without an entry show first, newest activity first.
CREATE TABLE board_prefs (
    user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    position integer NOT NULL,
    PRIMARY KEY (user_id, board_id)
);

-- Columns can be archived (hidden together with their cards) and restored.
ALTER TABLE lists ADD COLUMN archived_at timestamptz;
