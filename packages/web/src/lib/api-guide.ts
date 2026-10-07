/**
 * api-guide — 「下一步引导（引路灯）」REST 封装（契约 `docs/GUIDE-SPEC.md` §6，`POST /api/guide/next`）。
 *
 * ★ 独立成文件（同 `api-drill.ts`）：`api.ts` 贴 gates 的「.ts ≤400 行」红线；只依赖 `api-request.ts`，不反向 import `api.ts`。
 * ★ 与服务端共用预算：首次回答和修复共 40 秒，客户端多留 5 秒给网络。
 */
import { INTERACTIVE_AI_BUDGET, type GuideNextRequest, type GuideNextResponse } from '@sb/shared';
import { request } from './api-request.js';

export const guideApi = {
  next: (body: GuideNextRequest, signal?: AbortSignal) =>
    request<GuideNextResponse>('/api/guide/next', { method: 'POST', body: JSON.stringify(body), signal, timeoutMs: INTERACTIVE_AI_BUDGET.clientMs }),
};
