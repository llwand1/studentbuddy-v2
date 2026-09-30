/**
 * api-guide — 「下一步引导（引路灯）」REST 封装（契约 `docs/GUIDE-SPEC.md` §6，`POST /api/guide/next`）。
 *
 * ★ 独立成文件（同 `api-drill.ts`）：`api.ts` 贴 gates 的「.ts ≤400 行」红线；只依赖 `api-request.ts`，不反向 import `api.ts`。
 * ★ 带 25 秒超时：服务端的模型调用上限是 20 秒，多给的 5 秒留给网络；超时 / 取消由调用方当作「没拿到 AI 推荐」处理。
 */
import type { GuideNextRequest, GuideNextResponse } from '@sb/shared';
import { request } from './api-request.js';

export const guideApi = {
  next: (body: GuideNextRequest, signal?: AbortSignal) =>
    request<GuideNextResponse>('/api/guide/next', { method: 'POST', body: JSON.stringify(body), signal, timeoutMs: 25_000 }),
};
