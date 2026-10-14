/** continent-monsters: split domain module; compatible exports remain at continent.ts. */
import { CONTINENT_MAX_LEVEL } from './continent-core.js';
import type { ContinentQType } from './continent-core.js';
import { CONTINENT_PLAYABLE_QTYPES } from './continent-core.js';
import { continentHash } from './continent-core.js';
import type { ReviewStatus } from './ebbinghaus.js';
import type { ContinentCodexTerm } from './continent-core.js';
import { WORLD_MIN_RADIUS } from './continent-core.js';
import { cellKey } from './continent-core.js';

/** 等级 = 题数 = 血量 = `clamp(1 + floor(stage/2), 1, 3)`（stage 0/1→1、2/3→2、4+→3） */
export function monsterLevel(stage: number): number {
  const s = Math.max(0, Math.trunc(stage) || 0);
  return Math.min(1 + Math.floor(s / 2), CONTINENT_MAX_LEVEL);
}

/** 怪种 = 长度 level 的题型序列；每一滴血对应一道题，序列**有序**（图鉴据此定槽） */
export function speciesTypes(id: string, level: number): ContinentQType[] {
  const n = CONTINENT_PLAYABLE_QTYPES.length;
  const out: ContinentQType[] = [];
  for (let i = 0; i < level; i += 1) {
    out.push(CONTINENT_PLAYABLE_QTYPES[continentHash(`${id}#${i}`) % n] ?? 'judge');
  }
  return out;
}

/** 怪种 key（图鉴/调试用的可读标识，如 `judge+match`） */
export function speciesKey(types: readonly ContinentQType[]): string {
  return types.join('+');
}

/** 图鉴槽总数 = Σ |可用题型|^L (L=1..3) = 5+25+125 = 155（五型全部可用时） */
export const CONTINENT_CODEX_SLOTS = Array.from({ length: CONTINENT_MAX_LEVEL }, (_, i) =>
  Math.pow(CONTINENT_PLAYABLE_QTYPES.length, i + 1),
).reduce((a, b) => a + b, 0);

/**
 * 题型序列 → 图鉴槽下标（1~3 级各占一段，段内按 |可用题型| 进制编码）。
 * ★ 注意序列是**有序**的：`judge+match` 与 `match+judge` 是两个不同的槽。
 */
export function codexSlot(types: readonly ContinentQType[]): number {
  const base = CONTINENT_PLAYABLE_QTYPES.length;
  let slot = 0;
  for (let l = 1; l < types.length; l += 1) slot += Math.pow(base, l);
  for (let i = 0; i < types.length; i += 1) {
    const idx = CONTINENT_PLAYABLE_QTYPES.indexOf(types[i] ?? 'judge');
    slot += (idx < 0 ? 0 : idx) * Math.pow(base, types.length - 1 - i);
  }
  return slot;
}

/** 槽下标 → 题型序列（`codexSlot` 的逆；图鉴面板据此显示每格是什么组合） */
export function codexSlotTypes(slot: number): ContinentQType[] {
  const base = CONTINENT_PLAYABLE_QTYPES.length;
  let rest = Math.max(0, Math.trunc(slot) || 0);
  let level = 1;
  while (level <= CONTINENT_MAX_LEVEL && rest >= Math.pow(base, level)) {
    rest -= Math.pow(base, level);
    level += 1;
  }
  const types: ContinentQType[] = [];
  for (let i = level - 1; i >= 0; i -= 1) {
    const p = Math.pow(base, i);
    const idx = Math.floor(rest / p);
    rest -= idx * p;
    types.push(CONTINENT_PLAYABLE_QTYPES[idx] ?? 'judge');
  }
  return types;
}

/** 该格该不该冒怪（头注 2）：**在复习范围内** 且 到期/逾期 */
export function monsterOccupies(status: ReviewStatus, inScope: boolean): boolean {
  return inScope && (status === 'due' || status === 'overdue');
}

/** 「已发现」= 有复习记录（`last_reviewed_at` 非空，或阶段已推进过）——纯派生、零存储 */
export function isDiscovered(reviewStage: number, lastReviewedAt: string | null): boolean {
  return (lastReviewedAt ?? '') !== '' || (Math.trunc(reviewStage) || 0) > 0;
}

/**
 * 一条词条贡献的图鉴槽。
 * ★ 取「当前等级及其**全部前缀**」而不是只取当前等级：怪升级时它的题型序列是**长出**来的
 *   （`speciesTypes` 的第 i 位只依赖 `${id}#${i}`，与 level 无关），前缀槽因此天然单调
 *   ——只取当前等级的话，词条一升级，上一等级的图鉴格会**凭空消失**（收集图鉴最忌这个）。
 */
export function codexSlotsForTerm(id: string, stage: number, discovered: boolean): number[] {
  if (!discovered) return [];
  const out: number[] = [];
  for (let l = 1; l <= monsterLevel(stage); l += 1) out.push(codexSlot(speciesTypes(id, l)));
  return out;
}

/** 全库图鉴进度：返回已发现的槽集合（UI 用 `has(slot)` 判断亮不亮） */
export function codexDiscovered(terms: readonly ContinentCodexTerm[]): Set<number> {
  const found = new Set<number>();
  for (const t of terms) {
    for (const slot of codexSlotsForTerm(t.id, t.review_stage, isDiscovered(t.review_stage, t.last_reviewed_at))) {
      found.add(slot);
    }
  }
  return found;
}

// ── 领地扩散（口径 4）──────────────────────────────────────────────────────────
// ★ 这一段的全部意义：把 demo 里「靠定时器 + 随机」的扩张，换成「靠已逾期天数 + 确定性贪心」。
//   于是它零存储、零定时器、跨端一致，且用户隔几天回来会看到领地真的变大了。

/** 单只怪的领地上限（含本体）。★ 照抄 demo 的 `MAX_LANDS = 6`——不封顶 4 只怪就能吃光 14×10 */
export const CONTINENT_MAX_LANDS = 6;

/** 每逾期几天多占一格（demo：22s 扩张一次 / 12s 一天 ⇒ 约两天一格） */
export const CONTINENT_LAND_DAY_STEP = 2;

/** 逾期天数 → 领地格数（含本体），`clamp(1 + floor(days/2), 1, 6)` */
export function landCountFor(overdueDays: number): number {
  const d = Math.max(0, Math.trunc(overdueDays) || 0);
  return Math.min(1 + Math.floor(d / CONTINENT_LAND_DAY_STEP), CONTINENT_MAX_LANDS);
}

/** 扩散的输入：只需要「本体在哪 + 逾期几天」 */
export interface ContinentLandSource {
  id: string;
  row: number;
  col: number;
  overdueDays: number;
}

/** 扩散的结果 */
export interface ContinentLands {
  /** 本体格 key → 怪 id */
  bodies: Map<string, string>;
  /** 领地格 key → 怪 id（**不含**本体那一格） */
  lands: Map<string, string>;
  /** 怪 id → 实际领地格数（含本体）；`landCountFor` 是「想要」，这是「拿到」 */
  countOf: Map<string, number>;
}

const LAND_DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

export interface SpreadLandsOptions {
  /**
   * 世界半径（世界为 `[-radius, radius]²`）。★ 由调用方给（它知道自己的世界多大）；
   * 不给 ⇒ 用 `WORLD_MIN_RADIUS`（小世界），**绝不**默认成一个"看起来够大"的数——
   * 默认值骗人比报错难查（旧版的 `cols/rows` 默认 14×10 就是这类隐患）。
   */
  radius?: number;
  /**
   * 谁都吞不了的格（**用英雄脚下的格**：怪不该把玩家站的地方占掉）。
   * ★ 这是「英雄位置」这个纯前端状态进入纯函数的**唯一**入口——函数本身仍然无状态。
   */
  blocked?: ReadonlySet<string>;
  /**
   * 「词条格」集合（地图上真实有词条的格）。给定时按 demo 口径**词条格优先、荒地次之**；
   * 不给则所有格等价。★ 不给也不会错，只是视觉上会去啃没铺过的荒地。
   */
  termCells?: ReadonlySet<string>;
}

/**
 * 确定性领地扩散：**先占先得**（按 `sources` 的次序串行处理），词条格优先，逐格哈希定序。
 * ★ `sources` 的次序必须稳定（调用方按地图铺格序传），否则「两只怪抢同一格」的归属会漂。
 * ★ 同一格被两只怪的本体要求时**只认第一只**（正常数据不会发生：一格一条词条）。
 */
export function spreadLands(
  sources: readonly ContinentLandSource[],
  opts: SpreadLandsOptions = {},
): ContinentLands {
  const radius = Math.max(Math.trunc(opts.radius ?? WORLD_MIN_RADIUS) || 0, 0);
  const blocked = opts.blocked ?? new Set<string>();
  const termCells = opts.termCells;
  const bodies = new Map<string, string>();
  const lands = new Map<string, string>();
  const countOf = new Map<string, number>();
  const taken = new Set<string>();

  // 1) 本体先全部落位：领地只能从「已被确认的本体」往外长
  for (const s of sources) {
    const key = cellKey(s.row, s.col);
    if (taken.has(key)) continue;
    bodies.set(key, s.id);
    taken.add(key);
  }

  // 2) 逐只怪按需吞格（串行 ⇒ 不会互抢）
  for (const s of sources) {
    const own = cellKey(s.row, s.col);
    if (bodies.get(own) !== s.id) continue; // 本体被前一格占了的那只：不当扩张源
    const want = landCountFor(s.overdueDays);
    const owned = new Set<string>([own]);
    let got = 1;
    // ★ **一圈一圈地长**（每次只吞一格，吞完再重新看边界），而不是只在第一圈里挑：
    //   本体只有 4 个正相邻格 ⇒ 只挑一圈的话领地永远超不过 5 格，`CONTINENT_MAX_LANDS = 6`
    //   就成了永远够不到的常数。逐格外扩才让"逾期越久、地越大"真的看得出来。
    while (got < want) {
      const cands: Array<{ key: string; pri: number; rank: number }> = [];
      for (const key of owned) {
        const [br = 0, bc = 0] = key.split(',').map(Number);
        for (const [dr, dc] of LAND_DIRS) {
          const row = br + dr;
          const col = bc + dc;
          if (row < -radius || row > radius || col < -radius || col > radius) continue;
          const nk = cellKey(row, col);
          if (taken.has(nk) || blocked.has(nk) || owned.has(nk)) continue;
          if (cands.some((c) => c.key === nk)) continue; // 同一格被两个已有格邻到：只算一次
          cands.push({
            key: nk,
            pri: termCells && !termCells.has(nk) ? 1 : 0,
            rank: continentHash(`${s.id}#land|${nk}`),
          });
        }
      }
      if (!cands.length) break; // 被本体/其他怪/边界围死：拿到多少算多少
      cands.sort((a, b) => a.pri - b.pri || a.rank - b.rank || (a.key < b.key ? -1 : 1));
      const next = cands[0];
      if (!next) break;
      lands.set(next.key, s.id);
      owned.add(next.key);
      taken.add(next.key);
      got += 1;
    }
    countOf.set(s.id, got);
  }

  return { bodies, lands, countOf };
}
