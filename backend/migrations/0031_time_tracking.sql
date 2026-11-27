-- Time tracking: an estimate per card, and time logged against it (a running timer, or entered by hand).
ALTER TABLE cards ADD COLUMN estimate_minutes int CHECK (estimate_minutes >= 0);

CREATE TABLE time_entries (
    id uuid PRIMARY KEY,
    card_id uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL,
    -- NULL: the timer is still running
    ended_at timestamptz,
    -- for finished entries (a running one counts from started_at)
    minutes int NOT NULL DEFAULT 0 CHECK (minutes >= 0),
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_entries_card ON time_entries (card_id);
CREATE INDEX time_entries_board ON time_entries (board_id, started_at);
-- one running timer per person
CREATE UNIQUE INDEX time_entries_running ON time_entries (user_id) WHERE ended_at IS NULL;

-- New permission "time.log": every role that may edit cards gets it.
UPDATE board_roles SET permissions = array_append(permissions, 'time.log')
WHERE 'cards.edit' = ANY(permissions) AND NOT ('time.log' = ANY(permissions));
