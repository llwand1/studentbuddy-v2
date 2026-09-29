/**
 * v47（2026-09-29 AI 深度 Step 2：FSRS 记忆模型 + 评分误区）
 *
 * ① `term_fsrs`：每个词条的 FSRS 状态（term_id 主键）。**没有行 ＝ 还没用 FSRS 复习过**——老词条
 *    不批量回填，第一次在新版里复习时才按旧阶段折算起点（`fsrsFromLegacy`），免得一次迁移把几百条
 *    词条的下次复习日全部改掉、第二天突然冒出一大堆到期。
 * ② `term_review_fsrs`：每次复习的评分（1–4）、复习**后**的 S/D、复习**时**的预测可提取度 R，
 *    按 `log_id` 挂在 `term_review_log` 那一行上。R 是校准的原料：「预测还记得 85%」的那批复习里
 *    实际记住了多少——这决定默认参数对这个人准不准，也是以后按人拟合参数的训练数据。
 *    ★ 为什么是旁表而不是给老表加列：`ALTER TABLE ADD COLUMN` 不幂等，`db.test.ts` 那十几条
 *      「退版本重放迁移链」的锁会撞 duplicate column；而 `term_library` 在 v31 被整表重建过，
 *      加列还得同步改那边的列清单。旁表 `CREATE IF NOT EXISTS` 天然可重放。
 * ③ `learner_misconception`：AI 评分诊断出的误区。同一 (owner, term/topic, note) 再犯只 +1，
 *    答对同一词条的题会把它标成已解决（`resolved_at`），学习者模型只列未解决的。
 */
export const MIGRATIONS_V47: Array<{ version: number; statements: string[] }> = [
  {
    version: 47,
    statements: [
      `CREATE TABLE IF NOT EXISTS term_fsrs (
        term_id     TEXT PRIMARY KEY,
        stability   REAL NOT NULL,
        difficulty  REAL NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS term_review_fsrs (
        log_id          TEXT PRIMARY KEY,
        term_id         TEXT NOT NULL,
        grade           INTEGER NOT NULL,
        stability       REAL,
        difficulty      REAL,
        retrievability  REAL,
        reviewed_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_term_review_fsrs_term ON term_review_fsrs(term_id)`,
      `CREATE TABLE IF NOT EXISTS learner_misconception (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT,
        term_id     TEXT,
        topic       TEXT NOT NULL DEFAULT '',
        note        TEXT NOT NULL,
        count       INTEGER NOT NULL DEFAULT 1,
        first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_misconception_owner ON learner_misconception(owner_id, resolved_at, last_seen)`,
      `CREATE INDEX IF NOT EXISTS idx_misconception_term ON learner_misconception(term_id)`,
    ],
  },
];
