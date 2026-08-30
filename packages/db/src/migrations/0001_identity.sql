-- Board configuration. One row per key; values are JSON so a setting can grow
-- from a boolean into an object without a migration.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL,
  username_lower TEXT NOT NULL,
  email          TEXT NOT NULL,
  email_lower    TEXT NOT NULL,
  display_name   TEXT,
  -- avatar_kind: 'none' | 'upload' | 'gravatar' | 'identicon'
  avatar_kind    TEXT NOT NULL DEFAULT 'identicon',
  avatar_url     TEXT,
  signature      TEXT,
  title          TEXT,
  location       TEXT,
  website        TEXT,
  bio            TEXT,
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  locale         TEXT NOT NULL DEFAULT 'en',
  post_count     INTEGER NOT NULL DEFAULT 0,
  topic_count    INTEGER NOT NULL DEFAULT 0,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  is_moderator   INTEGER NOT NULL DEFAULT 0,
  is_banned      INTEGER NOT NULL DEFAULT 0,
  banned_until   INTEGER,
  ban_reason     TEXT,
  is_deleted     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER,
  last_post_at   INTEGER
);
CREATE UNIQUE INDEX users_username_lower ON users (username_lower);
CREATE UNIQUE INDEX users_email_lower ON users (email_lower);
CREATE INDEX users_last_seen ON users (last_seen_at DESC);
CREATE INDEX users_post_count ON users (post_count DESC);

-- Per-user preferences, split from `users` because they are read on far fewer
-- paths and change on a different cadence.
CREATE TABLE user_prefs (
  user_id            INTEGER PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  theme              TEXT NOT NULL DEFAULT 'system',
  posts_per_page     INTEGER NOT NULL DEFAULT 20,
  topics_per_page    INTEGER NOT NULL DEFAULT 30,
  show_signatures    INTEGER NOT NULL DEFAULT 1,
  show_avatars       INTEGER NOT NULL DEFAULT 1,
  auto_subscribe     INTEGER NOT NULL DEFAULT 1,
  email_digest       TEXT NOT NULL DEFAULT 'instant',
  accepts_pm         INTEGER NOT NULL DEFAULT 1,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  user_agent   TEXT,
  ip_hash      TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Magic links are the way in from nothing and double as registration: an
-- unknown address makes the account rather than being turned away.
CREATE TABLE magic_links (
  token_hash  TEXT PRIMARY KEY,
  email_lower TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  ip_hash     TEXT,
  redirect_to TEXT
);
CREATE INDEX magic_links_email ON magic_links (email_lower, created_at DESC);

CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  label         TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- Groups carry both display (colour, rank badge) and permission weight.
CREATE TABLE groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  colour      TEXT,
  priority    INTEGER NOT NULL DEFAULT 0,
  is_default  INTEGER NOT NULL DEFAULT 0,
  is_system   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX groups_slug ON groups (slug);

CREATE TABLE group_members (
  group_id   INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_leader  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members (user_id);

-- Ranks are earned by post count, or awarded explicitly (is_special).
CREATE TABLE ranks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  min_posts  INTEGER NOT NULL DEFAULT 0,
  is_special INTEGER NOT NULL DEFAULT 0,
  image_url  TEXT,
  colour     TEXT
);
CREATE INDEX ranks_min_posts ON ranks (min_posts DESC);

-- API tokens back the TUI and any other client of a centralised install.
CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label        TEXT,
  scopes       TEXT NOT NULL DEFAULT 'read',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE UNIQUE INDEX api_tokens_hash ON api_tokens (token_hash);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

-- Device authorisation: a terminal cannot hold a browser session, so the TUI
-- shows a short code, a human approves it in a browser, and the TUI collects a
-- token sealed to a key it generated.
CREATE TABLE device_codes (
  device_code  TEXT PRIMARY KEY,
  user_code    TEXT NOT NULL,
  public_key   TEXT NOT NULL,
  user_id      INTEGER REFERENCES users (id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  approved_at  INTEGER,
  sealed_token TEXT,
  label        TEXT
);
CREATE UNIQUE INDEX device_codes_user_code ON device_codes (user_code);
