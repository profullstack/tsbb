-- The plugin registry. A row exists for every plugin the board has ever seen,
-- so disabling one keeps its configuration for when it comes back.
CREATE TABLE plugins (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'bundled',
  entry        TEXT,
  enabled      INTEGER NOT NULL DEFAULT 0,
  config       TEXT NOT NULL DEFAULT '{}',
  installed_at INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_error   TEXT
);

-- Plugins own their tables. Their migrations are tracked separately so
-- uninstalling one does not disturb the core ledger.
CREATE TABLE plugin_migrations (
  plugin_slug TEXT NOT NULL,
  name        TEXT NOT NULL,
  applied_at  INTEGER NOT NULL,
  PRIMARY KEY (plugin_slug, name)
);

-- Key/value store handed to plugins so a plugin that needs to remember a little
-- does not have to ship a migration for it.
CREATE TABLE plugin_data (
  plugin_slug TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (plugin_slug, key)
);
