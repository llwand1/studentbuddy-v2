/**
 * shared/continent-expand — 知识大陆**开拓地块**的纯口径（2026-09-29，契约 `docs/KNOWLEDGE-CONTINENT-SPEC.md` §「开拓」）。
 *
 * 玩法一句话：大陆边界上每一格空地都有一个「+」；点它 ⇒ 领一条**新词条**（AI 按邻格领域生成，
 * 没模型就退到内置词池）⇒ 先看释义再答两道随机题型 ⇒ 全对 ⇒ 新地块**就长在点的那一格**。
 *
 * 本文件只放**两端都要算的纯函数**（与 `continent.ts` 同一条纪律：不碰 IO、不读时钟、不含随机）：
 *   · 哪些格是「边界空格」（`frontierCells`）——前端画「+」、服务端校验"这格能不能开拓"必须同一个答案，
 *     否则就是「图上有 +、点了 409」的静默死路；
 *   · 邻格的主导领域（`dominantDomain`）——服务端拿它去要 AI 出词，前端拿它写提示；
 *   · 开拓题组（`buildExpandQuestions`）——题型由**服务端的一次性 nonce** 定（每次点 + 都不一样，
 *     这正是需求里的"随机"），而 nonce 一旦给定，两端算出的题**一字不差**（服务端凭它重新判分）。
 *
 * ★ 出题仍走 `continent.ts` 的本地出题器：新词条的干扰项从用户自己的词条里取，池子小就退 `fill`。
 * ★ 这里**不**决定新词条是什么——那是服务端（`learning/continent-expand.ts`）的事，且必须如实标
 *   `source: 'ai' | 'fallback'`（降级可以，假装没降级不行，同 `npc-genesis.ts`）。
 */
import {
  CONTINENT_PLAYABLE_QTYPES,
  buildQuestion,
  cellKey,
  continentHash,
  type ContinentQType,
  type ContinentQuestion,
  type ContinentTermLike,
} from './continent.js';

/** 开拓一块地要答几道题（两道：够"随机题型"看得出变化，又不至于把新词条问成考试） */
export const CONTINENT_EXPAND_QUESTIONS = 2;

/** 新词条的字数上限（服务端归一化用；AI 偶尔会把释义写成一段讲解，超了整条作废走降级） */
export const CONTINENT_EXPAND_TERM_MAX = 40;
export const CONTINENT_EXPAND_DEF_MAX = 200;

/** 一枚「+」：世界坐标（可为负） */
export interface ContinentFrontierCell {
  row: number;
  col: number;
}

const FOUR_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * 边界空格 = 世界内、没铺词条、且**四邻里至少有一格词条**的格。
 * ★ 按 `(row, col)` 排序输出：两端各算一次也要同序（前端按序画，服务端只做 `some`）。
 * ★ `blocked` 给调用方排除"看起来不空"的格（前端传怪的荒地领地——那格画着红边，再叠一个 + 就是两种语义打架）。
 *   服务端**不传**：它只需要判"这格能不能落新词条"，领地是随时间消长的派生量，不该成为落地的闸门。
 */
export function frontierCells(
  tiles: ReadonlyArray<{ row: number; col: number }>,
  radius: number,
  blocked?: ReadonlySet<string>,
): ContinentFrontierCell[] {
  const r = Math.max(0, Math.trunc(radius) || 0);
  const taken = new Set(tiles.map((t) => cellKey(t.row, t.col)));
  const seen = new Set<string>();
  const out: ContinentFrontierCell[] = [];
  for (const t of tiles) {
    for (const [dr, dc] of FOUR_DIRS) {
      const row = t.row + dr;
      const col = t.col + dc;
      if (row < -r || row > r || col < -r || col > r) continue;
      const key = cellKey(row, col);
      if (taken.has(key) || seen.has(key) || blocked?.has(key)) continue;
      seen.add(key);
      out.push({ row, col });
    }
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

/** 某格是不是边界空格（服务端校验用；与 `frontierCells` 同一份判断标准） */
export function isFrontierCell(
  tiles: ReadonlyArray<{ row: number; col: number }>,
  radius: number,
  cell: { row: number; col: number },
): boolean {
  return frontierCells(tiles, radius).some((c) => c.row === cell.row && c.col === cell.col);
}

/** 四邻里的词条格（新词条的"邻居"——领域与干扰项都从这里起步） */
export function neighborTilesOf<T extends { row: number; col: number }>(
  tiles: readonly T[],
  cell: { row: number; col: number },
): T[] {
  return tiles.filter((t) => Math.abs(t.row - cell.row) + Math.abs(t.col - cell.col) === 1);
}

/**
 * 邻格的主导领域：出现最多的那个；打平取**先出现的**（`tiles` 是铺格序 ⇒ 更早入库的领域优先）。
 * 没有邻居（不该发生：边界格定义就是"至少一格邻居"）⇒ `null`，调用方按"没有领域"处理。
 */
export function dominantDomain(neighbors: ReadonlyArray<{ domain: string }>): string | null {
  const count = new Map<string, number>();
  for (const n of neighbors) {
    const d = n.domain.trim();
    if (!d) continue;
    count.set(d, (count.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [d, n] of count) {
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/**
 * 开拓题的题型序列：由 `seed`（服务端 nonce）稳定派生，**两道题型不重复**。
 * ★ 为什么不重复：只有两道，出成两道判断题就看不出"随机题型"这件事。
 */
export function expandQuestionTypes(seed: string, count = CONTINENT_EXPAND_QUESTIONS): ContinentQType[] {
  const pool = [...CONTINENT_PLAYABLE_QTYPES];
  const out: ContinentQType[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    const idx = continentHash(`expand|${seed}|${i}`) % pool.length;
    const picked = pool.splice(idx, 1)[0];
    if (picked) out.push(picked);
  }
  return out;
}

/**
 * 开拓题组：新词条 + 用户现有词条当干扰项池。某型建不出（池子太小）⇒ 退 `fill`（永远建得出）。
 * ★ `seed` 必须是服务端给的 nonce：题型与选项乱序都由它定 ⇒ 服务端凭同一个 nonce 重建题组判分。
 */
export function buildExpandQuestions(
  term: ContinentTermLike,
  pool: readonly ContinentTermLike[],
  seed: string,
): ContinentQuestion[] {
  return expandQuestionTypes(seed).map((type, i) => {
    const qSeed = `${seed}#e${i}`;
    return (
      buildQuestion(type, term, pool, qSeed) ??
      buildQuestion('fill', term, pool, qSeed) ?? {
        type: 'fill' as const,
        prompt: `根据释义写出词条：${term.definition}`,
        answer: term.term,
      }
    );
  });
}

// ── HTTP 形状（`POST /api/continent/expand/offer` 与 `/claim`）──────────────────────────

/** 领到的一块待开拓地：服务端出的词 + 题；`nonce` 是这次开拓的唯一凭证（10 分钟内有效） */
export interface ContinentExpandOffer {
  nonce: string;
  row: number;
  col: number;
  term: string;
  definition: string;
  domain: string;
  /** `ai` = 模型按邻格领域现生成；`fallback` = 没模型/模型失手，取自内置词池（UI 必须如实说） */
  source: 'ai' | 'fallback';
  /** 为什么走了降级（`source === 'fallback'` 时给一句人话；AI 成功时为空） */
  fallbackReason?: string;
  questions: ContinentQuestion[];
  /** 有效期（epoch ms）；过期要重新点「+」 */
  expiresAt: number;
}

/** 开拓成功：新词条已落库、并钉在那一格 */
export interface ContinentExpandResult {
  ok: true;
  termId: string;
  term: string;
  row: number;
  col: number;
  source: 'ai' | 'fallback';
}
