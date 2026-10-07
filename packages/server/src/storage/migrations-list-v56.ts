/** 外部 agent 的权限受限密钥与幂等回执；不改已有词条/复习字段。 */
export const MIGRATIONS_V56 = [{ version: 56, statements: [
  `CREATE TABLE IF NOT EXISTS agent_term_key (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    last_used_at INTEGER, revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_term_key_owner ON agent_term_key(owner_id)`,
  `CREATE TABLE IF NOT EXISTS agent_term_receipt (
    owner_id TEXT NOT NULL, batch_id TEXT NOT NULL, key_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL, response_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(owner_id,batch_id)
  )`,
] }];
