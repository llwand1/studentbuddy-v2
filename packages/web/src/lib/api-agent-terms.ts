import type { AgentKeyView } from '@sb/shared';
import { request } from './api-request';
export const agentKeysApi = {
  list: () => request<{ keys: AgentKeyView[] }>('/api/settings/agent-keys', { timeoutMs: 10000 }),
  create: (name: string, days: number, questionSeeds = false) => request<{ key: AgentKeyView; token: string }>('/api/settings/agent-keys', {
    method: 'POST', body: JSON.stringify({ name, days, questionSeeds }), timeoutMs: 10000,
  }),
  revoke: (id: string) => request<{ ok: boolean }>(`/api/settings/agent-keys/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 10000 }),
};
