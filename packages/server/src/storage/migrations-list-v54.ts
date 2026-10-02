/**
 * v54（2026-10-02 番茄钟流水：`pomodoro_log`，契约 docs/POMODORO-SPEC.md §10）
 *
 * 一行 = 「这个人完成了一个工作段」。此前番茄钟只存**当前状态**（`app_settings` 键 `pomodoro`），结束即清——
 * 于是「今天专注了几轮 / 这周哪个方向最多」无从得知，而督促小窗的学习可视化恰恰要回答这类问题。
 * - 只记**完成**的工作段（翻到休息 / 再来一轮 / 提前休息都算完成；中途「结束番茄钟」的那半轮不记）。
 * - `day` 用与 `growth_action_day` / `user_activity_day` 同一把 `localDayKey`（服务器本地日）。
 * - `owner_id` 与 `app_settings` 同口径：`''` ＝ 本地单人无主行。
 * ★ 新表 + CREATE IF NOT EXISTS（不 ALTER 旧表，理由同 v47–v53）。
 */
export const MIGRATIONS_V54: Array<{ version: number; statements: string[] }> = [
  {
    version: 54,
    statements: [
      `CREATE TABLE IF NOT EXISTS pomodoro_log (
        id        TEXT PRIMARY KEY,
        owner_id  TEXT NOT NULL DEFAULT '',
        subject   TEXT NOT NULL,
        work_min  INTEGER NOT NULL,
        round     INTEGER NOT NULL,
        day       TEXT NOT NULL,
        ended_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pomodoro_log_owner_day ON pomodoro_log(owner_id, day)`,
    ],
  },
];
