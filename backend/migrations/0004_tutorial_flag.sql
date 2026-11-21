-- Tutorial ("Getting started") boards are personal: only their members see them in lists, calendars and search,
-- even super admins (who otherwise see every board).
ALTER TABLE boards ADD COLUMN is_tutorial boolean NOT NULL DEFAULT false;

UPDATE boards SET is_tutorial = true
WHERE created_by IS NULL AND name IN ('👋 Getting started', '👋 เริ่มต้นใช้งาน');
