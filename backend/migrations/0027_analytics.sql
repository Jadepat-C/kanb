-- Board analytics.
-- 1. New permission "analytics.view": Owner roles and Admin-like roles (those that may manage roles) get it.
UPDATE board_roles SET permissions = array_append(permissions, 'analytics.view')
WHERE (is_owner OR 'roles.manage' = ANY(permissions)) AND NOT ('analytics.view' = ANY(permissions));

-- 2. Cards per column, once a day (the "cumulative flow" chart). Card moves only record column names, which change
--    when a column is renamed, so the past can't be rebuilt reliably: this history starts with this version.
CREATE TABLE board_daily_columns (
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    day      date NOT NULL,
    list_id  uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    cards    int  NOT NULL,
    PRIMARY KEY (board_id, day, list_id)
);
