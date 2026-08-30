-- Full-text search over post bodies plus the topic title they belong to.
-- Content is duplicated into the index rather than using an external-content
-- table: posts are edited rarely and read constantly, and a contentless index
-- cannot rank a title and a body differently.
CREATE VIRTUAL TABLE posts_fts USING fts5 (
  title,
  body,
  post_id UNINDEXED,
  topic_id UNINDEXED,
  forum_id UNINDEXED,
  user_id UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Triggers keep the index honest for the ordinary write paths. A rebuild
-- command exists for bulk imports, which skip these deliberately.
CREATE TRIGGER posts_fts_insert AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts (title, body, post_id, topic_id, forum_id, user_id, created_at)
  SELECT (SELECT title FROM topics WHERE id = new.topic_id),
         new.body, new.id, new.topic_id, new.forum_id, new.user_id, new.created_at;
END;

CREATE TRIGGER posts_fts_update AFTER UPDATE OF body ON posts BEGIN
  UPDATE posts_fts SET body = new.body WHERE post_id = new.id;
END;

CREATE TRIGGER posts_fts_delete AFTER DELETE ON posts BEGIN
  DELETE FROM posts_fts WHERE post_id = old.id;
END;

-- Retitling a topic has to move through every one of its indexed posts.
CREATE TRIGGER posts_fts_retitle AFTER UPDATE OF title ON topics BEGIN
  UPDATE posts_fts SET title = new.title WHERE topic_id = new.id;
END;

-- Users are searchable too, for the mention autocomplete and the memberlist.
CREATE VIRTUAL TABLE users_fts USING fts5 (
  username,
  display_name,
  user_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER users_fts_insert AFTER INSERT ON users BEGIN
  INSERT INTO users_fts (username, display_name, user_id)
  VALUES (new.username, coalesce(new.display_name, ''), new.id);
END;

CREATE TRIGGER users_fts_update AFTER UPDATE OF username, display_name ON users BEGIN
  UPDATE users_fts
     SET username = new.username, display_name = coalesce(new.display_name, '')
   WHERE user_id = new.id;
END;

CREATE TRIGGER users_fts_delete AFTER DELETE ON users BEGIN
  DELETE FROM users_fts WHERE user_id = old.id;
END;
