-- "Counts as done" statuses, and when a card was finished.
ALTER TABLE board_statuses ADD COLUMN is_done boolean NOT NULL DEFAULT false;
ALTER TABLE cards ADD COLUMN done_at timestamptz;

-- statuses that are obviously "done" by name start out marked
UPDATE board_statuses SET is_done = true
WHERE lower(trim(name)) IN ('done', 'completed', 'complete', 'finished', 'closed', 'เสร็จ', 'เสร็จแล้ว', 'เสร็จสิ้น');
UPDATE cards c SET done_at = c.updated_at FROM board_statuses s WHERE s.id = c.status_id AND s.is_done;
