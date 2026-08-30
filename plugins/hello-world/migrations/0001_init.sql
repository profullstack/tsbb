-- A plugin owns its tables. They are tracked in plugin_migrations rather than
-- the core ledger, so removing the plugin never disturbs the board's own.
CREATE TABLE IF NOT EXISTS hello_greetings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  greeting   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
