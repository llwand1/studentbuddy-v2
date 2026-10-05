/**
 * learning/drill — 「等待时刷词」的服务端：**出新词**（用户等 AI 回复时刷到词库里没有的词）。
 * 契约 `docs/WAIT-DRILL-SPEC.md` §4；纯口径（题面 / 判分 / 排队）在 `@sb/shared/drill`——本文件只管三件事：
 *
 *   ① `drillNewTerms`：给几条**词库里没有的**新词。取数顺序是硬规则：
 *      **先消化上次没定夺的候选**（`term_pool_candidate.status='pending'`）→ 不够再让模型现出 →
 *      没绑模型 / 模型失手 ⇒ 内置词池兜底，`source:'fallback'` 如实标。
 *      ★ 为什么先消化：每次等待都让模型出 3 条，一周下来候选表里躺着几十条没人看的"待处理"，
 *        设置页那张候选卡会变成垃圾场。先把已有的用完，是对模型花费与用户注意力的双重节约。
 *   ② `keepDrillTerm`：用户答对后点「收入词库」——候选标通过（`decideCandidate`，顺手完成"补池"那单）
 *      + `saveOneTerm` 落库。★ 走既有两条路，不自己 INSERT（领域登记 / 同名 upsert / 索引都在那条路上）。
 *   ③ `dismissDrillTerm`：点「不要」——候选标驳回，**留行不删**（`pool-candidates.ts` 头注：驳回过的不许再回来）。
 *
 * ★ 模型出的词是**候选**不是词条（TERM-CARDS-SPEC §6.3 人工闸门）：进不进词库由用户在刷词里那一下决定。
 *   这也是任务 #7「AI 生成候选」在本仓的第一处真实生产者——此前候选表只有测试往里写。
 * ★ 题材：带上**这轮对话用户刚问的那句**（`canAccessSession` 守归属）与用户词库的领域分布，让新词
 *   跟着正在聊的东西走；没有会话就只按领域出。
 * ★ AI 降级纪律同 `continent-expand.ts`：永不因模型报错让刷词卡住；降级可以，假装没降级不行。
 */
import { randomUUID } from 'node:crypto';
import {
  DRILL_DEF_MAX,
  DRILL_NEW_TERMS,
  DRILL_TERM_MAX,
  type DrillKeepResult,
  type DrillNewTerm,
  type DrillNewTermsResult,
} from '@sb/shared';
import type { ChatMessage } from '../llm/types.js';
import { routeRole } from '../llm/router.js';
import { loadPomodoro } from '../storage/pomodoro.js';
import { buildFocusBlock } from '../chat/focus-context.js';
import { buildExamScopeLine } from './exam-mode.js';
import { aiJson } from '../ai/gateway.js';
import { getDb } from '../storage/db.js';
import { canAccessSession, ownerForWrite } from '../auth/ownership.js';
import { drawablePool } from './chest.js';
import { decideCandidate, listCandidates } from './pool-candidates.js';
import { saveOneTerm } from './terms.js';
import { normName, ownedNames } from './term-names.js';

const AI_MAX_TOKENS = 700;
const AI_TEMPERATURE = 0.8;
/** 提示词里最多列多少条"已有词条"给模型避让 */
const PROMPT_EXISTING_CAP = 60;
/** 题材取用户那句话的前多少字 */
const TOPIC_MAX = 240;
/** 领域分布只报前几名 */
const DOMAIN_TOP = 4;

export type DrillFail = { ok: false; status: number; error: string };

interface Candidate {
  term: string;
  definition: string;
  domain: string;
}

/** 这轮对话用户最后一句（守归属：别人的会话 ⇒ 当没有） */
function sessionTopic(ownerId: string | null, sessionId: string | null | undefined): string {
  if (!sessionId || !canAccessSession(sessionId, ownerId)) return '';
  const row = getDb()
    .prepare(`SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(sessionId) as { content: string } | undefined;
  return (row?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, TOPIC_MAX);
}

/** 用户词库的领域分布（按条数降序，取前几名） */
function topDomains(ownerId: string | null): string[] {
  const rows = getDb()
    .prepare(`SELECT domain, COUNT(*) AS n FROM term_library WHERE owner_id = ? GROUP BY domain ORDER BY n DESC, domain ASC LIMIT ?`)
    .all(ownerForWrite(ownerId), DOMAIN_TOP) as Array<{ domain: string; n: number }>;
  return rows.map((r) => r.domain);
}

/** 候选表里**所有**状态的名字：驳回过的不许再出，已在表里的也不重复插 */
function candidateNames(ownerId: string | null): Set<string> {
  const rows = getDb()
    .prepare('SELECT term FROM term_pool_candidate WHERE owner_id = ?')
    .all(ownerForWrite(ownerId)) as Array<{ term: string }>;
  return new Set(rows.map((r) => normName(r.term)));
}

function buildPrompt(topic: string, domains: string[], existing: string[], want: number, focusLine = '', examLine = ''): string {
  return [
    '你在为一个正在等 AI 回复的学习者出几条**他词库里还没有的新词条**，让他在等待的十几秒里刷一刷。',
    // 番茄钟方向（契约 POMODORO-SPEC §5.3）排在话题之前：方向是他定的，话题只是刚好聊到
    ...(focusLine ? [focusLine] : []),
    ...(examLine ? [examLine] : []),
    topic ? `他刚刚问的是：「${topic}」——新词条优先与这个话题相关。` : '他还没有具体话题，按他常学的领域出。',
    `他常学的领域：${domains.join('、') || '（还不清楚，出通用的学习科学 / 计算机基础概念）'}。`,
    '严格只回一个 JSON 对象，不要代码块、不要解释：',
    `{"candidates":[{"term":"词条","definition":"释义","domain":"领域"}${want > 1 ? ',{"term":"…","definition":"…","domain":"…"}' : ''}]}`,
    `要求：给 ${want} 条；term 不超过 ${DRILL_TERM_MAX} 字；definition 不超过 ${DRILL_DEF_MAX} 字，像一个人自己存的学习笔记`,
    '（一两句话说清是什么、怎么用），不要写成讲解页；domain 用一个短小写英文或中文词（如 js / algo / 心理学）。',
    `用户库里已经有这些词条，**不要重复也不要换个说法再给**：${existing.slice(0, PROMPT_EXISTING_CAP).join('、') || '（还没有）'}。`,
  ].join('\n');
}

/** 从模型输出里抠 JSON 并归一化候选（超长整条丢弃；一条都没有 ⇒ null，交给 `aiJson` 修复/放弃） */
export function parseDrillCandidates(text: string): Candidate[] | null {
  const at = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (at < 0 || end <= at) return null;
  let v: unknown;
  try {
    v = JSON.parse(text.slice(at, end + 1)) as unknown;
  } catch {
    return null;
  }
  const list = v && typeof v === 'object' ? (v as { candidates?: unknown }).candidates : null;
  if (!Array.isArray(list)) return null;
  const out: Candidate[] = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const o = c as { term?: unknown; definition?: unknown; domain?: unknown };
    const term = typeof o.term === 'string' ? o.term.trim() : '';
    const definition = typeof o.definition === 'string' ? o.definition.trim() : '';
    const domain = (typeof o.domain === 'string' ? o.domain.trim().toLowerCase().slice(0, 30) : '') || 'general';
    if (!term || !definition) continue;
    if (term.length > DRILL_TERM_MAX || definition.length > DRILL_DEF_MAX) continue;
    out.push({ term, definition, domain });
  }
  return out.length > 0 ? out : null;
}

/** 内置词池兜底（`drawablePool` 已排除用户库里有的）：随机取 n 条 */
function poolTerms(ownerId: string | null, n: number, reason: string): DrillNewTermsResult {
  const pool = [...drawablePool(ownerId)];
  const items: DrillNewTerm[] = [];
  while (pool.length > 0 && items.length < n) {
    const i = Math.floor(Math.random() * pool.length);
    const [pick] = pool.splice(i, 1);
    if (!pick) break;
    items.push({
      candidateId: null,
      term: pick.entry.term,
      definition: pick.entry.definition,
      domain: pick.entry.domain,
      source: 'fallback',
      fallbackReason: reason,
    });
  }
  return items.length > 0 ? { mode: 'fallback', items, fallbackReason: reason } : { mode: 'empty', items: [], fallbackReason: reason };
}

/** 把模型出的词落成 `pending` 候选（重名过滤后），回给前端时带 candidateId */
function insertCandidates(ownerId: string | null, list: Candidate[], want: number): DrillNewTerm[] {
  const owned = ownedNames(ownerId);
  const known = candidateNames(ownerId);
  const owner = ownerForWrite(ownerId);
  const ins = getDb().prepare(
    `INSERT INTO term_pool_candidate (id, owner_id, term, domain, definition, aliases, status, source)
     VALUES (?, ?, ?, ?, ?, '[]', 'pending', 'ai')`,
  );
  const out: DrillNewTerm[] = [];
  for (const c of list) {
    const key = normName(c.term);
    if (owned.has(key) || known.has(key)) continue;
    known.add(key);
    const id = randomUUID();
    ins.run(id, owner, c.term, c.domain, c.definition);
    out.push({ candidateId: id, term: c.term, definition: c.definition, domain: c.domain, source: 'ai' });
    if (out.length >= want) break;
  }
  return out;
}

/** 模型现出（没模型 / 失手 ⇒ 词池）。`want` 是还差几条 */
async function freshTerms(
  ownerId: string | null,
  want: number,
  owned: Set<string>,
  sessionId: string | null | undefined,
  signal: AbortSignal | undefined,
): Promise<DrillNewTermsResult> {
  const target = routeRole('explain', undefined, ownerId);
  if (!target?.model || !target.apiKey) return poolTerms(ownerId, want, '没有绑定可用的模型，这批来自内置词池');
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildPrompt(
        sessionTopic(ownerId, sessionId),
        topDomains(ownerId),
        [...owned],
        want,
        buildFocusBlock(loadPomodoro(ownerId)),
        buildExamScopeLine(ownerId), // 应试模式：新词条也得落在他圈的范围内
      ),
    },
    { role: 'user', content: `出 ${want} 条新词条。` },
  ];
  const r = await aiJson({
    purpose: 'drill.newterms',
    ownerId,
    target,
    messages,
    temperature: AI_TEMPERATURE,
    maxTokens: AI_MAX_TOKENS,
    streamMode: 'once',
    signal,
    parse: parseDrillCandidates,
    repairHint: '只回 {"candidates":[{"term":"…","definition":"…","domain":"…"}]} 这一个 JSON 对象。',
  });
  const fresh = r.ok ? insertCandidates(ownerId, r.value, want) : [];
  if (fresh.length === 0) return poolTerms(ownerId, want, r.ok ? '模型这次没给出合格的新词条，这批来自内置词池' : '模型这次没接上，这批来自内置词池');
  return { mode: 'ai', items: fresh };
}

/**
 * ① 给几条新词。顺序：pending 候选 → 模型现出 → 词池兜底；候选不够 `want` 条时用后两级**补齐**
 * （只剩一条没人定夺的候选时，不能让它把新词全堵住）。永不 throw：模型失手也要有词可刷。
 */
export async function drillNewTerms(
  ownerId: string | null,
  opts: { sessionId?: string | null; want?: number } = {},
  signal?: AbortSignal,
): Promise<DrillNewTermsResult> {
  const want = Math.max(1, Math.min(DRILL_NEW_TERMS, Math.trunc(opts.want ?? DRILL_NEW_TERMS)));
  const owned = ownedNames(ownerId);
  const pending: DrillNewTerm[] = listCandidates(ownerId, 'pending')
    .filter((c) => !owned.has(normName(c.term)))
    .slice(0, want)
    .map((c) => ({ candidateId: c.id, term: c.term, definition: c.definition, domain: c.domain, source: 'ai' as const }));
  if (pending.length >= want) return { mode: 'pending', items: pending };
  const more = await freshTerms(ownerId, want - pending.length, owned, opts.sessionId, signal);
  if (pending.length === 0) return more;
  return { mode: 'pending', items: [...pending, ...more.items], fallbackReason: more.fallbackReason };
}

/**
 * ② 收入词库。有 `candidateId` ⇒ 以候选表里的那一行为准（不信任 body 里的字段）并标通过；
 * 没有（词池条目）⇒ 按 body 落库。已处理过的候选照样落库（幂等：用户点两下不该报错）。
 */
export function keepDrillTerm(
  ownerId: string | null,
  body: { candidateId?: string | null; term?: string; definition?: string; domain?: string },
): DrillKeepResult | DrillFail {
  let term = (body.term ?? '').trim();
  let definition = (body.definition ?? '').trim();
  let domain = (body.domain ?? '').trim();
  let candidateApproved = false;
  if (body.candidateId) {
    const row = getDb()
      .prepare('SELECT term, definition, domain, status FROM term_pool_candidate WHERE id = ? AND owner_id = ?')
      .get(body.candidateId, ownerForWrite(ownerId)) as { term: string; definition: string; domain: string; status: string } | undefined;
    if (!row) return { ok: false, status: 404, error: '这条候选不存在（可能已被清理），换一条吧' };
    ({ term, definition, domain } = row);
    if (row.status === 'pending') candidateApproved = decideCandidate(ownerId, body.candidateId, true).ok;
  }
  if (!term || !definition) return { ok: false, status: 400, error: 'term / definition 必填' };
  if (term.length > DRILL_TERM_MAX || definition.length > DRILL_DEF_MAX) return { ok: false, status: 400, error: '词条或释义太长' };
  const saved = saveOneTerm(term, definition, domain || undefined, ownerId);
  return { ok: true, termId: saved.id, term: saved.term, candidateApproved };
}

/** ③ 不要这条：候选标驳回（留行）。已处理过 ⇒ 409、不存在 ⇒ 404，与 `decideCandidate` 同一份状态码。 */
export function dismissDrillTerm(ownerId: string | null, candidateId: string): { ok: true } | DrillFail {
  const r = decideCandidate(ownerId, candidateId, false);
  return r.ok ? { ok: true } : { ok: false, status: r.status, error: r.error };
}
