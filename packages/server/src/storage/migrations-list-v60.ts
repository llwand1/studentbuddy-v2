/** Independent rounds preserve drafts, thinking and per-question analysis without overwriting earlier submissions. */
export const MIGRATIONS_V60 = [{ version: 60, statements: [
  `CREATE TABLE IF NOT EXISTS quiz_round (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL DEFAULT '', quiz_key TEXT NOT NULL, quiz_id TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, title TEXT NOT NULL, origin TEXT NOT NULL,
    round_number INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','submitted')), revision INTEGER NOT NULL DEFAULT 0,
    questions_json TEXT NOT NULL, created_at TEXT NOT NULL, submitted_at TEXT,
    UNIQUE(owner_id, quiz_key, round_number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_quiz_round_owner_key ON quiz_round(owner_id, quiz_key, round_number DESC)`,
  `CREATE TABLE IF NOT EXISTS quiz_response (
    round_id TEXT NOT NULL REFERENCES quiz_round(id) ON DELETE CASCADE, question_index INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, draft_json TEXT NOT NULL, thought TEXT NOT NULL DEFAULT '',
    result_json TEXT, grade_json TEXT, review_status TEXT NOT NULL DEFAULT 'none', generation INTEGER NOT NULL DEFAULT 0,
    analysis TEXT NOT NULL DEFAULT '', analysis_ready INTEGER NOT NULL DEFAULT 0, illustration_json TEXT, error TEXT NOT NULL DEFAULT '', recorded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(round_id, question_index)
  )`,
] }];
