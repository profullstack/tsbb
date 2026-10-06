-- Accounts on a host site, linked to accounts here (@profullstack/bridges).
-- The link is the host's id for the person (`subject`), never their email or
-- name: those can change on the host, and an account must not follow them into
-- someone else's. One host account maps to one board account.
CREATE TABLE user_identities (
  provider    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX user_identities_user ON user_identities (user_id);
