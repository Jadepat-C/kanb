-- Recurring cards: a card template created in a column on a schedule.
CREATE TABLE card_recurrences (
    id           uuid PRIMARY KEY,
    board_id     uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    template_id  uuid NOT NULL REFERENCES card_templates(id) ON DELETE CASCADE,
    list_id      uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    freq         text NOT NULL,                       -- daily | weekly | monthly
    every        integer NOT NULL DEFAULT 1,          -- every N days / weeks / months
    weekdays     smallint[] NOT NULL DEFAULT '{}',    -- weekly: 1 = Monday … 7 = Sunday
    month_day    smallint,                            -- monthly: 1–31 (31 = last day of shorter months)
    at_time      time NOT NULL DEFAULT '09:00',       -- server-local time
    anchor       date NOT NULL,                       -- counting "every N" starts here
    assignee_ids uuid[] NOT NULL DEFAULT '{}',
    enabled      boolean NOT NULL DEFAULT true,
    next_run_at  timestamptz,
    last_run_at  timestamptz,
    last_card_id uuid REFERENCES cards(id) ON DELETE SET NULL,
    created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX card_recurrences_due_idx ON card_recurrences (next_run_at) WHERE enabled;
