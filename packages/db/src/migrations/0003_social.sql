-- Subscriptions drive notification fan-out. target_type: 'forum'|'topic'|'user'
CREATE TABLE subscriptions (
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX subscriptions_target ON subscriptions (target_type, target_id);

-- Ignoring a topic beats a subscription, so auto-subscribe never traps anyone
-- in a thread they have left.
CREATE TABLE ignores (
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE TABLE notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- kind: reply | mention | quote | reaction | pm | solved | moderation |
  --       group_invite | plugin:<slug>
  kind         TEXT NOT NULL,
  actor_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  subject_type TEXT,
  subject_id   INTEGER,
  url          TEXT,
  title        TEXT,
  excerpt      TEXT,
  data         TEXT,
  -- dedupe_key collapses "3 people replied" into one unread row per subject.
  dedupe_key   TEXT,
  read_at      INTEGER,
  emailed_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (user_id, read_at, created_at DESC);
CREATE UNIQUE INDEX notifications_dedupe ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND read_at IS NULL;

-- Per-kind delivery preferences. A missing row means the board default.
CREATE TABLE notification_prefs (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  in_app  INTEGER NOT NULL DEFAULT 1,
  email   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind)
);

-- The mail queue is a table rather than an in-process buffer so a restart
-- cannot lose a send and the worker can be scaled or run on its own.
CREATE TABLE email_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email     TEXT NOT NULL,
  to_user_id   INTEGER REFERENCES users (id) ON DELETE CASCADE,
  subject      TEXT NOT NULL,
  html         TEXT NOT NULL,
  text         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  -- dedupe_key stops a digest being queued twice for the same window.
  dedupe_key   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  scheduled_at INTEGER NOT NULL,
  sent_at      INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX email_queue_due ON email_queue (status, scheduled_at);
CREATE UNIQUE INDEX email_queue_dedupe ON email_queue (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Private messages are conversations with members, not a per-recipient copy of
-- a row, so a group PM is one thread everybody sees.
CREATE TABLE conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject      TEXT NOT NULL,
  created_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  last_message_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX conversations_recent ON conversations (last_message_at DESC);

CREATE TABLE conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_read_at    INTEGER,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  left_at         INTEGER,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members (user_id, is_archived);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users (id) ON DELETE SET NULL,
  body            TEXT NOT NULL,
  body_format     TEXT NOT NULL DEFAULT 'markdown',
  is_deleted      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX messages_conversation ON messages (conversation_id, created_at);

-- Blocking is one-directional and checked before a PM or a mention notifies.
CREATE TABLE blocks (
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);
