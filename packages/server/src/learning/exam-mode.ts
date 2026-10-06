/**
 * learning/exam-mode — 应试模式的服务端读点（契约 `docs/EXAM-MODE-SPEC.md`）。
 *
 * 为什么单开一个文件：闸口散在六条外部链路上（聊天搜索、出题参考、真题搜集、网页阅读、找视频、对战裁判），
 * 每处都要「现在开没开、范围是哪些域、哪些站能直达」。这些判断只允许有一份实现——
 * 两处各写各的，就会出现「资料架过滤了、题卡没过滤」这种看着像 bug 又像配置的假象。
 *
 * ★ 与 `quiz-tier.ts` 同型：设置存 `app_settings`，**每用户一份**（v30 归主），
 *   所以 `ownerId` 必填。漏传的后果是匿名口径（`ownerForWrite(null)` = 空串行）——
 *   A 用户开了应试模式、B 用户跟着一起被过滤，而且不报错。
 */
import type { ExamModeView, ExamScopeSetting, ExamSource } from '@sb/shared';
import {
  SETTING_KEY_EXAM_MODE,
  SETTING_KEY_EXAM_SOURCES,
  examUrlAllowed,
  normalizeExamMode,
  normalizeExamScope,
  examScopeSummary,
  resolveExamHosts,
  resolveExamSignature,
  resolveExamSources,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

/** 一次请求内生效的应试范围快照 */
export interface ExamContext {
  /** 关 ⇒ 所有闸口旁路，行为与开启前逐字节一致 */
  on: boolean;
  /** 生效域名（预置包 + 自填，已归一化排序）。开且为空 ⇒ 外部检索整条关掉 */
  hosts: string[];
  /** 用户显式自填的域，包括登记表上已有的站；主题筛选也须保留。 */
  customHosts?: string[];
  /** hosts 里在登记表上的条目（自填域名不在表上） */
  sources: ExamSource[];
  /** 给用户看的一句话范围（`高考、中考＋2 个自填站`） */
  summary: string;
  /** 进 search_cache 键的范围签名 */
  signature: string;
}

export const EXAM_CTX_OFF: ExamContext = {
  on: false,
  hosts: [],
  sources: [],
  summary: '',
  signature: 'all',
};

function readSetting(ownerId: string | null, key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(ownerId: string | null, key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    // ★ 冲突目标必须写 `(owner_id, key)`（v30 主键）：仍写 `ON CONFLICT(key)` 会在 prepare() 期
    //   抛 SqliteError，无人 catch 时是整个进程退出，不是某个请求 500。
    .run(ownerForWrite(ownerId), key, value);
}

export function loadExamMode(ownerId: string | null): boolean {
  const raw = readSetting(ownerId, SETTING_KEY_EXAM_MODE);
  if (raw === null) return normalizeExamMode(undefined);
  try {
    return normalizeExamMode(JSON.parse(raw) as unknown);
  } catch {
    return normalizeExamMode(raw);
  }
}

export function loadExamScope(ownerId: string | null): ExamScopeSetting {
  const raw = readSetting(ownerId, SETTING_KEY_EXAM_SOURCES);
  if (raw === null) return normalizeExamScope(undefined);
  try {
    return normalizeExamScope(JSON.parse(raw) as unknown);
  } catch {
    // 存的是坏 JSON ⇒ 回默认范围，不让「设置读不出来」表现为范围突然变空（那会静默把外部检索全关掉）
    return normalizeExamScope(undefined);
  }
}

/** 一次取两把键（每个出题／搜索请求都读，两行 SELECT 比两次连接划算） */
export function loadExamContext(ownerId: string | null): ExamContext {
  if (!loadExamMode(ownerId)) return EXAM_CTX_OFF;
  const scope = loadExamScope(ownerId);
  const hosts = resolveExamHosts(scope);
  return {
    on: true,
    hosts,
    customHosts: scope.custom,
    sources: resolveExamSources(scope),
    summary: examScopeSummary(scope),
    signature: resolveExamSignature(scope),
  };
}

export function saveExamMode(value: unknown, ownerId: string | null): boolean {
  const clean = normalizeExamMode(value);
  writeSetting(ownerId, SETTING_KEY_EXAM_MODE, JSON.stringify(clean));
  return clean;
}

export function saveExamScope(value: unknown, ownerId: string | null): ExamScopeSetting {
  const clean = normalizeExamScope(value);
  writeSetting(ownerId, SETTING_KEY_EXAM_SOURCES, JSON.stringify(clean));
  return clean;
}

/** 配置回读：关闭模式时仍返回保存的范围，与设置页同口径。 */
export function readExamModeView(ownerId: string | null): ExamModeView {
  const scope = loadExamScope(ownerId);
  return { on: loadExamMode(ownerId), scope, summary: examScopeSummary(scope), hosts: resolveExamHosts(scope),
    directSites: resolveExamSources(scope).filter(s => s.direct).map(s => s.label) };
}

/** 外部 URL 能不能进这一轮（关着⇒一律放行；开着且范围空⇒一律拦下） */
export function examAllowed(url: string, ctx: ExamContext): boolean {
  if (!ctx.on) return true;
  if (ctx.hosts.length === 0) return false;
  return examUrlAllowed(url, ctx.hosts);
}

/**
 * 通用「范围前提」一句（引路灯／督促／刷词新词这三处 AI 文案共用）。
 *
 * 与 `buildExamPromptBlock` 的分工：那一段是**出题**的写作要求（题型、卷面、不许伪称真题），
 * 这一段只交代「这个人的学习被圈在什么范围内」——建议、督促话术、新词条都得落在范围内，
 * 但它们不需要出题那三条纪律。关着返回空串 ⇒ 三处提示词与改动前逐字一致。
 */
export function buildExamScopeLine(ownerId: string | null): string {
  const ctx = loadExamContext(ownerId);
  if (!ctx.on || ctx.hosts.length === 0) return '';
  return (
    `他开着**应试模式**，学习范围＝${ctx.summary}（资料与题库只来自这些站）。` +
    '给建议、说话术、出题、挑词条都只挑与该范围直接相关的；范围外的内容不要提，' +
    '也不要用「你之前学过」这类话把范围外的东西带回来。'
  );
}

/** 站内直达：登记表上配了检索端点、且这次确实在范围内的那些站 */
export interface ExamDirectHit {
  host: string;
  label: string;
  /** 已把 `{q}` 换成编码后查询词的完整 URL */
  url: string;
}

/**
 * 出题提示词的应试段。**关着返回空串** ⇒ 拼接后与旧提示词逐字一致（这是"零行为变化"的判据，
 * 由 `exam-mode.test.ts` 用「关 ⇒ 空串」这条锁守着）。
 *
 * ★ 为什么单独一段、不塞进参考资料段：参考资料段只在**联网且搜到东西**时才存在，
 *   而「出题要与所选考试范围有关」这个前提在纯 AI 出题（不联网）时同样成立。
 *   塞进去就会出现「不联网时模式开着、模型却不知道」的漏口。
 */
export function buildExamPromptBlock(ownerId: string | null): string {
  const ctx = loadExamContext(ownerId);
  if (!ctx.on) return '';
  const sources = ctx.sources.filter((s) => s.tier === 'question').map((s) => s.label);
  return [
    `本次为**应试模式**，范围＝${ctx.summary || '未选具体类目'}。`,
    '出题要求：① 只出与该范围直接相关的题，考点取该范围内的高频考法，不出范围外的延伸知识；' +
      '② 题型与难度照所选考试的常见卷面（客观题为主体，主观题不超过三成）；' +
      '③ 只有确实来自下方参考资料的题才可写「真题」字样，其余一律不得声称出处与年份；' +
      (sources.length > 0 ? `④ 本次范围内的题源：${sources.join('、')}。` : '④ 本次范围内没有已登记的题源站，只按常见考法出巩固题。'),
  ].join('\n') + '\n';
}

/**
 * 构造站内直达检索 URL。
 * ★ 这是白名单能提升出题质量的关键一步：免 key 的通用搜索引擎**不理 `site:`**
 *   （2026-10-04 实测三例，带与不带的结果集几乎逐条相同），只能换成站内的检索入口。
 * 单个查询词最长 60 字（站点检索框普遍更短，超了会返回错误页而不是结果）。
 */
export function examDirectQueries(topic: string, ctx: ExamContext): ExamDirectHit[] {
  const q = topic.trim().slice(0, 60);
  if (!ctx.on || !q) return [];
  const out: ExamDirectHit[] = [];
  for (const s of ctx.sources) {
    if (!s.direct) continue;
    out.push({ host: s.host, label: s.label, url: s.direct.search.replace('{q}', encodeURIComponent(q)) });
  }
  return out;
}
