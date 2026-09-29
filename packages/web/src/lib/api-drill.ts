/**
 * api-drill — 「等待时刷词」REST 封装（契约 `docs/WAIT-DRILL-SPEC.md` §4，前缀 `/api/drill`）。
 *
 * ★ 独立成文件与 `api-terms-continent.ts` 同一个理由：`api.ts` 贴 gates 的「.ts ≤400 行」红线。
 * ★ 只依赖 `api-request.ts`，**不反向 import `api.ts`**。
 * ★ 词条本身不从这里取：刷词队列用既有的 `termsContinentApi.map()`（全库 + 服务端现算的到期状态），
 *   到期词条答对的打卡走既有的 `termsReviewApi.mark()`——刷词只多"新词"这一件事的三个写口。
 */
import type { DrillKeepResult, DrillNewTermsResult } from '@sb/shared';
import { request } from './api-request.js';

export const drillApi = {
  /** 出几条词库里没有的新词（先消化上次没定夺的候选 → 模型现出 → 没模型退内置词池，`source` 如实标） */
  newTerms: (sessionId: string | null) =>
    request<DrillNewTermsResult>('/api/drill/new-terms', {
      method: 'POST',
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    }),

  /** 答对后「收入词库」：候选按服务端那行为准；词池条目按字段落库 */
  keep: (item: { candidateId: string | null; term: string; definition: string; domain: string }) =>
    request<DrillKeepResult>('/api/drill/keep', {
      method: 'POST',
      body: JSON.stringify(
        item.candidateId
          ? { candidateId: item.candidateId }
          : { term: item.term, definition: item.definition, domain: item.domain },
      ),
    }),

  /** 「不要」：候选标驳回，以后不再出 */
  dismiss: (candidateId: string) =>
    request<{ ok: true }>('/api/drill/dismiss', {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
    }),
};
