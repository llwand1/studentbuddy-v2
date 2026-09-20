/**
 * routes/search — 全站搜索端点（契约 `docs/FTS-SPEC.md` §3.4）。
 *
 * ⚠️ 与 `routes.ts` 里的 `/api/settings/search-keys`、`/api/settings/search/test` **不是一回事**：
 *    那两条管的是**联网搜索**（`search_web` 工具的 key 与连通性自检），本路由查的是
 *    **本地库全文检索**。刻意不混进 `settingsRouter`——一个改配置、一个读数据，
 *    挂在一起会让「搜索」这个词在本仓彻底失去指代（FTS-SPEC §3.1 的归属表）。
 *
 * 本文件是**薄路由**（ADR-3）：只做参数解析与钳制，SQL 全在 `search/fts-index.ts`。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { FTS_KINDS, FTS_MAX_QUERY_CHARS, FTS_TOP_K, type FtsKind } from '@sb/shared';
import { searchAll } from '../search/fts-index.js';
import { ownerIdOf } from '../auth/ownership.js';

export const searchRouter = Router();

/**
 * 只认 `string` 的查询参数。
 *
 * ★ 不写 `String(req.query.q ?? '')`：Express 的 `req.query` 在 `?q[]=a&q[]=b` 这种
 *   数组形态下会给出**数组**，`String([...])` 会把它拼成 `"a,b"` 悄悄当成一个查询串
 *   （行为不可预期且不报错）。显式判类型，非字符串一律当"没传"。
 */
function strParam(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

searchRouter.get('/', (req: Request, res: Response) => {
  // 截断在分词**之前**：bigram 会让词元数随字数线性膨胀（n 字 → n-1 个词元），
  // 不设闸等于让一个超长粘贴件构造出成千上万个 MATCH 词元。
  const q = strParam(req.query.q).slice(0, FTS_MAX_QUERY_CHARS).trim();
  // 空查询直接返回空结果，**不落库不报错**：前端搜索框清空是常态操作，不是错误。
  if (!q) {
    res.json({ q: '', hits: [] });
    return;
  }
  // kinds 是**白名单过滤**不是直接透传：未知值静默丢弃（多传一个不认识的 kind
  // 不该让整个请求 400——前端版本比服务端新时那条链路会直接断掉）。
  const asked = strParam(req.query.kinds)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const kinds = asked.filter((k): k is FtsKind => (FTS_KINDS as readonly string[]).includes(k));
  const rawLimit = Number(strParam(req.query.limit));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : FTS_TOP_K;
  // 归属与可见性判据全在 searchAll 内（含未登录模式的分档 WHERE，见该函数头注）
  res.json({ q, hits: searchAll(q, { kinds, ownerId: ownerIdOf(req), limit }) });
});
