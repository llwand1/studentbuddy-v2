/** exam-sources: split domain module; compatible exports remain at exam-sources.ts. */
import { EXAM_PACKS } from './exam-catalog.js';
import { normalizeExamHost } from './exam-scope.js';
import { MAX_EXAM_CUSTOM_HOSTS } from './exam-scope.js';
import type { ExamGroup } from './exam-scope.js';
import type { ExamPack } from './exam-scope.js';
import { EXAM_GROUPS } from './exam-scope.js';
import { EXAM_SOURCES } from './exam-catalog.js';
import { scopeHosts } from './exam-scope.js';
import type { ExamSource } from './exam-scope.js';
import { examHostAllowed } from './exam-scope.js';
import { examScopeSignature } from './exam-scope.js';
import type { ExamSourceTier } from './exam-scope.js';

/** 默认范围＝全部预置包：先把「来源有界」做到位，用户再按自己要考的类目往下收 */
export const DEFAULT_EXAM_PACK_IDS: readonly string[] = EXAM_PACKS.map((p) => p.id);

export interface ExamScopeSetting {
  packs: string[];
  custom: string[];
}

/**
 * 读取时清洗：未知 pack id 丢掉、自填域名归一化去重、超出上限截断。
 * ★ 不清洗的后果：设置页存进一个改名后的 pack id，范围会**静默变空**（看着开着、其实全过滤掉）。
 */
export function normalizeExamScope(input: unknown): ExamScopeSetting {
  const raw = (input ?? {}) as { packs?: unknown; custom?: unknown };
  const knownIds = new Set(EXAM_PACKS.map((p) => p.id));
  const packs: string[] = [];
  for (const id of Array.isArray(raw.packs) ? raw.packs : DEFAULT_EXAM_PACK_IDS) {
    if (typeof id === 'string' && knownIds.has(id) && !packs.includes(id)) packs.push(id);
  }
  const custom: string[] = [];
  for (const h of Array.isArray(raw.custom) ? raw.custom : []) {
    const n = normalizeExamHost(h);
    if (n && !custom.includes(n) && custom.length < MAX_EXAM_CUSTOM_HOSTS) custom.push(n);
  }
  return { packs, custom };
}

/**
 * 按大类分组的预置包（设置页两块的分隔就靠它，组顺序固定：传统考试在前）。
 * ★ 组是数据不是样式：求职面试与传统考试的取材方式根本不同（前者在面经与题库站，
 *   后者在真题卷与题库站），混成一排勾选项会让人勾不出自己要的范围。
 */
export function packsByGroup(): Array<{ group: ExamGroup; label: string; hint: string; packs: ExamPack[] }> {
  const order: ExamGroup[] = ['exam', 'job'];
  return order.map((g) => ({
    group: g,
    label: EXAM_GROUPS[g].label,
    hint: EXAM_GROUPS[g].hint,
    packs: EXAM_PACKS.filter((p) => p.group === g),
  }));
}

/** 某个包属于哪个组（空态与范围话术要说"求职面试·技术面试"而不是只说包名） */
export function examPackGroup(packId: string): ExamGroup | null {
  return EXAM_PACKS.find((p) => p.id === packId)?.group ?? null;
}

/** 预置包里的域名（按 pack 收集，跨包去重） */
export function packHosts(packs: readonly string[]): string[] {
  const picked = new Set(packs);
  const out = new Set<string>();
  for (const s of EXAM_SOURCES) if (s.packs.some((p) => picked.has(p))) out.add(s.host);
  return [...out];
}

/** 本次生效的域名集合（预置包 + 用户自填，归一化排序） */
export function resolveExamHosts(scope: ExamScopeSetting): string[] {
  return scopeHosts([...packHosts(scope.packs), ...scope.custom]);
}

/** 生效域名对应的登记表条目（自填域名不在表上 ⇒ 只算范围不算直达端点） */
export function resolveExamSources(scope: ExamScopeSetting): ExamSource[] {
  const hosts = new Set(resolveExamHosts(scope));
  return EXAM_SOURCES.filter((s) => hosts.has(s.host));
}

/**
 * 一个主机名属于哪些考试类目（词条范围联动的唯一推导口径）。
 *
 * ★ 只对**登记表上的站**返回类目：用户自填的域名不在表上 ⇒ 返回空数组，
 *   于是它在应试模式下"算范围内、但不属于任何类目"。这不是漏判——
 *   类目是给用户勾范围用的标签，自填站已经通过"在范围内"这件事生效了，
 *   再替它编一个类目就是替用户做他没做过的判断。
 * @param host 归一化后或带 `www.` 的主机名（不是 URL）
 */
export function examPacksForHost(host: string): string[] {
  const out: string[] = [];
  for (const s of EXAM_SOURCES) {
    if (!examHostAllowed(host, [s.host])) continue;
    for (const p of s.packs) if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** 这个主机名在不在登记表上（用于区分「范围内但有类目」与「范围内、无类目」） */
export function isRegisteredExamHost(host: string): boolean {
  return EXAM_SOURCES.some((s) => examHostAllowed(host, [s.host]));
}

/** 范围签名：进缓存键与「来源已按范围过滤」提示 */
export function resolveExamSignature(scope: ExamScopeSetting): string {
  return examScopeSignature(resolveExamHosts(scope));
}

/** 设置页一行话：`高考、中考、+2 个自填站` */
export function examScopeSummary(scope: ExamScopeSetting): string {
  const labels = scope.packs
    .map((id) => EXAM_PACKS.find((p) => p.id === id)?.label ?? '')
    .filter(Boolean);
  const shown = labels.slice(0, 4).join('、');
  const head = labels.length > 4 ? `${shown} 等 ${labels.length} 类` : shown || '未选类目';
  return scope.custom.length > 0 ? `${head}＋${scope.custom.length} 个自填站` : head;
}

// ── 设置页 REST 契约（`/api/settings/exam-*`，见 docs/EXAM-MODE-SPEC.md §5）──

/** `GET /api/settings/exam-packs`：静态登记表，UI 渲染勾选项 */
export interface ExamPacksView {
  packs: { id: string; label: string; hint: string; group: ExamGroup }[];
  /** 两个大类的名字与说明（UI 分区标题用它，别在前端再抄一份中文） */
  groups: { id: ExamGroup; label: string; hint: string }[];
  sources: {
    host: string;
    label: string;
    tier: ExamSourceTier;
    packs: string[];
    note: string;
    /** null ⇒ 这一站没有实测过的站内直达端点（只能等通用搜索命中它） */
    direct: { verifiedAt: string } | null;
  }[];
}

/** `GET /api/settings/exam-mode` */
export interface ExamModeView {
  on: boolean;
  scope: ExamScopeSetting;
  summary: string;
  hosts: string[];
  /** 范围内**有**站内直达端点的站名（用户最关心的一个数：范围窄到没题源了要看得见） */
  directSites: string[];
}

/** `PUT /api/settings/exam-scope` 的响应：回读实际生效值（归一化与钳位在服务端做） */
export interface ExamScopeSaveView extends ExamModeView {
  ok: boolean;
  /** 被判定非法而丢弃的自填条目数（不静默吞输入） */
  rejectedCustom: number;
}

export { EXAM_PACKS } from './exam-catalog.js';
export { EXAM_SOURCES } from './exam-catalog.js';
