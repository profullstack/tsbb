-- Settings sync (@profullstack/synconfig): a member's tsbb settings as one
-- snapshot under a monotonic revision, so `tsbb sync load` on another machine
-- gets the boards they use. The body is the client's JSON, stored opaque; the
-- client's policy keeps tokens out of it. The insert allocates max + 1 under a
-- precondition on max, and the unique index is the backstop. Ten are kept.
CREATE TABLE settings_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  host        TEXT,
  version     TEXT,
  size        INTEGER NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (user_id, revision)
);

CREATE INDEX settings_snapshots_user ON settings_snapshots (user_id, revision DESC);
