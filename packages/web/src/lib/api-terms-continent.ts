/**
 * api-terms-continent — 知识大陆地图 REST 封装。
 *
 * ★ 独立成文件与 `api-terms-review.ts` 同一个理由：`api.ts` 已 350+ 行，加本组即撞 gates 的
 *   「.ts ≤400 行」红线（同 `api-terms-domain.ts` / `api-tools.ts` 的先例）。
 * ★ 只依赖 `api-request.ts` 与 `api-terms-review.ts`，**不反向 import `api.ts`**（环断在这里）。
 * ★ `review` 直接取服务端现算的共享类型（`ReviewState`）——前端**不自己算**到期与否：
 *   判定唯一实现在 `shared/ebbinghaus.ts`，地图上的怪和后端队列必须是同一个答案
 *   （否则会出现「图上说这只怪今天到期、复习队列里却没有它」）。
 * ★ 2026-09-29：地图多带一份**钉子**（开拓出来的地块坐标），并多两个写口（开拓的 offer / claim，
 *   前缀 `/api/continent`）。形状全在 `@sb/shared/continent-expand`：服务端出的题，前端原样渲染、判分同源。
 */
import type { ContinentAnswer, ContinentExpandOffer, ContinentExpandResult, ContinentPin } from '@sb/shared';
import { request } from './api-request.js';
import type { ReviewTermItem } from './api-terms-review.js';

/**
 * 地图上的一条词条 = 复习条目 + **服务端给的**有效复习范围（1 = 该词条要复习）。
 * ★ 判「该不该冒怪」只能读这个结论，不许前端自己 COALESCE 一次：范围判定一旦有两份，
 *   就会出现「图上冒了怪、点进去 409（未纳入复习范围）」这种死路（见 `shared/continent.ts` 头注 2）。
 */
export interface ContinentMapTerm extends ReviewTermItem {
  review_in_scope: number;
  /** 最近一次在对话回复里被提到（UTC 文本，服务端写）；**话题怪**据此派生（`shared/continent-upkeep.ts`） */
  last_used_at: string | null;
}

/** `GET /api/terms/review/map` 的整份响应（词条 + 钉子；铺格两端同源的前提） */
export interface ContinentMapPayload {
  terms: ContinentMapTerm[];
  pins: ContinentPin[];
}

export const termsContinentApi = {
  /**
   * 知识大陆地图：本用户**全部**词条（含复习范围外的）+ 现算复习状态，按入库时间升序；另带钉子。
   * ★ 只读：地图上的怪与"解锁"全是派生，答对走既有的 `terms.mark(id, true)`。
   */
  map: () => request<ContinentMapPayload>('/api/terms/review/map'),

  /** 开拓 ①：点一枚「+」领一块待开拓地（新词条 + 两道题 + 凭证 nonce） */
  expandOffer: (row: number, col: number) =>
    request<ContinentExpandOffer>('/api/continent/expand/offer', {
      method: 'POST',
      body: JSON.stringify({ row, col }),
    }),

  /** 开拓 ②：交作答；服务端重判，全对才落库 + 钉住 */
  expandClaim: (nonce: string, answers: ContinentAnswer[]) =>
    request<ContinentExpandResult>('/api/continent/expand/claim', {
      method: 'POST',
      body: JSON.stringify({ nonce, answers }),
    }),
};
