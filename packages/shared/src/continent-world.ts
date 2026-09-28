/**
 * shared/continent-world — 「玩家亲手开拓」的知识大陆（2026-09-28 起取代「词条自动铺满」）。
 *
 * ── 规则一览 ──────────────────────────────────────────────────────────────────
 * 1. **从零开始**：世界只有出生点一格。玩家站在已开拓地的边缘，点相邻的迷雾格＝花 1 枚「开拓令」
 *    开出一格。开拓令 = 起始 2 枚 + 每条词条 1 枚 + 建筑奖励 − 已花掉的（学得越多，走得越远）。
 * 2. **打怪一次开一片**：迷雾边缘会刷出野怪；击败它 ⇒ 它脚下那格 + 周围最近的几格一起开拓，
 *    不花开拓令（`slayReward`）。
 * 3. **一种题型组合 = 一种怪**：怪种就是题型序列（`speciesKey`），外观由它确定性生成。
 * 4. **越大越难**：难度档 `tierFor(已开拓格数)` 决定同屏怪数、可出现的题型与组合长度、血量倍数。
 * 5. **地块升级**：在有词条的地块上「追问」并答完随后的问答 ⇒ 地块 +1 级（最高 3 级）。
 * 6. **建筑**：若干升级地块按特定形状相连即合成建筑（`detectBuildings`，纯派生不落库），各有效果。
 *
 * ★ 存档（`WorldSave`）只存**玩家做过的事**：开了哪些格、每格几级、绑了哪条词条、打死几只怪。
 *   地貌、刷怪位置、建筑全部由存档 + 种子现算——与 `continent.ts` 头注 1「数值全派生」同一口径。
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
import { biomeSpawns, mixHash, terrainAt } from './continent-terrain.js';

export interface WorldCell {
  /** 绑定的词条 id；`null` = 荒地（打怪开出来、当时没有空闲词条），之后学到新词条会自动补上 */
  t: string | null;
  /** 地块等级 0~3 */
  lv: number;
  /** 开拓次序（第几块；绑定词条与动画都按它排） */
  n: number;
}

export interface WorldSave {
  v: 1;
  seed: number;
  cells: Record<string, WorldCell>;
  /** 击败的野怪数 */
  kills: number;
  /** 已花掉的开拓令 */
  spent: number;
  /** 击败过的怪种（`speciesKey`），图鉴据此点亮 */
  codex: string[];
}

export const TILE_MAX_LEVEL = 3;
export const STARTER_TOKENS = 2;

export function newWorld(seed: number): WorldSave {
  return { v: 1, seed: seed >>> 0, cells: { [cellKey(0, 0)]: { t: null, lv: 0, n: 0 } }, kills: 0, spent: 0, codex: [] };
}

/** 容错解析（坏数据退回新世界，不抛） */
export function parseWorld(raw: string | null | undefined, seed: number): WorldSave {
  if (!raw) return newWorld(seed);
  try {
    const j = JSON.parse(raw) as Partial<WorldSave>;
    if (!j || j.v !== 1 || typeof j.cells !== 'object' || !j.cells) return newWorld(seed);
    const cells: Record<string, WorldCell> = {};
    for (const [k, c] of Object.entries(j.cells)) {
      if (!/^-?\d+,-?\d+$/.test(k) || !c) continue;
      cells[k] = { t: typeof c.t === 'string' ? c.t : null, lv: Math.min(Math.max(Math.trunc(Number(c.lv)) || 0, 0), TILE_MAX_LEVEL), n: Number(c.n) || 0 };
    }
    if (!cells[cellKey(0, 0)]) cells[cellKey(0, 0)] = { t: null, lv: 0, n: 0 };
    return {
      v: 1,
      seed: typeof j.seed === 'number' ? j.seed >>> 0 : seed >>> 0,
      cells,
      kills: Math.max(0, Math.trunc(Number(j.kills)) || 0),
      spent: Math.max(0, Math.trunc(Number(j.spent)) || 0),
      codex: Array.isArray(j.codex) ? j.codex.filter((x): x is string => typeof x === 'string') : [],
    };
  } catch {
    return newWorld(seed);
  }
}

export function parseKey(key: string): { row: number; col: number } {
  const [row = 0, col = 0] = key.split(',').map(Number);
  return { row, col };
}

const DIRS: ReadonlyArray<readonly [number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** 已开拓格数 */
export function exploredCount(save: WorldSave): number {
  return Object.keys(save.cells).length;
}

/**
 * 把空闲词条绑到荒地上（按开拓次序、词条按入库次序）。返回是否有改动。
 * ★ 删掉的词条也在这里解绑（词条没了，地还在，变回荒地、等级保留）。
 */
export function bindTerms(save: WorldSave, orderedTermIds: readonly string[]): boolean {
  const alive = new Set(orderedTermIds);
  const used = new Set<string>();
  let changed = false;
  for (const c of Object.values(save.cells)) {
    if (c.t && (!alive.has(c.t) || used.has(c.t))) {
      c.t = null;
      changed = true;
    }
    if (c.t) used.add(c.t);
  }
  const free = orderedTermIds.filter((id) => !used.has(id));
  const empty = Object.values(save.cells).filter((c) => !c.t).sort((a, b) => a.n - b.n);
  for (let i = 0; i < empty.length && i < free.length; i += 1) {
    empty[i]!.t = free[i]!;
    changed = true;
  }
  return changed;
}

// ── 难度曲线 ────────────────────────────────────────────────────────────────────

const TIER_AT = [0, 8, 20, 40, 70, 110, 160, 230];

/** 难度档 1~8：随已开拓格数上升 */
export function tierFor(explored: number): number {
  let t = 1;
  for (let i = 0; i < TIER_AT.length; i += 1) if (explored >= TIER_AT[i]!) t = i + 1;
  return t;
}

/** 下一档还差几格（满档返回 null） */
export function nextTierAt(explored: number): number | null {
  const t = tierFor(explored);
  return TIER_AT[t] ?? null;
}

export function monsterCapFor(tier: number): number {
  return [2, 3, 4, 6, 7, 9, 11, 13][Math.min(Math.max(tier, 1), 8) - 1]!;
}

/** 这一档能出现的题型（由易到难逐步解锁） */
export function qtypesFor(tier: number): ContinentQType[] {
  const n = Math.min(2 + Math.max(tier - 1, 0), CONTINENT_PLAYABLE_QTYPES.length);
  return CONTINENT_PLAYABLE_QTYPES.slice(0, n) as ContinentQType[];
}

/** 组合最长几型（1 档 1 型；3 档起 2 型；5 档起 3 型） */
export function maxComboFor(tier: number): number {
  return tier >= 5 ? 3 : tier >= 3 ? 2 : 1;
}

/** 血量倍数：每一「轮」＝把组合完整打一遍 */
export function hpRoundsFor(tier: number): number {
  return 1 + Math.floor((Math.max(tier, 1) - 1) / 3);
}

// ── 建筑 ────────────────────────────────────────────────────────────────────────

export type BuildingKind = 'spire' | 'library' | 'tower' | 'camp' | 'stele';

export interface BuildingInfo {
  name: string;
  recipe: string;
  effect: string;
}

export const BUILDING_INFO: Record<BuildingKind, BuildingInfo> = {
  spire: { name: '奥术尖塔', recipe: '十字形 5 块 2 级地，中心为 3 级', effect: '周围 4 格内的怪少打一轮' },
  library: { name: '贤者书库', recipe: '2×2 四块 2 级地', effect: '开拓令 +2' },
  tower: { name: '瞭望塔', recipe: '一字排开 3 块 1 级地', effect: '迷雾视野 +2 格' },
  camp: { name: '篝火营地', recipe: 'L 形 3 块 1 级地', effect: '在附近 4 格内打怪，多开 1 块地' },
  stele: { name: '记忆石碑', recipe: '单独一块 3 级地', effect: '开拓令 +1' },
};

export interface Building {
  kind: BuildingKind;
  cells: Array<{ row: number; col: number }>;
  /** 画建筑用的锚点（占地左上角） */
  anchor: { row: number; col: number };
}

type Pattern = { kind: BuildingKind; offs: Array<[number, number, number]> };

const PATTERNS: Pattern[] = [
  { kind: 'spire', offs: [[0, 0, 3], [-1, 0, 2], [1, 0, 2], [0, -1, 2], [0, 1, 2]] },
  { kind: 'library', offs: [[0, 0, 2], [0, 1, 2], [1, 0, 2], [1, 1, 2]] },
  { kind: 'tower', offs: [[0, 0, 1], [0, 1, 1], [0, 2, 1]] },
  { kind: 'tower', offs: [[0, 0, 1], [1, 0, 1], [2, 0, 1]] },
  { kind: 'camp', offs: [[0, 0, 1], [1, 0, 1], [1, 1, 1]] },
  { kind: 'camp', offs: [[0, 0, 1], [0, 1, 1], [1, 0, 1]] },
  { kind: 'camp', offs: [[0, 0, 1], [0, 1, 1], [1, 1, 1]] },
  { kind: 'camp', offs: [[0, 1, 1], [1, 0, 1], [1, 1, 1]] },
  { kind: 'stele', offs: [[0, 0, 3]] },
];

/** 从升级地块里认出建筑（按优先级贪心，一格只属于一座；确定性：按行列序扫描） */
export function detectBuildings(save: WorldSave): Building[] {
  const lv = new Map<string, number>();
  for (const [k, c] of Object.entries(save.cells)) if (c.lv > 0) lv.set(k, c.lv);
  const order = [...lv.keys()].map(parseKey).sort((a, b) => a.row - b.row || a.col - b.col);
  const used = new Set<string>();
  const out: Building[] = [];
  for (const p of PATTERNS) {
    for (const o of order) {
      const cells = p.offs.map(([dr, dc]) => ({ row: o.row + dr, col: o.col + dc }));
      const ok = p.offs.every(([dr, dc, need]) => {
        const k = cellKey(o.row + dr, o.col + dc);
        return !used.has(k) && (lv.get(k) ?? 0) >= need;
      });
      if (!ok) continue;
      for (const c of cells) used.add(cellKey(c.row, c.col));
      const minR = Math.min(...cells.map((c) => c.row));
      const minC = Math.min(...cells.map((c) => c.col));
      out.push({ kind: p.kind, cells, anchor: { row: minR, col: minC } });
    }
  }
  return out;
}

/** 开拓令余额 */
export function tokensLeft(save: WorldSave, termCount: number, buildings: readonly Building[]): number {
  const bonus = buildings.reduce((s, b) => s + (b.kind === 'library' ? 2 : b.kind === 'stele' ? 1 : 0), 0);
  return Math.max(STARTER_TOKENS + termCount + bonus - save.spent, 0);
}

/** 迷雾视野（已开拓地外能看清几格地貌） */
export function visionFor(buildings: readonly Building[]): number {
  return 2 + (buildings.some((b) => b.kind === 'tower') ? 2 : 0);
}

// ── 迷雾边缘与野怪 ──────────────────────────────────────────────────────────────

/** 迷雾边缘：与已开拓地正相邻、自己还没开拓的格（按行列序） */
export function frontierCells(save: WorldSave): Array<{ row: number; col: number }> {
  const seen = new Set<string>();
  const out: Array<{ row: number; col: number }> = [];
  for (const k of Object.keys(save.cells)) {
    const { row, col } = parseKey(k);
    for (const [dr, dc] of DIRS) {
      const nk = cellKey(row + dr, col + dc);
      if (save.cells[nk] || seen.has(nk)) continue;
      seen.add(nk);
      out.push({ row: row + dr, col: col + dc });
    }
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

export function isFrontier(save: WorldSave, row: number, col: number): boolean {
  if (save.cells[cellKey(row, col)]) return false;
  return DIRS.some(([dr, dc]) => !!save.cells[cellKey(row + dr, col + dc)]);
}

export interface WildMonster {
  row: number;
  col: number;
  /** 怪种（题型序列）＝一种组合一种怪 */
  species: ContinentQType[];
  /** 总血量＝题数（组合长度 × 轮数） */
  hp: number;
  /** 出题用的词条 */
  termId: string;
  tier: number;
}

function near(a: { row: number; col: number }, b: { row: number; col: number }, d: number): boolean {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) <= d;
}

/**
 * 当前的野怪（纯派生）。刷怪点 = 迷雾边缘里按 `hash(seed|day|格)` 排名靠前的格，彼此不贴脸。
 * ★ 位置不依赖击杀数 ⇒ 打死一只时其他怪不挪窝，只在别处补刷一只（看得见「刷怪」）。
 * ★ 按天（`day`）换一批：隔夜回来怪会游荡到别处。没有词条 ⇒ 出不了题 ⇒ 不刷。
 */
export function wildMonsters(save: WorldSave, termIds: readonly string[], day: number): WildMonster[] {
  if (termIds.length === 0) return [];
  const explored = exploredCount(save);
  const tier = tierFor(explored);
  const buildings = detectBuildings(save);
  const spires = buildings.filter((b) => b.kind === 'spire').map((b) => b.cells[0]!);
  const hero = { row: 0, col: 0 };
  const cands = frontierCells(save)
    .filter((c) => biomeSpawns(terrainAt(save.seed, c.row, c.col).biome))
    // 开局两格内不刷（第一步总得能先走一走）
    .filter((c) => explored > 3 || !near(c, hero, 1))
    .map((c) => ({ c, k: mixHash(`${save.seed}|spawn|${day}|${c.row},${c.col}`) }))
    .sort((a, b) => a.k - b.k);
  const cap = monsterCapFor(tier);
  const picked: Array<{ row: number; col: number }> = [];
  for (const { c } of cands) {
    if (picked.length >= cap) break;
    if (picked.some((p) => near(p, c, 1))) continue;
    picked.push(c);
  }
  const types = qtypesFor(tier);
  const maxLen = maxComboFor(tier);
  return picked.map((c) => {
    const h = mixHash(`${save.seed}|mon|${day}|${c.row},${c.col}`);
    const len = 1 + (h % maxLen);
    const species: ContinentQType[] = [];
    for (let i = 0; i < len; i += 1) species.push(types[mixHash(`${h}#${i}`) % types.length]!);
    const guarded = spires.some((s) => near(s, c, 4));
    const rounds = Math.max(hpRoundsFor(tier) - (guarded ? 1 : 0), 1);
    return { row: c.row, col: c.col, species, hp: len * rounds, termId: termIds[h % termIds.length]!, tier };
  });
}

/** 击败野怪后一次开拓哪些格：怪脚下 + 由近及远的迷雾格（同距按哈希），共 `2 + ceil(tier/2)` 格 */
export function slayReward(save: WorldSave, at: { row: number; col: number }): Array<{ row: number; col: number }> {
  const tier = tierFor(exploredCount(save));
  const camp = detectBuildings(save).some((b) => b.kind === 'camp' && b.cells.some((c) => near(c, at, 4)));
  const want = 2 + Math.ceil(tier / 2) + (camp ? 1 : 0);
  const out = [at];
  const taken = new Set([cellKey(at.row, at.col)]);
  for (let r = 1; r <= 4 && out.length < want; r += 1) {
    const ring: Array<{ row: number; col: number; k: number }> = [];
    for (let dr = -r; dr <= r; dr += 1) {
      for (const dc of new Set([r - Math.abs(dr), -(r - Math.abs(dr))])) {
        const row = at.row + dr;
        const col = at.col + dc;
        const k = cellKey(row, col);
        if (save.cells[k] || taken.has(k)) continue;
        if (terrainAt(save.seed, row, col).biome === 'deep') continue;
        ring.push({ row, col, k: mixHash(`${save.seed}|reward|${k}`) });
      }
    }
    ring.sort((a, b) => a.k - b.k);
    for (const c of ring) {
      if (out.length >= want) break;
      out.push({ row: c.row, col: c.col });
      taken.add(cellKey(c.row, c.col));
    }
  }
  return out;
}

/** 把一批格记为已开拓（已开过的跳过）；返回真正新开的格 */
export function exploreCells(save: WorldSave, cells: ReadonlyArray<{ row: number; col: number }>): Array<{ row: number; col: number }> {
  let n = Math.max(-1, ...Object.values(save.cells).map((c) => c.n)) + 1;
  const fresh: Array<{ row: number; col: number }> = [];
  for (const c of cells) {
    const k = cellKey(c.row, c.col);
    if (save.cells[k]) continue;
    save.cells[k] = { t: null, lv: 0, n: n++ };
    fresh.push(c);
  }
  return fresh;
}

/** 追问升级要答几道题（1→2 级更难） */
export function delveQuizSize(lv: number): number {
  return 2 + Math.min(Math.max(lv, 0), 2);
}

/** 测试与迁移辅助：把已有的「词条铺格」结果整个视为已开拓（生产路径不用） */
export function worldFromPlacements(seed: number, placed: ReadonlyArray<{ id: string; row: number; col: number }>): WorldSave {
  const w = newWorld(seed);
  placed.forEach((p, i) => {
    w.cells[cellKey(p.row, p.col)] = { t: p.id, lv: 0, n: i };
  });
  return w;
}

/**
 * 野怪的整套题：第 i 题的题型 = `species[i % 组合长度]`；第一轮考借来的那条词条，
 * 之后每一轮换一条词条（按稳定哈希从池子里取）——血厚的怪考的是一片知识，不是同一题反复问。
 */
export function buildSpeciesQuestions(
  term: ContinentTermLike,
  species: readonly ContinentQType[],
  hp: number,
  pool: readonly ContinentTermLike[],
): ContinentQuestion[] {
  const len = Math.max(species.length, 1);
  const out: ContinentQuestion[] = [];
  for (let i = 0; i < Math.max(hp, 1); i += 1) {
    const round = Math.floor(i / len);
    const pick = round === 0 || pool.length === 0 ? term : pool[continentHash(`${term.id}|round${round}`) % pool.length]!;
    const seed = `${pick.id}#w${i}`;
    const type = species[i % len] ?? 'judge';
    out.push(
      buildQuestion(type, pick, pool, seed) ??
        buildQuestion('fill', pick, pool, seed) ?? { type: 'fill', prompt: `根据释义写出词条：${pick.definition}`, answer: pick.term },
    );
  }
  return out;
}
