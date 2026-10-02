/**
 * v53（2026-10-02 全站每日调用上限：`platform_call_day`，契约 docs/TENANCY-SPEC.md §8.1.3.4）
 *
 * 一行 = 「平台通道在这一天发起过多少次上游调用」。与 v39 的 `platform_usage` **刻意分家**：
 * 那张表按 `owner_id` 记**每用户**的滚动窗口用量；本表**不分用户**，只记全站当天的总量——
 * 付费 key 上线、每用户上限被 env 取消后，它是唯一还能拦住「批量建号慢慢刷」的成本闸。
 *
 * - `day` 用与 `user_activity_day`（v52）/ `growth_action_day` 同一把 `localDayKey`（服务器本地日），
 *   口径一致：跨时区/DST 也只取「年月日」。
 * - 写入是 UPSERT 自增（`ON CONFLICT(day) DO UPDATE SET calls = calls + 1`），并在**同一事务**里
 *   删掉旧日行（只留当天）⇒ 表恒为 0~1 行，随天数不增长（见 `llm/platform-budget.ts`）。
 * ★ 新表 + CREATE IF NOT EXISTS（不 ALTER 旧表，理由同 v47–v52）；幂等 ⇒ 退版本重放无需 revert。
 */
export const MIGRATIONS_V53: Array<{ version: number; statements: string[] }> = [
  {
    version: 53,
    statements: [
      `CREATE TABLE IF NOT EXISTS platform_call_day (
        day   TEXT PRIMARY KEY,
        calls INTEGER NOT NULL DEFAULT 0
      )`,
    ],
  },
];