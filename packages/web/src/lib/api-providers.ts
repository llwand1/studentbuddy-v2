/**
 * api-providers — 服务商 / 角色模型绑定 / 免费额度端点封装。
 *
 * ★ **为什么从 `api.ts` 拆出来**：本次加「一键默认设置」与「免费额度查询」两个方法后
 *   `api.ts` 会越过 `web/.ts ≤400` 红线（拆前 397 行、正贴着线）。按仓规**拆文件不压注释**，
 *   方向与 `api-settings.ts` / `api-terms-domain.ts` / `api-tools.ts` 等既有先例完全一致：
 *   全都指向 `api-request.ts`（最低层），**不构成环**。
 * ★ **消费面零改动**：`api.ts` 里仍是 `providers: providersApi`，调用方照旧写
 *   `api.providers.models(id)`。
 */
import type { ModelRole, PlatformQuotaView, Provider } from '@sb/shared';
import { request } from './api-request.js';

export const providersApi = {
  list: () => request<Array<Provider & { id: string }>>('/api/providers'),
  create: (p: { name: string; baseUrl: string; apiKey?: string; type?: string; streamMode?: string }) =>
    request<{ id: string }>('/api/providers', { method: 'POST', body: JSON.stringify(p) }),
  update: (
    id: string,
    patch: { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean; streamMode?: string },
  ) => request<{ ok: boolean }>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  /**
   * 该服务商的真实可用模型列表（拉取失败/不支持时为空数组，前端保留手填）。
   * ★ 平台服务商也拉得到：服务端会用 env 里的平台凭据去拉（库里的 key 恒为空），
   *   返回值只有模型名，**不含任何凭据**。
   */
  models: (id: string) => request<{ models: string[] }>(`/api/providers/${id}/models`),
  remove: (id: string) => request<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' }),
  roles: () =>
    request<{
      roles: Array<{ role: ModelRole; label: string }>;
      bindings: Array<{ role: string; provider_id: string; model: string }>;
    }>('/api/providers/roles'),
  bindRole: (role: string, providerId: string, model: string) =>
    request<{ ok: boolean }>(`/api/providers/roles/${role}`, {
      method: 'PUT',
      body: JSON.stringify({ providerId, model }),
    }),
  /**
   * **一键默认设置**：把 8 个角色全部绑到平台免费通道（model 留空 ⇒ 由平台默认模型决定）。
   * ★ 只写**当前用户自己的**绑定，不动平台行、不动别人的。
   * ★ 回 `providerId` / `model` / `roles` 是"配完之后实际生效的是什么"，供设置页当场显示；
   *   平台通道不可用时服务端回 409（不是静默成功）。
   */
  oneClickDefault: () =>
    request<{ ok: boolean; providerId: string; model: string; roles: number }>('/api/providers/roles/default', {
      method: 'POST',
    }),
  /**
   * 平台免费额度剩余次数（`PlatformQuotaView` 三态）。
   * ★ `limited: false` 有**两种**含义，必须按 `reason` 分支，别当成一件事：
   *   · `reason: 'local'`     = 未登录单人模式，**不计量**（不是"额度无限"）；
   *   · `reason: 'unlimited'` = 平台通道已取消**每用户**上限，**不限次数**（仍受全站每日闸）。
   *   `reason: 'limited'` 时才用 `used`/`limit`/`resetAt` 显示"还剩 N 次"。
   */
  quota: () => request<PlatformQuotaView>('/api/providers/quota'),
};
