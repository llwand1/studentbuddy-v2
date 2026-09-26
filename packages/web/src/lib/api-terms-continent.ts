/**
 * api-terms-continent — 知识大陆（S6）地图 REST 封装。
 *
 * ★ 独立成文件与 `api-terms-review.ts` 同一个理由：`api.ts` 已 350+ 行，加本组即撞 gates 的
 *   「.ts ≤400 行」红线（同 `api-terms-domain.ts` / `api-tools.ts` 的先例）。
 * ★ 只依赖 `api-request.ts` 与 `api-terms-review.ts`，**不反向 import `api.ts`**（环断在这里）。
 * ★ `review` 直接取服务端现算的共享类型（`ReviewState`）——前端**不自己算**到期与否：
 *   判定唯一实现在 `shared/ebbinghaus.ts`，地图上的怪和后端队列必须是同一个答案
 *   （否则会出现「图上说这只怪今天到期、复习队列里却没有它」）。
 */
import { request } from './api-request.js';
import type { ReviewTermItem } from './api-terms-review.js';

/**
 * 地图上的一条词条 = 复习条目 + **服务端给的**有效复习范围（1 = 该词条要复习）。
 * ★ 判「该不该冒怪」只能读这个结论，不许前端自己 COALESCE 一次：范围判定一旦有两份，
 *   就会出现「图上冒了怪、点进去 409（未纳入复习范围）」这种死路（见 `shared/continent.ts` 头注 2）。
 */
export interface ContinentMapTerm extends ReviewTermItem {
  review_in_scope: number;
}

export const termsContinentApi = {
  /**
   * 知识大陆地图：本用户**全部**词条（含复习范围外的）+ 现算复习状态，按入库时间升序。
   * ★ 只读：地图上的怪与"解锁"全是派生，答对走既有的 `terms.mark(id, true)`。
   */
  map: () => request<{ terms: ContinentMapTerm[] }>('/api/terms/review/map'),
};