/**
 * shared/drill — 「等待时刷词」（百词斩式）的**纯口径**（契约 `docs/WAIT-DRILL-SPEC.md`）。
 *
 * 场景：用户把问题发给 AI 之后有一段什么都做不了的等待；这段时间弹出一张张词条卡让人刷——
 * 看词选义 / 看义选词 / 拼写，答对闪过、答错翻出详情、「斩」掉认识的词。回复到了就切回去。
 *
 * ★ 为什么放 shared：题面与判分**必须**与知识大陆同一份归一化（`normText`）、同一份哈希
 *   （`continentHash`），否则同一条词条在大陆上判对、在刷词里判错。本文件只算不存、零 IO。
 * ★ 出题池不够时用 `CHEST_POOL_SEED` 当干扰项——新用户只有一两条词条也能出四选一，
 *   而不是退化成"两个选项猜一个"。干扰项永远不是正确答案的同义改写：靠**释义不同**过滤。
 * ★ 队列排序是**派生量**：按「日历日 × 词条 id」哈希，当天恒同、跨日换序（与野怪同手法）；
 *   到期词条（`monsterOccupies` 口径＝大陆上的怪）永远排最前——它们答对算复习打卡，最值钱。
 */
import { CHEST_POOL_SEED } from './chest-pool.js';
import { continentHash, monsterOccupies, normText } from './continent.js';
import type { ReviewStatus } from './ebbinghaus.js';

export type DrillKind = 'meaning' | 'reverse' | 'spell';

export const DRILL_KIND_LABEL: Record<DrillKind, string> = {
  meaning: '看词选义',
  reverse: '看义选词',
  spell: '拼写',
};

/** 四选一（百词斩口径） */
export const DRILL_OPTIONS = 4;
/** 答错的词条隔几张再来（太近像惩罚，太远忘了刚看的答案） */
export const DRILL_REQUEUE_GAP = 3;
/** 一次向服务端要几条新词 */
export const DRILL_NEW_TERMS = 3;
export const DRILL_TERM_MAX = 40;
export const DRILL_DEF_MAX = 200;
/** 发送后等多久还没回完才弹（秒回的短问题不打扰） */
export const DRILL_OPEN_DELAY_MS = 2000;

export interface DrillTermLike {
  id: string;
  term: string;
  definition: string;
  domain: string;
  aliases?: readonly string[];
}

/** 来路：到期（答对＝打卡）/ 词库（只统计）/ 新词（AI 或词池，答对后可收入词库） */
export type DrillOrigin = 'due' | 'library' | 'new';

export interface DrillCard {
  kind: DrillKind;
  origin: DrillOrigin;
  termId: string;
  term: string;
  definition: string;
  domain: string;
  /** 题面：`meaning` 出词条、`reverse` / `spell` 出释义 */
  prompt: string;
  /** 选项：`meaning` 为释义、`reverse` 为词条；`spell` 为空 */
  options: string[];
  /** 正确选项下标；`spell` 为 -1 */
  answerIndex: number;
  /** 拼写提示：首字 + 其余用「＿」占位（「闭＿」） */
  hint: string;
}

/**
 * 题型节拍：每 4 张里 1 张拼写（固定在第 4 张），其余 3 张里 1 张看义选词——
 * 落在哪一张由 `seed` 定，避免"每组第二张必是反向"这种可预测的节奏。
 */
export function drillKindAt(index: number, seed: string): DrillKind {
  const i = Math.max(0, Math.trunc(index));
  if (i % 4 === 3) return 'spell';
  const slot = continentHash(`${seed}|kind|${Math.floor(i / 4)}`) % 3;
  return i % 4 === slot ? 'reverse' : 'meaning';
}

/** 冷启动词池以"seed:<i>"为 id 参与干扰项；永远不会成为题目本身 */
export const DRILL_SEED_POOL: readonly DrillTermLike[] = CHEST_POOL_SEED.map((e, i) => ({
  id: `seed:${i}`,
  term: e.term,
  definition: e.definition,
  domain: e.domain,
  aliases: e.aliases,
}));

function stableOrder<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => continentHash(key(a)) - continentHash(key(b)));
}

/**
 * 挑 n 条干扰项：同领域优先（更像、更练），不够再拿别的领域补；
 * 与正确答案**释义相同或词条同名**的一律不要（同义词条会造出两个正确选项）。
 */
export function pickDistractors(
  target: DrillTermLike,
  pool: readonly DrillTermLike[],
  seed: string,
  n: number,
  field: 'definition' | 'term',
): DrillTermLike[] {
  const selfTerm = normText(target.term);
  const selfDef = normText(target.definition);
  const seen = new Set<string>();
  const eligible = pool.filter((t) => {
    if (t.id === target.id) return false;
    const key = normText(t[field]);
    if (!key || seen.has(key)) return false;
    if (normText(t.term) === selfTerm || normText(t.definition) === selfDef) return false;
    seen.add(key);
    return true;
  });
  const ranked = eligible
    .map((t) => ({ t, k: (t.domain === target.domain ? 0 : 1) * 0x100000000 + continentHash(`${seed}|${t.id}`) }))
    .sort((a, b) => (a.k === b.k ? (a.t.id < b.t.id ? -1 : 1) : a.k - b.k));
  return ranked.slice(0, n).map((x) => x.t);
}

/** 拼写提示：首字露出、其余「＿」；单字词条不给提示（露出即答案） */
export function spellHint(term: string): string {
  const chars = [...term.trim()];
  if (chars.length <= 1) return '＿';
  return chars[0] + '＿'.repeat(chars.length - 1);
}

/**
 * 造一张卡。干扰项池 = 用户词库 ∪ 冷启动词池；不足 3 条干扰项 ⇒ 退成拼写（而不是出一道两选一）。
 */
export function buildDrillCard(
  kind: DrillKind,
  term: DrillTermLike,
  pool: readonly DrillTermLike[],
  origin: DrillOrigin,
  seed: string = term.id,
): DrillCard {
  const base = { origin, termId: term.id, term: term.term, definition: term.definition, domain: term.domain };
  const full = [...pool, ...DRILL_SEED_POOL];
  if (kind !== 'spell') {
    const field = kind === 'meaning' ? 'definition' : 'term';
    const wrongs = pickDistractors(term, full, `${seed}|${kind}`, DRILL_OPTIONS - 1, field).map((t) => t[field]);
    if (wrongs.length === DRILL_OPTIONS - 1) {
      const right = term[field];
      const options = stableOrder([right, ...wrongs], (o) => `${seed}|${kind}|opt|${o}`);
      return {
        ...base,
        kind,
        prompt: kind === 'meaning' ? term.term : term.definition,
        options,
        answerIndex: options.indexOf(right),
        hint: '',
      };
    }
  }
  return { ...base, kind: 'spell', prompt: term.definition, options: [], answerIndex: -1, hint: spellHint(term.term) };
}

/** 判分（全仓唯一入口）：选择题比下标，拼写比归一化文本（正名或任一别名皆可） */
export function gradeDrill(card: DrillCard, answer: number | string, aliases: readonly string[] = []): boolean {
  if (card.kind === 'spell') {
    if (typeof answer !== 'string') return false;
    const a = normText(answer);
    if (!a) return false;
    return a === normText(card.term) || aliases.some((x) => normText(x) === a);
  }
  return typeof answer === 'number' && answer === card.answerIndex;
}

export interface DrillQueueTerm extends DrillTermLike {
  status: ReviewStatus;
  inScope: boolean;
}

export interface DrillQueueItem {
  term: DrillTermLike;
  origin: 'due' | 'library';
}

/**
 * 排队：到期（＝大陆上的怪）在前，其余在后；两段内部各按「日历日 × id」哈希——当天恒同。
 * `exclude` 是今天「斩」掉的（认识，不用再出）。
 */
export function orderDrillQueue(
  terms: readonly DrillQueueTerm[],
  dayKey: string,
  exclude: ReadonlySet<string> = new Set(),
): DrillQueueItem[] {
  const rank = (t: DrillQueueTerm): number => continentHash(`${dayKey}|drill|${t.id}`);
  const live = terms.filter((t) => !exclude.has(t.id) && t.term.trim() !== '' && t.definition.trim() !== '');
  const due = live.filter((t) => monsterOccupies(t.status, t.inScope));
  const rest = live.filter((t) => !monsterOccupies(t.status, t.inScope));
  const byRank = (a: DrillQueueTerm, b: DrillQueueTerm): number => rank(a) - rank(b) || (a.id < b.id ? -1 : 1);
  return [
    ...[...due].sort(byRank).map((term) => ({ term, origin: 'due' as const })),
    ...[...rest].sort(byRank).map((term) => ({ term, origin: 'library' as const })),
  ];
}

/** 答错的卡插回队列的位置：隔 `gap` 张；队列短于 gap 时排到末尾 */
export function requeueIndex(queueLength: number, gap: number = DRILL_REQUEUE_GAP): number {
  return Math.max(0, Math.min(queueLength, gap));
}

/** 连击里程碑（5、10、15…）：大特效 + 连击音 */
export function isComboMilestone(combo: number): boolean {
  return combo > 0 && combo % 5 === 0;
}

// ── REST 契约（`/api/drill`）─────────────────────────────────────────────────

/** 一条待学的新词：`candidateId` 为空表示来自内置词池（不是模型出的，UI 必须如实标） */
export interface DrillNewTerm {
  candidateId: string | null;
  term: string;
  definition: string;
  domain: string;
  source: 'ai' | 'fallback';
  fallbackReason?: string;
}

/** `POST /api/drill/new-terms` 的响应；`mode` 说明这批从哪来：先消化上次没定夺的候选，再让模型出，没模型退词池 */
export interface DrillNewTermsResult {
  mode: 'pending' | 'ai' | 'fallback' | 'empty';
  items: DrillNewTerm[];
  fallbackReason?: string;
}

/** `POST /api/drill/keep` 的响应：词条已在库里（新建或既有），候选（若有）已标通过 */
export interface DrillKeepResult {
  ok: true;
  termId: string;
  term: string;
  candidateApproved: boolean;
}
