-- Postgres twin of migrations/0007_uploads.sql (generated with `libsql-pg convert-schema`, then reviewed).
-- INTEGER -> bigint (0/1 flags and epoch-millisecond timestamps stay integers, as the app writes them);
-- INTEGER PRIMARY KEY AUTOINCREMENT -> identity; BLOB -> bytea.

create table uploads (
  name text PRIMARY KEY,
  mime text NOT NULL,
  bytes bytea NOT NULL,
  size_bytes bigint NOT NULL,
  user_id bigint REFERENCES users (id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'avatar',
  created_at bigint NOT NULL
);

CREATE INDEX uploads_user ON uploads (user_id, created_at DESC);
