/**
 * sources/store —— 资料架落库 / 读回（契约 docs/SOURCE-TRACE-SPEC.md §7；表见 migrations-list-v51）。
 *
 * 写：`persistRounds` 在**同一事务**里插最终回答行与资料行——回答落了资料没落（或反过来）都不该发生。
 * 读：`GET /api/sessions/:id/messages` 把资料按 message_id 挂回每条回答；reader 端点用 `sourceKnownInSession`
 *     判「这网址是不是这个会话架上的」——它是 `/api/sources/view` 的许可来源之一（另一来源是在线架）。
 */
import type Database from 'better-sqlite3';
import type { SourceItem } from '@sb/shared';

interface Row {
  message_id: string;
  n: number;
  url: string;
  title: string;
  site: string;
  kind: SourceItem['kind'];
  origin: SourceItem['origin'];
  snippet: string | null;
  why: string | null;
  query: string | null;
}

/** 在**调用方的事务里**写入一条回答的资料行（本函数不自开事务） */
export function insertMessageSources(db: Database.Database, sessionId: string, messageId: string, items: readonly SourceItem[]): void {
  if (items.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO message_source (session_id, message_id, n, url, title, site, kind, origin, snippet, why, query)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of items) {
    stmt.run(sessionId, messageId, s.n, s.url, s.title, s.site, s.kind, s.origin, s.snippet ?? null, s.why ?? null, s.query ?? null);
  }
}

function rowToItem(r: Row): SourceItem {
  return {
    n: r.n,
    url: r.url,
    title: r.title,
    site: r.site,
    kind: r.kind,
    origin: r.origin,
    ...(r.snippet ? { snippet: r.snippet } : {}),
    ...(r.why ? { why: r.why } : {}),
    ...(r.query ? { query: r.query } : {}),
  };
}

/** 一个会话里每条回答挂的资料：message_id → 编号序条目 */
export function loadSessionSources(db: Database.Database, sessionId: string): Record<string, SourceItem[]> {
  const rows = db
    .prepare(
      `SELECT message_id, n, url, title, site, kind, origin, snippet, why, query FROM message_source WHERE session_id = ? ORDER BY message_id, n`,
    )
    .all(sessionId) as Row[];
  const out: Record<string, SourceItem[]> = {};
  for (const r of rows) (out[r.message_id] ??= []).push(rowToItem(r));
  return out;
}

/** 该会话（已落库的）架上是否有这个网址——reader 端点许可 */
export function sourceKnownInSession(db: Database.Database, sessionId: string, url: string): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM message_source WHERE session_id = ? AND url = ? LIMIT 1`).get(sessionId, url);
  return Boolean(row);
}
