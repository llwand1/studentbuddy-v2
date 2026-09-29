/**
 * learning/continent-expand — 知识大陆**开拓地块**的服务端：领地（offer）→ 答题 → 落地（claim）。
 * 契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「开拓」；纯口径（边界格 / 题组 / 主导领域）在 `@sb/shared/continent-expand`。
 *
 * ── 一次开拓的两步 ─────────────────────────────────────────────────────────────
 *   ① `offerExpansion(cell)`：校验这一格是**边界空格** → 看四邻的主导领域 → 要一条**新词条**
 *      （AI 按邻格领域生成；没模型/失手 ⇒ 内置词池，`source:'fallback'` 如实标）→ 用一次性 `nonce`
 *      派生两道随机题型 → 记在内存里（10 分钟）→ 回给前端"先看释义、再答题"。
 *   ② `claimExpansion(nonce, answers)`：服务端**重新判分**（`gradeAnswer`，与弹窗同一份口径）→
 *      再验一次这一格还空着、这个词还没人存 → `saveOneTerm` 落库 → 钉子写进 `continent_pins`。
 *
 * ★ 为什么 offer 放**内存**而不落库：它是十分钟内的一次性凭证，不是账。落库就得建表或往
 *   `app_settings` 里塞会过期的垃圾；进程重启丢掉的只是"重新点一次 +"这点代价（同 `chat/tools/confirm.ts`
 *   把待确认项放内存的取舍）。
 * ★ 为什么服务端要重判：题是服务端出的，"答对才给地"这条规则的裁判也得在服务端——前端本地判分
 *   只是为了即时反馈。两处用的是**同一个** `gradeAnswer`，不会出现"弹窗说对了、服务端说错了"。
 * ★ 与 `acceptDraw`（宝箱）同一条落库路：走 `saveOneTerm`（领域登记 / 同名 upsert / 索引都在那条路上），
 *   **不**自己 INSERT。新词条不打卡、不入范围：它是刚见第一面的词，按曲线明天到期；范围跟随领域开关。
 * ★ AI 降级纪律同 `npc-genesis.ts`：永不因模型报错让「+」变成坏掉的按钮；降级可以，假装没降级不行。
 */
import { randomUUID } from 'node:crypto';
import {
  CONTINENT_EXPAND_DEF_MAX,
  CONTINENT_EXPAND_TERM_MAX,
  buildExpandQuestions,
  dominantDomain,
  gradeAnswer,
  isFrontierCell,
  layoutRadius,
  layoutTiles,
  neighborTilesOf,
  type ContinentAnswer,
  type ContinentExpandOffer,
  type ContinentExpandResult,
} from '@sb/shared';
import type { ChatMessage } from '../llm/types.js';
import { routeRole } from '../llm/router.js';
import { aiJson } from '../ai/gateway.js';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { continentMap } from './continent.js';
import { loadContinentPins, saveContinentPin } from './continent-pins.js';
import { drawablePool } from './chest.js';
import { parseAliases, saveOneTerm } from './terms.js';

/** offer 有效期与内存上限（超上限先淘汰最老的——正常一人同时只会有一份） */
export const EXPAND_OFFER_TTL_MS = 10 * 60_000;
const OFFER_CAP = 500;

const AI_MAX_TOKENS = 600;
const AI_TEMPERATURE = 0.8;
/** 提示词里最多列多少条"已有词条"给模型避让（再多就是白花 token） */
const PROMPT_EXISTING_CAP = 60;

export type ExpandFail = { ok: false; status: number; error: string };

interface PendingOffer {
  owner: string;
  offer: ContinentExpandOffer;
}

const offers = new Map<string, PendingOffer>();

function prune(now: number): void {
  for (const [k, v] of offers) if (v.offer.expiresAt <= now) offers.delete(k);
  while (offers.size > OFFER_CAP) {
    const oldest = offers.keys().next().value;
    if (oldest === undefined) break;
    offers.delete(oldest);
  }
}

/** 测试用：清空内存里的 offer（进程内单例，用例之间不清会串） */
export function resetExpandOffersForTest(): void {
  offers.clear();
}

/** 归一名（与 `chest.ts` 的去重口径同：去空白 + 小写） */
function normName(s: string): string {
  return s.trim().toLowerCase();
}

/** 用户库里已有的名字（正名 + 别名）——新词条不许与之重名 */
function ownedNames(ownerId: string | null): Set<string> {
  const owned = new Set<string>();
  const rows = getDb()
    .prepare('SELECT term, aliases FROM term_library WHERE owner_id = ?')
    .all(ownerForWrite(ownerId)) as Array<{ term: string; aliases: string | null }>;
  for (const r of rows) {
    owned.add(normName(r.term));
    for (const a of parseAliases(r.aliases)) owned.add(normName(a));
  }
  return owned;
}

interface NewTerm {
  term: string;
  definition: string;
  domain: string;
  source: 'ai' | 'fallback';
  fallbackReason?: string;
}

function buildPrompt(domain: string, neighbors: string[], existing: string[]): string {
  return [
    `你在为「知识大陆」上一块新开拓的地挑一条**新词条**。这块地紧挨着领域「${domain}」的地块，邻近词条：${neighbors.join('、') || '（无）'}。`,
    '严格只回一个 JSON 对象，不要代码块、不要解释：',
    '{"candidates":[{"term":"词条","definition":"释义"},{"term":"…","definition":"…"},{"term":"…","definition":"…"}]}',
    `要求：三条候选都属于领域「${domain}」、与邻近词条同一层次且有关联；term 不超过 ${CONTINENT_EXPAND_TERM_MAX} 字；`,
    `definition 不超过 ${CONTINENT_EXPAND_DEF_MAX} 字，像一个人自己存的学习笔记（一两句话说清是什么、怎么用），不要写成讲解页。`,
    `用户库里已经有这些词条，**不要重复也不要换个说法再给**：${existing.slice(0, PROMPT_EXISTING_CAP).join('、') || '（还没有）'}。`,
  ].join('\n');
}

/** 从模型输出里抠 JSON 并归一化候选（长度超限的整条丢弃；一条都没有 ⇒ null，交给 `aiJson` 修复/放弃） */
function parseCandidates(text: string): Array<{ term: string; definition: string }> | null {
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
  const out: Array<{ term: string; definition: string }> = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const term = typeof (c as { term?: unknown }).term === 'string' ? (c as { term: string }).term.trim() : '';
    const definition =
      typeof (c as { definition?: unknown }).definition === 'string' ? (c as { definition: string }).definition.trim() : '';
    if (!term || !definition) continue;
    if (term.length > CONTINENT_EXPAND_TERM_MAX || definition.length > CONTINENT_EXPAND_DEF_MAX) continue;
    out.push({ term, definition });
  }
  return out.length > 0 ? out : null;
}

/** 内置词池兜底：优先同领域，其次任意；池子空了 ⇒ null */
function poolTerm(ownerId: string | null, domain: string | null, reason: string): NewTerm | null {
  const pool = drawablePool(ownerId);
  if (pool.length === 0) return null;
  const same = domain ? pool.filter((p) => p.entry.domain === domain) : [];
  const from = same.length > 0 ? same : pool;
  const pick = from[Math.floor(Math.random() * from.length)] ?? from[0];
  if (!pick) return null;
  return {
    term: pick.entry.term,
    definition: pick.entry.definition,
    domain: pick.entry.domain,
    source: 'fallback',
    fallbackReason: reason,
  };
}

/** 要一条新词条：AI 优先（按邻格领域），失手或没模型 ⇒ 词池；都没有 ⇒ null */
async function pickNewTerm(
  ownerId: string | null,
  domain: string | null,
  neighbors: string[],
  signal: AbortSignal | undefined,
): Promise<NewTerm | null> {
  const owned = ownedNames(ownerId);
  const target = routeRole('explain', undefined, ownerId);
  if (!domain || !target?.model || !target.apiKey) {
    return poolTerm(ownerId, domain, domain ? '没有绑定可用的模型，这条来自内置词池' : '这块地周围还没有领域信息，这条来自内置词池');
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: buildPrompt(domain, neighbors, [...owned]) },
    { role: 'user', content: '给这块新地挑三条候选词条。' },
  ];
  const r = await aiJson({
    purpose: 'continent.expand',
    ownerId,
    target,
    messages,
    temperature: AI_TEMPERATURE,
    maxTokens: AI_MAX_TOKENS,
    streamMode: 'once',
    signal,
    parse: parseCandidates,
    repairHint: '只回 {"candidates":[{"term":"…","definition":"…"}]} 这一个 JSON 对象。',
  });
  const fresh = r.ok ? r.value.find((c) => !owned.has(normName(c.term))) : undefined;
  if (!fresh) return poolTerm(ownerId, domain, '模型这次没给出合格的新词条，这条来自内置词池');
  return { term: fresh.term, definition: fresh.definition, domain, source: 'ai' };
}

/**
 * ① 领一块待开拓地。失败一律带人话（ADR-5 禁静默）：不是边界格 / 没词可领 都是 409。
 */
export async function offerExpansion(
  ownerId: string | null,
  cell: { row: number; col: number },
  signal?: AbortSignal,
): Promise<ContinentExpandOffer | ExpandFail> {
  const terms = continentMap(ownerId);
  if (terms.length === 0) return { ok: false, status: 409, error: '大陆还是一片空地——先在「词条」页存第一条词条，边界上才会出现「+」' };
  const pins = loadContinentPins(ownerId);
  const tiles = layoutTiles(terms, pins);
  if (!isFrontierCell(tiles, layoutRadius(terms.length, pins), cell)) {
    return { ok: false, status: 409, error: '这一格不能开拓：只有紧挨着已有地块的空格才有「+」（可能刚被别的开拓占了，刷新看看）' };
  }
  const near = neighborTilesOf(tiles, cell);
  const domain = dominantDomain(near.map((t) => t.term));
  const picked = await pickNewTerm(
    ownerId,
    domain,
    near.map((t) => t.term.term),
    signal,
  );
  if (!picked) {
    return { ok: false, status: 409, error: '暂时领不到新词条：没有可用的模型，内置词池也抽完了——绑定模型，或先在「词条」页手动添加' };
  }
  const now = Date.now();
  prune(now);
  const nonce = randomUUID();
  const offer: ContinentExpandOffer = {
    nonce,
    row: cell.row,
    col: cell.col,
    term: picked.term,
    definition: picked.definition,
    domain: picked.domain,
    source: picked.source,
    ...(picked.fallbackReason ? { fallbackReason: picked.fallbackReason } : {}),
    questions: buildExpandQuestions({ id: `expand:${nonce}`, term: picked.term, definition: picked.definition }, terms, nonce),
    expiresAt: now + EXPAND_OFFER_TTL_MS,
  };
  offers.set(nonce, { owner: ownerForWrite(ownerId), offer });
  return offer;
}

/**
 * ② 落地：重判 → 再验格与名 → 落库 → 钉住。任一步不成都不写库。
 * ★ 成功即删 offer（一份凭证只能落一次地）；判错**不删**（答错可以重答，同弹窗"答错不扣分"的口径）。
 */
export function claimExpansion(ownerId: string | null, nonce: string, answers: unknown): ContinentExpandResult | ExpandFail {
  const now = Date.now();
  prune(now);
  const pending = offers.get(nonce);
  if (!pending || pending.owner !== ownerForWrite(ownerId) || pending.offer.expiresAt <= now) {
    return { ok: false, status: 404, error: '这份开拓任务不存在或已过期（10 分钟）——重新点一次「+」' };
  }
  const { offer } = pending;
  if (!Array.isArray(answers) || answers.length !== offer.questions.length) {
    return { ok: false, status: 400, error: `answers 必须是 ${offer.questions.length} 道题的作答数组` };
  }
  for (let i = 0; i < offer.questions.length; i += 1) {
    const q = offer.questions[i];
    if (q && !gradeAnswer(q, answers[i] as ContinentAnswer)) {
      return { ok: false, status: 409, error: `第 ${i + 1} 题还没答对——再想想` };
    }
  }
  const terms = continentMap(ownerId);
  const pins = loadContinentPins(ownerId);
  if (!isFrontierCell(layoutTiles(terms, pins), layoutRadius(terms.length, pins), offer)) {
    offers.delete(nonce);
    return { ok: false, status: 409, error: '这一格已经不是空地了（刚被别的开拓占了）——换一格再开拓' };
  }
  if (ownedNames(ownerId).has(normName(offer.term))) {
    offers.delete(nonce);
    return { ok: false, status: 409, error: `「${offer.term}」已经在你的词条库里了——换一格再领一条` };
  }
  const saved = saveOneTerm(offer.term, offer.definition, offer.domain, ownerId);
  saveContinentPin(ownerId, { id: saved.id, row: offer.row, col: offer.col });
  offers.delete(nonce);
  return { ok: true, termId: saved.id, term: saved.term, row: offer.row, col: offer.col, source: offer.source };
}
