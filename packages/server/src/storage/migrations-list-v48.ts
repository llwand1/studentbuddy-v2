/**
 * v48（2026-09-29 AI 深度 Step 3：词条关系图）
 *
 * `term_edge`：词条之间的关系（前置／组成／例子／易混淆／相关），由 AI 后台抽取（任务 `term.relate`）。
 * ★ 无向关系（contrast / related）按 id 字典序存 a<b 一行；`UNIQUE(owner_id, a_id, b_id, relation)`
 *   让重复抽取天然幂等（INSERT OR IGNORE）。
 * ★ 不加外键：词条删除走软删与撤销（`UndoDeleteBar`），外键级联会让"撤销删除"丢掉关系；
 *   读侧一律 JOIN 回 `term_library`，悬空边自然不出现。
 */
export const MIGRATIONS_V48: Array<{ version: number; statements: string[] }> = [
  {
    version: 48,
    statements: [
      `CREATE TABLE IF NOT EXISTS term_edge (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL DEFAULT '',
        a_id        TEXT NOT NULL,
        b_id        TEXT NOT NULL,
        relation    TEXT NOT NULL,
        note        TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(owner_id, a_id, b_id, relation)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_term_edge_a ON term_edge(owner_id, a_id)`,
      `CREATE INDEX IF NOT EXISTS idx_term_edge_b ON term_edge(owner_id, b_id)`,
    ],
  },
];
