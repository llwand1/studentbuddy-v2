/**
 * api — REST 封装（同源经 vite proxy；错误统一抛 ApiError，UI 层可见可重试，ADR-5）。
 */
import type { StatusResponse, Session, Provider, ModelRole } from '@sb/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  /** 通用请求（页面内直接用） */
  request,

  status: () => request<StatusResponse>('/api/status'),

  sessions: {
    list: () => request<Session[]>('/api/sessions'),
    create: () => request<Session>('/api/sessions', { method: 'POST' }),
    remove: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
    messages: (id: string) => request<Array<{ id: string; role: string; content: string; created_at: string }>>(`/api/sessions/${id}/messages`),
  },

  chat: {
    send: (sessionId: string, text: string) =>
      request<{ ok: boolean }>('/api/chat/send', {
        method: 'POST',
        body: JSON.stringify({ sessionId, text }),
      }),
    abort: (sessionId: string) =>
      request<{ ok: boolean }>('/api/chat/abort', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      }),
  },

  providers: {
    list: () => request<Array<Provider & { id: string }>>('/api/providers'),
    create: (p: { name: string; baseUrl: string; apiKey?: string; type?: string }) =>
      request<{ id: string }>('/api/providers', { method: 'POST', body: JSON.stringify(p) }),
    update: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean }) =>
      request<{ ok: boolean }>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
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
  },
};
