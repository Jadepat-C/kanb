-- New look: the default colour for new users, boards and board templates is the app's marker blue.
-- Existing rows keep the colours they already have.
ALTER TABLE users ALTER COLUMN avatar_color SET DEFAULT '#2f5bd3';
ALTER TABLE boards ALTER COLUMN color SET DEFAULT '#2f5bd3';
ALTER TABLE board_templates ALTER COLUMN color SET DEFAULT '#2f5bd3';
