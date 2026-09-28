/**
 * api-ember — 「余烬笺 · 意外发现」的 REST 封装（服务端 `routes/ember.ts` 的形状镜像）。
 * ★ 判定一律读服务端（今天烧哪一簇、落在哪格、收没收过、谢没谢过），前端不重算。
 */
import { request } from './api-request.js';

export interface EmberNote {
  id: string;
  term: string;
  domain: string;
  definition: string;
  body: string;
  sign: string;
  hue: string;
  thanks: number;
  createdAt: string;
}

export interface EmberSpot {
  note: EmberNote;
  row: number;
  col: number;
  kept: boolean;
  thanked: boolean;
}

export const emberApi = {
  /** 今天（`night` = 再过几夜）大陆上那簇异火；没有别人写过笺时为 `null` */
  spot: (night = 0) => request<{ spot: EmberSpot | null }>(`/api/ember/spot?night=${night}`),
  mine: () => request<{ notes: EmberNote[] }>('/api/ember/mine'),
  write: (termId: string, body: string, sign?: string) =>
    request<{ note: EmberNote }>('/api/ember', { method: 'POST', body: JSON.stringify({ termId, body, sign }) }),
  remove: (id: string) => request<{ ok: true }>(`/api/ember/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  keep: (id: string) =>
    request<{ ok: true; termId?: string; already?: boolean }>(`/api/ember/${encodeURIComponent(id)}/keep`, { method: 'POST' }),
  thank: (id: string) =>
    request<{ ok: true; thanks?: number; already?: boolean }>(`/api/ember/${encodeURIComponent(id)}/thank`, { method: 'POST' }),
  hide: (id: string) => request<{ ok: true }>(`/api/ember/${encodeURIComponent(id)}/hide`, { method: 'POST' }),
};
