export const MIGRATIONS_V62 = [{ version: 62, statements: [
  `CREATE TABLE IF NOT EXISTS plugin_connection (
    owner_id TEXT NOT NULL, plugin_id TEXT NOT NULL, manifest TEXT NOT NULL, token TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0, repositories TEXT NOT NULL DEFAULT '[]',
    tools TEXT NOT NULL DEFAULT '[]', tested_at INTEGER, error TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id, plugin_id)
  )`,
  `CREATE TABLE IF NOT EXISTS plugin_call_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, plugin_id TEXT NOT NULL,
    tool TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL,
    error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS plugin_call_owner ON plugin_call_log(owner_id, id DESC)`,
] }];

