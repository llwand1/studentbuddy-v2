/**
 * api-search — 全站搜索的 REST 封装（契约 `docs/FTS-SPEC.md` §3.4）。
 *
 * ★ 独立成文件：写进 `api.ts` 会顶破 gates 的「.ts ≤400 行」红线（该文件已 392 行）。
 *   先例是 `api-terms-domain.ts` / `api-study-flow.ts`（同一原因抽出）。
 * ★ 本文件只依赖 `api-request.ts`，**不反向 import `api.ts`**（环断在这里）。
 * ★ 与 `settings.searchKeys`（联网搜索的 key 配置）不是一回事：那条在 `api.ts` 里，
 *   管的是 `search_web` 工具的凭据；本文件查的是**本地库**里的用户数据。
 */
import type { FtsHit, FtsKind } from '@sb/shared';
import { request } from './api-request.js';

/** `GET /api/search` 的响应形状（服务端 `routes/search.ts` 逐字对应）。 */
export interface SearchResponse {
  /** 服务端**截断后**的查询串（前端可据此知道自己的输入被砍过） */
  q: string;
  hits: FtsHit[];
}

export const searchApi = {
  /**
   * 全站检索。
   *
   * ★ `kinds` 与 `limit` 缺省即服务端默认（三类全查、上限 `FTS_TOP_K`）——
   *   前端**不自己截断条数**：截断口径放服务端一处，否则两边迟早不一致。
   * ★ 服务端对未知 kind 是**静默丢弃**不是 400，故这里不做白名单校验（多传不炸）。
   */
  global: (q: string, opts: { kinds?: FtsKind[]; limit?: number } = {}) => {
    const params = new URLSearchParams({ q });
    if (opts.kinds && opts.kinds.length > 0) params.set('kinds', opts.kinds.join(','));
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    return request<SearchResponse>(`/api/search?${params.toString()}`);
  },
};
