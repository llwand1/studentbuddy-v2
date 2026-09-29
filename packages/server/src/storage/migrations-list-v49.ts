/**
 * v49（2026-09-29 AI 深度 Step 4：个人化 FSRS + 对战题预生成）
 *
 * - `fsrs_user_param`：每个用户一行的稳定性缩放 k（`@sb/shared` fsrs-fit.ts 头注）。读侧
 *   `SELECT_REVIEW_COLS` 用子查询取它，没有这一行 ⇒ k=1（与默认模型逐字相同）。
 * - `pk_question_pool`：对战 AI 的预生成题（已过盲解验算的单选），按主题取用、用过即标记。
 * ★ 两张都是新表 + `CREATE IF NOT EXISTS`：不碰已有表的列（ALTER ADD COLUMN 会撞 db.test 的迁移重放）。
 */
export const MIGRATIONS_V49: Array<{ version: number; statements: string[] }> = [
  {
    version: 49,
    statements: [
      `CREATE TABLE IF NOT EXISTS fsrs_user_param (
        owner_id      TEXT PRIMARY KEY,
        scale         REAL NOT NULL,
        n             INTEGER NOT NULL,
        loss_default  REAL NOT NULL,
        loss_fitted   REAL NOT NULL,
        fitted_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS pk_question_pool (
        id          TEXT PRIMARY KEY,
        topic       TEXT NOT NULL,
        stem        TEXT NOT NULL,
        question    TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        used_at     TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pk_pool_topic ON pk_question_pool(topic, used_at)`,
    ],
  },
];
