/** Derived exercises belong to their source reply; editing/deleting that reply removes its cache. */
export const MIGRATIONS_V57 = [{ version: 57, statements: [
  `CREATE TABLE IF NOT EXISTS reply_practice (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL, title TEXT NOT NULL, quiz_json TEXT NOT NULL
  )`,
] }];
