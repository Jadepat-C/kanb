-- Gantt: a start date next to the due date, and "finish-to-start" dependencies between cards of one board.
ALTER TABLE cards ADD COLUMN start_at timestamptz;

CREATE TABLE card_dependencies (
    card_id    uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,   -- this card …
    depends_on uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,   -- … waits for this one to finish
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (card_id, depends_on),
    CHECK (card_id <> depends_on)
);
CREATE INDEX card_dependencies_depends_on_idx ON card_dependencies (depends_on);

-- whoever could edit cards may also link them
UPDATE board_roles SET permissions = permissions || ARRAY['cards.dependencies']
WHERE 'cards.edit' = ANY(permissions) AND NOT 'cards.dependencies' = ANY(permissions);
