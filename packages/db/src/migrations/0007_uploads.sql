-- Uploaded files live in the database rather than on a disk.
--
-- Avatars are capped at 512KB by default, which is nothing next to what libSQL
-- will carry in a single bound argument, and keeping them here removes an
-- entire class of deployment problem: no volume to provision, no volume to
-- forget, no uploads lost on the next redeploy, and no single-replica pin
-- (a volume attaches to one service and holds it to one writer).
--
-- This is the right trade at avatar scale. A board serving large attachments
-- should put those behind object storage instead; `attachments.storage_key`
-- already exists for exactly that.
CREATE TABLE uploads (
  name       TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,
  user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  kind       TEXT NOT NULL DEFAULT 'avatar',
  created_at INTEGER NOT NULL
);
CREATE INDEX uploads_user ON uploads (user_id, created_at DESC);
