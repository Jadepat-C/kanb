-- Profile pictures: stored (re-encoded, 256x256 JPEG) at avatars/<avatar_id> in the object store.
-- A new upload gets a new id, so URLs can be cached forever.
ALTER TABLE users ADD COLUMN avatar_id uuid;
