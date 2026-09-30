/**
 * v52（2026-09-30 活跃心跳：`user_activity_day`，契约 docs/RETENTION-SPEC.md §2）
 *
 * 一行 = 「这个用户在这一天打开过应用」。这是 `docs/metrics-product.md` §3 登记的那笔欠账——
 * L3（留存）挂起的唯一机制性原因是「产品内没有『谁在什么时候来过』的事件流」，空库与没人用不可区分。
 *
 * - 粒度刻意只到**天**：`(user_id, day)` 主键 + `INSERT OR IGNORE` ⇒ 每用户每天最多一行、写入幂等，
 *   多实例各写一次也只留一行；不记 IP / UA / 路径（留存只需要「来没来」，不需要「干了什么」）。
 * - `day` 用与 `growth_action_day` 同一把 `localDayKey`（服务器本地日），两张表口径一致。
 * - 「干了什么」另有事实源：`messages`（对话）、`term_review_log`（复习）、`pk_*`（对战）——
 *   报表 `tools/retention-report.mjs` 把「打开」与「用过」分开算，能区分「来了不用」与「没人来」。
 * ★ 新表 + CREATE IF NOT EXISTS（不 ALTER 旧表，理由同 v47–v51）。
 */
export const MIGRATIONS_V52: Array<{ version: number; statements: string[] }> = [
  {
    version: 52,
    statements: [
      `CREATE TABLE IF NOT EXISTS user_activity_day (
        user_id       TEXT NOT NULL,
        day           TEXT NOT NULL,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, day)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_activity_day_day ON user_activity_day(day)`,
    ],
  },
];
