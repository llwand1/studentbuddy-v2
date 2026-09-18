/**
 * api-terms-domain — 「领域」REST 封装（v19：领域升为一等实体，CRUD 与词条对等）。
 *
 * ★ 独立成文件：本组（统计 + 4 个写口 + 4 个类型）直接写进 `api.ts` 会顶破 gates 的
 *   「.ts ≤400 行」红线（实测 402 行）。先例是 `api-study-flow.ts`（同一原因抽出）。
 *   行数红线**不能靠压注释过**——那些注释记的是「为什么是这个形状」。
 * ★ 本文件只依赖 `api-request.ts`，**不反向 import `api.ts`**（环断在这里）。
 * ★ 4 个类型的形状与抽出前逐字一致，且 `api.ts` 仍 re-export ⇒ 调用方零改动。
 */
import { request } from './api-request.js';

/** 领域行（POST/PUT 的响应）。name 即领域名本身（小写、≤30 字符）。 */
export interface DomainRow {
  name: string;
  note: string;
  /** 派生计数（该领域下词条数；空领域为 0——**不是表里的列**） */
  count: number;
  created_at: string;
  updated_at: string;
}

/**
 * 领域统计响应（GET /api/terms/domains）。
 * ⚠️ 元素键是 `domain` 而非 `name`：沿用 v19 之前的既有形状（当时领域就是词条的一列），
 * 改名会连带改服务端统计测试与既有 UI，收益不抵风险，故保留。列表**含空领域**（count=0）。
 *
 * `mentionCount`（契约 MEMORY-TREND-SPEC §2）：该领域内所有词条的**总**提及数
 * （= `usage_count` 之和，含流水建表前的历史）。与 `count`（词条数）是**两个独立维度**：
 * 「3 个词条被提了 50 次」和「30 个词条一次没提过」是两种完全不同的学习状态。
 *
 * `preferred`（偏好领域）：按 `mentionCount` 降序的全序榜，**只含提及数 > 0 的领域**。
 * 服务端**不设阈值、不截断**（阈值是拍脑袋的数），由前端自己取前几个并**带上计数**展示
 * ——让用户看见依据，而不是只看见一个结论。
 */
export interface DomainsResponse {
  total: number;
  domains: Array<{ domain: string; count: number; note: string; mentionCount: number }>;
  today: number;
  /** 偏好领域榜（服务端已排好全序；本接口返回全量，展示时自取 top N） */
  preferred: Array<{ domain: string; mentionCount: number }>;
}

/** 领域改名结果：moved=随迁词条数，merged=目标域原本已存在（两域合一） */
export interface RenameDomainResult {
  from: string;
  to: string;
  moved: number;
  merged: boolean;
}

/** 领域删除结果：moved=迁入 general 的词条数（词条不删） */
export interface RemoveDomainResult {
  name: string;
  moved: number;
  target: string;
}

export const termsDomainApi = {
  /** 领域统计（含零词条的空领域） */
  domains: () => request<DomainsResponse>('/api/terms/domains'),

  // ⚠️ 路径里是**领域名本身**而非 id，必须 encodeURIComponent——领域名可含中文、空格
  // 与 `%`/`#` 这类保留字符（词条走 UUID 所以没这问题）。服务端不再二次解码。
  /** 新建领域（已存在返回既有行，不覆盖 note） */
  domainAdd: (name: string, note?: string) =>
    request<DomainRow>('/api/terms/domains', { method: 'POST', body: JSON.stringify({ name, note }) }),
  /** 改领域说明（只动 note） */
  domainNote: (name: string, note: string) =>
    request<DomainRow>(`/api/terms/domains/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ note }),
    }),
  /** 领域改名：该领域下词条**批量迁移**，目标域已存在则两域合一 */
  domainRename: (from: string, to: string) =>
    request<RenameDomainResult>(`/api/terms/domains/${encodeURIComponent(from)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: to }),
    }),
  /** 删除领域：词条迁 general（**不删词条**），返回迁移条数 */
  domainRemove: (name: string) =>
    request<RemoveDomainResult>(`/api/terms/domains/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};
