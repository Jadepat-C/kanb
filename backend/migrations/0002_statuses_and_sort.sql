-- Per-board customizable card statuses (replaces the fixed normal/blocked/ready).

CREATE TABLE board_statuses (
    id       uuid PRIMARY KEY,
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name     text NOT NULL,
    color    text NOT NULL,
    position integer NOT NULL DEFAULT 0
);
CREATE INDEX board_statuses_board_idx ON board_statuses (board_id);

INSERT INTO board_statuses (id, board_id, name, color, position)
SELECT gen_random_uuid(), b.id, v.name, v.color, v.pos
FROM boards b
CROSS JOIN (VALUES ('Normal', '#a1a1aa', 0), ('Blocked', '#ef4444', 1), ('Ready', '#22c55e', 2)) AS v(name, color, pos);

ALTER TABLE cards ADD COLUMN status_id uuid REFERENCES board_statuses(id) ON DELETE SET NULL;

UPDATE cards c SET status_id = s.id
FROM board_statuses s
WHERE s.board_id = c.board_id
  AND s.name = CASE c.status WHEN 'blocked' THEN 'Blocked' WHEN 'ready' THEN 'Ready' ELSE 'Normal' END;

ALTER TABLE cards DROP COLUMN status;
