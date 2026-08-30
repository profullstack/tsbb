CREATE TABLE reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  handled_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
  handled_at  INTEGER,
  resolution  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX reports_status ON reports (status, created_at DESC);
CREATE INDEX reports_target ON reports (target_type, target_id);

CREATE TABLE mod_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  forum_id    INTEGER REFERENCES forums (id) ON DELETE SET NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX mod_log_recent ON mod_log (created_at DESC);
CREATE INDEX mod_log_target ON mod_log (target_type, target_id);

-- Bans by pattern, for shutting a door before an account exists.
CREATE TABLE ban_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  pattern    TEXT NOT NULL,
  reason     TEXT,
  expires_at INTEGER,
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ban_rules_kind ON ban_rules (kind);

-- Warnings accumulate; the board can act automatically at a threshold.
CREATE TABLE warnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  actor_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  post_id    INTEGER REFERENCES posts (id) ON DELETE SET NULL,
  points     INTEGER NOT NULL DEFAULT 1,
  reason     TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX warnings_user ON warnings (user_id, created_at DESC);

-- Every write records an audit row in the same transaction, so rate limiting
-- can be counted off this table without a second write anywhere.
CREATE TABLE audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  ip_hash     TEXT,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX audit_events_rate ON audit_events (user_id, action, created_at DESC);
CREATE INDEX audit_events_ip ON audit_events (ip_hash, action, created_at DESC);
