-- Who may start a conversation in a forum, beyond what group permissions say.
--   'topics'  members may start topics and reply (the default, and what every
--             forum was before this column existed)
--   'replies' members may reply to what is there but not start topics — the
--             shape of a news forum that a feed fills and people discuss
--   'none'    members may only read; only feeds and staff write here
-- It is a policy on the forum rather than a permission row per group, so it
-- survives a board's groups being reorganised.
ALTER TABLE forums ADD COLUMN member_posting TEXT NOT NULL DEFAULT 'topics';

-- An RSS or Atom feed that fills a forum with topics. Fetch state lives on the
-- row so the worker can pick the next due source with one query, and so the
-- admin page can show what happened last without a log table.
CREATE TABLE feed_sources (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  forum_id         INTEGER NOT NULL REFERENCES forums (id) ON DELETE CASCADE,
  -- The account the topics are posted as. SET NULL rather than CASCADE: a
  -- deleted account pauses the feed, it does not silently delete the feed.
  user_id          INTEGER REFERENCES users (id) ON DELETE SET NULL,
  url              TEXT NOT NULL,
  title            TEXT,
  is_enabled       INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  max_items        INTEGER NOT NULL DEFAULT 10,
  etag             TEXT,
  last_modified    TEXT,
  fetched_at       INTEGER,
  next_fetch_at    INTEGER,
  -- last_status: 'ok' | 'unchanged' | 'error', with last_error explaining the last one.
  last_status      TEXT,
  last_error       TEXT,
  item_count       INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX feed_sources_forum ON feed_sources (forum_id, id);
CREATE INDEX feed_sources_due ON feed_sources (is_enabled, next_fetch_at);

-- Every item a source has ever shown us, keyed by its guid, so a feed that
-- republishes or reorders its items never posts the same story twice. An item
-- with no topic was seen but not posted (older than the first-fetch cap).
CREATE TABLE feed_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER NOT NULL REFERENCES feed_sources (id) ON DELETE CASCADE,
  guid         TEXT NOT NULL,
  topic_id     INTEGER REFERENCES topics (id) ON DELETE SET NULL,
  link         TEXT,
  published_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX feed_items_guid ON feed_items (source_id, guid);
CREATE INDEX feed_items_topic ON feed_items (topic_id);
