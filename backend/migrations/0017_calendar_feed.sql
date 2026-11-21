-- Private iCalendar feed per user (subscribe in Google/Outlook/Apple Calendar). Only the hash is stored.
ALTER TABLE users ADD COLUMN calendar_token_hash text UNIQUE;
