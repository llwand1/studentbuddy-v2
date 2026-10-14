export const MIGRATIONS_V61 = [{ version: 61, statements: [
  `CREATE TABLE IF NOT EXISTS desktop_run (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, parent_id TEXT, session_id TEXT,
    kind TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL DEFAULT '',
    capability TEXT NOT NULL DEFAULT 'read_only', status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '', tasks TEXT NOT NULL DEFAULT '[]', result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS desktop_run_owner ON desktop_run(owner_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS desktop_run_parent ON desktop_run(parent_id)`,
  `CREATE TABLE IF NOT EXISTS desktop_run_event(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, owner_id TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS desktop_run_event_run ON desktop_run_event(run_id, id)`,
  `CREATE TABLE IF NOT EXISTS desktop_file_approval (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, run_id TEXT, path TEXT NOT NULL, operation TEXT NOT NULL,
    reason TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS desktop_approval_owner ON desktop_file_approval(owner_id, status, expires_at)`,
] }];
