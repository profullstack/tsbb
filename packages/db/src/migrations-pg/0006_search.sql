-- Postgres twin of migrations/0006_search.sql, written by hand: FTS5 has no
-- Postgres counterpart. The shape is kept — posts_fts and users_fts stay real
-- tables with the same columns, so the search queries keep their joins — and a
-- generated tsvector column plus a GIN index does what the FTS5 index did.
-- The 'simple' configuration matches FTS5's unicode61 tokenizer: no stemming,
-- case-folded. Title is weighted A and body B, the same ordering bm25(8.0, 1.0)
-- expressed. The triggers are the SQLite ones, one function each.

CREATE TABLE posts_fts (
  post_id    bigint PRIMARY KEY,
  title      text,
  body       text,
  topic_id   bigint,
  forum_id   bigint,
  user_id    bigint,
  created_at bigint,
  tsv        tsvector GENERATED ALWAYS AS (
               setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
               setweight(to_tsvector('simple', coalesce(body, '')), 'B')
             ) STORED
);
CREATE INDEX posts_fts_tsv ON posts_fts USING gin (tsv);
CREATE INDEX posts_fts_topic ON posts_fts (topic_id);
CREATE INDEX posts_fts_forum ON posts_fts (forum_id);

CREATE FUNCTION posts_fts_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO posts_fts (title, body, post_id, topic_id, forum_id, user_id, created_at)
  SELECT (SELECT title FROM topics WHERE id = new.topic_id),
         new.body, new.id, new.topic_id, new.forum_id, new.user_id, new.created_at
  ON CONFLICT (post_id) DO UPDATE SET
    title = excluded.title, body = excluded.body, topic_id = excluded.topic_id,
    forum_id = excluded.forum_id, user_id = excluded.user_id, created_at = excluded.created_at;
  RETURN NULL;
END $$;
CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_fts_insert();

CREATE FUNCTION posts_fts_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE posts_fts SET body = new.body WHERE post_id = new.id;
  RETURN NULL;
END $$;
CREATE TRIGGER posts_fts_update AFTER UPDATE OF body ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_fts_update();

CREATE FUNCTION posts_fts_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM posts_fts WHERE post_id = old.id;
  RETURN NULL;
END $$;
CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts
  FOR EACH ROW EXECUTE FUNCTION posts_fts_delete();

-- Retitling a topic has to move through every one of its indexed posts.
CREATE FUNCTION posts_fts_retitle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE posts_fts SET title = new.title WHERE topic_id = new.id;
  RETURN NULL;
END $$;
CREATE TRIGGER posts_fts_retitle AFTER UPDATE OF title ON topics
  FOR EACH ROW EXECUTE FUNCTION posts_fts_retitle();

-- Users are searchable too, for the mention autocomplete and the memberlist.
CREATE TABLE users_fts (
  user_id      bigint PRIMARY KEY,
  username     text,
  display_name text,
  tsv          tsvector GENERATED ALWAYS AS (
                 to_tsvector('simple', coalesce(username, '') || ' ' || coalesce(display_name, ''))
               ) STORED
);
CREATE INDEX users_fts_tsv ON users_fts USING gin (tsv);

CREATE FUNCTION users_fts_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO users_fts (username, display_name, user_id)
  VALUES (new.username, coalesce(new.display_name, ''), new.id)
  ON CONFLICT (user_id) DO UPDATE SET username = excluded.username, display_name = excluded.display_name;
  RETURN NULL;
END $$;
CREATE TRIGGER users_fts_insert AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION users_fts_insert();

CREATE FUNCTION users_fts_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE users_fts
     SET username = new.username, display_name = coalesce(new.display_name, '')
   WHERE user_id = new.id;
  RETURN NULL;
END $$;
CREATE TRIGGER users_fts_update AFTER UPDATE OF username, display_name ON users
  FOR EACH ROW EXECUTE FUNCTION users_fts_update();

CREATE FUNCTION users_fts_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM users_fts WHERE user_id = old.id;
  RETURN NULL;
END $$;
CREATE TRIGGER users_fts_delete AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION users_fts_delete();
