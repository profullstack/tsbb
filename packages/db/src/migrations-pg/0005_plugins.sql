-- Postgres twin of migrations/0005_plugins.sql (generated with `libsql-pg convert-schema`, then reviewed).
-- INTEGER -> bigint (0/1 flags and epoch-millisecond timestamps stay integers, as the app writes them);
-- INTEGER PRIMARY KEY AUTOINCREMENT -> identity; BLOB -> bytea.

create table plugins (
  slug text PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  source text NOT NULL DEFAULT 'bundled',
  entry text,
  enabled bigint NOT NULL DEFAULT 0,
  config text NOT NULL DEFAULT '{}',
  installed_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  last_error text
);

create table plugin_migrations (
  plugin_slug text NOT NULL,
  name text NOT NULL,
  applied_at bigint NOT NULL,
  PRIMARY KEY (plugin_slug, name)
);

create table plugin_data (
  plugin_slug text NOT NULL,
  "key" text NOT NULL,
  value text NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (plugin_slug, key)
);
