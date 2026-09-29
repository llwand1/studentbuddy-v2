/**
 * v51（2026-09-30 资料溯源：`message_source`，契约 docs/SOURCE-TRACE-SPEC.md §7）
 *
 * 一条回答挂的资料架：AI 联网时搜到 / 读过 / 精选的网址，按全轮编号落库。
 * 重开会话时消息脚注显示「资料 n 条」、正文 `[n]` 引用能点回右侧面板——没有这张表，
 * 资料架就只活在一次 SSE 里，刷新即丢。
 *
 * - `message_id` 外键 **ON DELETE CASCADE**：重新生成 / 编辑重发会 `DELETE FROM messages`，
 *   资料行跟着走（`db.ts` 已开 `foreign_keys = ON`），不留孤儿。会话是软删，行原样留着、由归属断言挡访问。
 * - `(session_id, message_id, n)` 唯一：同一条回答里编号不重复——这是正文 `[n]` 能唯一定位的前提。
 * ★ 新表 + CREATE IF NOT EXISTS（不 ALTER 旧表，理由同 v47–v50）。
 */
export const MIGRATIONS_V51: Array<{ version: number; statements: string[] }> = [
  {
    version: 51,
    statements: [
      `CREATE TABLE IF NOT EXISTS message_source (
        session_id  TEXT NOT NULL,
        message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        n           INTEGER NOT NULL,
        url         TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        site        TEXT NOT NULL DEFAULT '',
        kind        TEXT NOT NULL DEFAULT 'page',
        origin      TEXT NOT NULL DEFAULT 'search',
        snippet     TEXT,
        why         TEXT,
        query       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, message_id, n)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_message_source_url ON message_source(session_id, url)`,
    ],
  },
];
