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

  settings: {
    searchKeys: () => request<{ configured: Record<'exa' | 'tavily' | 'zhipu', boolean> }>('/api/settings/search-keys'),
    saveSearchKeys: (patch: Partial<Record<'exa' | 'tavily' | 'zhipu', string>>) =>
      request<{ ok: boolean; configured: Record<'exa' | 'tavily' | 'zhipu', boolean> }>('/api/settings/search-keys', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    testSearch: (query?: string) =>
      request<{ ok: boolean; count: number; providers: string[]; failed: string[] }>('/api/settings/search/test', {
        method: 'POST',
        body: JSON.stringify({ query }),
      }),
  },

  terms: {
    list: (domain?: string, keyword?: string) => {
      const q = new URLSearchParams();
      if (domain && domain !== 'all') q.set('domain', domain);
      if (keyword) q.set('keyword', keyword);
      const qs = q.toString();
      return request<TermItem[]>(`/api/terms${qs ? `?${qs}` : ''}`);
    },
    domains: () =>
      request<{ total: number; domains: Array<{ domain: string; count: number }>; today: number }>('/api/terms/domains'),
    add: (term: string, definition: string, domain?: string) =>
      request<TermItem>('/api/terms', { method: 'POST', body: JSON.stringify({ term, definition, domain }) }),
    extract: (text: string, sourceSessionId?: string) =>
      request<{ added: number; items: TermItem[] }>('/api/terms/extract', {
        method: 'POST',
        body: JSON.stringify({ text, sourceSessionId }),
      }),
    update: (id: string, patch: { definition?: string; domain?: string; importance?: number }) =>
      request<TermItem>(`/api/terms/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
    remove: (id: string) => request<{ ok: boolean }>(`/api/terms/${id}`, { method: 'DELETE' }),
  },
};

export interface TermItem {
  id: string;
  term: string;
  definition: string;
  domain: string;
  source_session_id: string | null;
  source_title: string | null;
  importance: number;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}
