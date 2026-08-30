-- A single tree rather than separate category and forum tables: a category is
-- just a node whose kind is 'category', which lets a board nest as deep as it
-- likes without a second schema.
CREATE TABLE forums (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id     INTEGER REFERENCES forums (id) ON DELETE CASCADE,
  -- kind: 'category' | 'forum' | 'link'
  kind          TEXT NOT NULL DEFAULT 'forum',
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  link_url      TEXT,
  icon          TEXT,
  colour        TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  is_locked     INTEGER NOT NULL DEFAULT 0,
  is_hidden     INTEGER NOT NULL DEFAULT 0,
  topic_count   INTEGER NOT NULL DEFAULT 0,
  post_count    INTEGER NOT NULL DEFAULT 0,
  last_post_id  INTEGER,
  last_post_at  INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX forums_slug ON forums (slug);
CREATE INDEX forums_parent ON forums (parent_id, position);

-- Permissions are per (forum, group). A NULL forum_id row is the board-wide
-- default that a per-forum row overrides. Every column is a tri-state:
-- 1 allow, 0 deny, NULL inherit.
CREATE TABLE forum_permissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  forum_id      INTEGER REFERENCES forums (id) ON DELETE CASCADE,
  group_id      INTEGER NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  can_view      INTEGER,
  can_read      INTEGER,
  can_post      INTEGER,
  can_reply     INTEGER,
  can_edit_own  INTEGER,
  can_delete_own INTEGER,
  can_attach    INTEGER,
  can_poll      INTEGER,
  can_moderate  INTEGER
);
CREATE UNIQUE INDEX forum_permissions_pair ON forum_permissions (forum_id, group_id);

CREATE TABLE topics (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  forum_id       INTEGER NOT NULL REFERENCES forums (id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users (id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  slug           TEXT NOT NULL,
  -- kind: 'normal' | 'sticky' | 'announcement' | 'global'
  kind           TEXT NOT NULL DEFAULT 'normal',
  is_locked      INTEGER NOT NULL DEFAULT 0,
  is_hidden      INTEGER NOT NULL DEFAULT 0,
  is_deleted     INTEGER NOT NULL DEFAULT 0,
  is_solved      INTEGER NOT NULL DEFAULT 0,
  solved_post_id INTEGER,
  view_count     INTEGER NOT NULL DEFAULT 0,
  reply_count    INTEGER NOT NULL DEFAULT 0,
  first_post_id  INTEGER,
  last_post_id   INTEGER,
  last_post_at   INTEGER,
  last_poster_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  moved_to_id    INTEGER REFERENCES topics (id) ON DELETE SET NULL,
  bumped_at      INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX topics_forum_recent ON topics (forum_id, kind DESC, bumped_at DESC);
CREATE INDEX topics_user ON topics (user_id, created_at DESC);
CREATE INDEX topics_recent ON topics (bumped_at DESC);
CREATE UNIQUE INDEX topics_forum_slug ON topics (forum_id, slug);

CREATE TABLE posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id    INTEGER NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  forum_id    INTEGER NOT NULL REFERENCES forums (id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
  reply_to_id INTEGER REFERENCES posts (id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  -- body_format: 'markdown' | 'bbcode'
  body_format TEXT NOT NULL DEFAULT 'markdown',
  position    INTEGER NOT NULL DEFAULT 0,
  is_hidden   INTEGER NOT NULL DEFAULT 0,
  is_deleted  INTEGER NOT NULL DEFAULT 0,
  edit_count  INTEGER NOT NULL DEFAULT 0,
  edited_at   INTEGER,
  edited_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  edit_reason TEXT,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX posts_topic ON posts (topic_id, position);
CREATE INDEX posts_user ON posts (user_id, created_at DESC);
CREATE INDEX posts_forum_recent ON posts (forum_id, created_at DESC);

CREATE TABLE post_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  body_format TEXT NOT NULL,
  editor_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX post_revisions_post ON post_revisions (post_id, created_at DESC);

CREATE TABLE reactions (
  post_id    INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'like',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id, kind)
);
CREATE INDEX reactions_user ON reactions (user_id, created_at DESC);

-- Read state is per topic. A forum-level marker lets "mark forum read" be one
-- write instead of one per topic; anything older than the marker counts read.
CREATE TABLE topic_reads (
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  topic_id     INTEGER NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  last_post_id INTEGER NOT NULL,
  read_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, topic_id)
);

CREATE TABLE forum_reads (
  user_id  INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  forum_id INTEGER NOT NULL REFERENCES forums (id) ON DELETE CASCADE,
  read_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, forum_id)
);

CREATE TABLE polls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id      INTEGER NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  question      TEXT NOT NULL,
  max_choices   INTEGER NOT NULL DEFAULT 1,
  change_vote   INTEGER NOT NULL DEFAULT 1,
  hide_results  INTEGER NOT NULL DEFAULT 0,
  closes_at     INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX polls_topic ON polls (topic_id);

CREATE TABLE poll_options (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id  INTEGER NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
  label    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX poll_options_poll ON poll_options (poll_id, position);

CREATE TABLE poll_votes (
  poll_id    INTEGER NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
  option_id  INTEGER NOT NULL REFERENCES poll_options (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, option_id, user_id)
);

CREATE TABLE attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER REFERENCES posts (id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  storage_key  TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  checksum     TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX attachments_post ON attachments (post_id);
CREATE INDEX attachments_user ON attachments (user_id, created_at DESC);
