-- Postgres twin of migrations/0010_identities.sql.
-- INTEGER -> bigint (epoch-millisecond timestamps stay integers, as the app writes them).

create table user_identities (
  provider text NOT NULL,
  subject text NOT NULL,
  user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  last_used_at bigint,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX user_identities_user ON user_identities (user_id);
