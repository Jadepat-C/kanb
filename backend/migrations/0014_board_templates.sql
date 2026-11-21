-- Board templates: blueprints for new boards (columns, statuses, labels, card templates, optionally cards).
-- Shared across the organization; anyone who can create boards can make them.
CREATE TABLE board_templates (
    id          uuid PRIMARY KEY,
    name        text NOT NULL,
    description text NOT NULL DEFAULT '',
    color       text NOT NULL DEFAULT '#6366f1',
    data        jsonb NOT NULL DEFAULT '{}',
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
