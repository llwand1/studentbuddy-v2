/**
 * features/continent/continent-view — 知识大陆的**视图模型**（纯函数，无 DOM / 无 canvas）。
 *
 * ★ 2026-09-28 起地图是**玩家开拓**的（规则见 `shared/continent-world.ts`）：
 *   - 已开拓的格 ⇒ `tiles`（有词条落户的带词条信息；荒地只有地貌）；
 *   - 迷雾边缘 ⇒ `frontier`（点它开拓，花 1 枚开拓令）；
 *   - 野怪站在迷雾边缘 ⇒ `monsters`（打死一只开一片）；
 *   - 词条逾期 ⇒ 它落户的那块地冒出「遗忘之影」（`hasMonster`，答对即复习推进，老规则不变）；
 *   - 升级地块按形状相连 ⇒ `buildings`（纯派生）。
 * ★ 本文件不重算业务口径：到期读服务端 `review.status`；刷怪 / 奖励 / 建筑 / 开拓令全部调 shared。
 */
import {
  CONTINENT_CODEX_SLOTS,
  cellKey,
  codexDiscovered,
  codexSlot,
  detectBuildings,
  exploredCount,
  frontierCells,
  monsterLevel,
  monsterOccupies,
  nextTierAt,
  parseKey,
  speciesTypes,
  terrainAt,
  tierFor,
  tokensLeft,
  visionFor,
  wildMonsters,
  type Biome,
  type Building,
  type ContinentQType,
  type ReviewStatus,
  type WorldSave,
} from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';

/** 地图上的一格（已开拓地块）或一只怪（野怪也用同一形状，便于答题弹窗复用） */
export interface ContinentTileView {
  /** 词条 id；荒地为 `cell:r,c`；野怪为 `wild:r,c` */
  id: string;
  /** 有没有词条落户 */
  hasTerm: boolean;
  /** 出题 / 展示用的词条 id（野怪借用的词条） */
  termId: string | null;
  term: string;
  definition: string;
  domain: string;
  row: number;
  col: number;
  biome: Biome;
  elev: number;
  /** 地块等级 0~3 */
  lv: number;
  /** 开拓次序 */
  n: number;
  status: ReviewStatus;
  overdueDays: number;
  daysSince: number;
  dueInDays: number;
  stage: number;
  inScope: boolean;
  /** 这块地上站着遗忘之影（词条逾期） */
  hasMonster: boolean;
  /** 是野怪（站在迷雾边缘） */
  wild: boolean;
  /** 怪的组合长度（无怪为 0） */
  level: number;
  /** 怪种＝题型序列 */
  species: ContinentQType[];
  /** 总血量＝题数 */
  hp: number;
  discovered: boolean;
  walkable: boolean;
}

export interface ContinentView {
  seed: number;
  tiles: ContinentTileView[];
  monsters: ContinentTileView[];
  frontier: Array<{ row: number; col: number }>;
  buildings: Building[];
  explored: number;
  tier: number;
  nextTier: number | null;
  tokens: number;
  vision: number;
  kills: number;
  /** 图上怪数（野怪 + 遗忘之影） */
  monsterCount: number;
  inScopeCount: number;
  total: number;
  /** 相机夹取用的「世界半径」：已开拓范围 + 视野余量 */
  radius: number;
  codexFound: Set<number>;
  codexTotal: number;
  dueOutOfScope: number;
}

export interface ContinentCell {
  row: number;
  col: number;
}

/** 地上的一只宝箱（打怪掉落；开箱走既有每日宝箱账本） */
export interface ContinentChestDrop {
  row: number;
  col: number;
  term: string;
}

/** 「不在选位态」的空可落位格（稳定引用，见 `ContinentMap` 绘制 effect 的依赖） */
export const NO_SPOTS: readonly ContinentCell[] = [];

/** 地图上的一位学习伙伴（位置与遇险是服务端结论） */
export interface ContinentNpcMark {
  id: string;
  name: string;
  row: number;
  col: number;
  distressed: boolean;
  job?: string;
}

const EMPTY_TERM = {
  status: 'upcoming' as ReviewStatus,
  overdueDays: 0,
  daysSince: 0,
  dueInDays: 0,
  stage: 0,
  inScope: false,
};

export function buildContinentView(
  terms: readonly ContinentMapTerm[],
  world: WorldSave | null,
  day = 0,
): ContinentView {
  const seed = world?.seed ?? 0;
  const save: WorldSave = world ?? { v: 1, seed, cells: {}, kills: 0, spent: 0, codex: [] };
  const byId = new Map(terms.map((t) => [t.id, t]));
  const buildings = detectBuildings(save);
  let inScopeCount = 0;
  let dueOutOfScope = 0;
  for (const t of terms) {
    const inScope = t.review_in_scope === 1;
    if (inScope) inScopeCount += 1;
    else if (t.review.status === 'due' || t.review.status === 'overdue') dueOutOfScope += 1;
  }

  let extent = 0;
  const tiles: ContinentTileView[] = Object.entries(save.cells)
    .sort((a, b) => a[1].n - b[1].n)
    .map(([key, c]) => {
      const { row, col } = parseKey(key);
      extent = Math.max(extent, Math.abs(row), Math.abs(col));
      const ter = terrainAt(seed, row, col);
      const term = c.t ? byId.get(c.t) : undefined;
      const inScope = term?.review_in_scope === 1;
      const hasMonster = term ? monsterOccupies(term.review.status, inScope) : false;
      const level = term ? monsterLevel(term.review_stage) : 0;
      return {
        id: term ? term.id : `cell:${key}`,
        hasTerm: !!term,
        termId: term?.id ?? null,
        term: term?.term ?? '',
        definition: term?.definition ?? '',
        domain: term?.domain ?? '',
        row,
        col,
        biome: ter.biome,
        elev: ter.elev,
        lv: c.lv,
        n: c.n,
        ...(term
          ? {
              status: term.review.status,
              overdueDays: term.review.overdueDays,
              daysSince: term.review.daysSince,
              dueInDays: term.review.dueInDays,
              stage: term.review_stage,
              inScope,
            }
          : EMPTY_TERM),
        hasMonster,
        wild: false,
        level: hasMonster ? level : 0,
        species: hasMonster && term ? speciesTypes(term.id, level) : [],
        hp: hasMonster ? level : 0,
        discovered: term ? (term.last_reviewed_at ?? '') !== '' || term.review_stage > 0 : false,
        walkable: !hasMonster,
      };
    });

  const monsters: ContinentTileView[] = wildMonsters(save, terms.map((t) => t.id), day).map((m) => {
    const term = byId.get(m.termId);
    const ter = terrainAt(seed, m.row, m.col);
    return {
      id: `wild:${m.row},${m.col}`,
      hasTerm: false,
      termId: m.termId,
      term: term?.term ?? '',
      definition: term?.definition ?? '',
      domain: term?.domain ?? '',
      row: m.row,
      col: m.col,
      biome: ter.biome,
      elev: ter.elev,
      lv: 0,
      n: -1,
      ...EMPTY_TERM,
      hasMonster: true,
      wild: true,
      level: m.species.length,
      species: m.species,
      hp: m.hp,
      discovered: false,
      walkable: false,
    };
  });

  const codexFound = codexDiscovered(terms);
  for (const key of save.codex) codexFound.add(codexSlot(key.split('+') as ContinentQType[]));
  const explored = world ? exploredCount(save) : 0;
  const vision = visionFor(buildings);
  return {
    seed,
    tiles,
    monsters,
    frontier: world ? frontierCells(save) : [],
    buildings,
    explored,
    tier: tierFor(explored),
    nextTier: nextTierAt(explored),
    tokens: world ? tokensLeft(save, terms.length, buildings) : 0,
    vision,
    kills: save.kills,
    monsterCount: monsters.length + tiles.filter((t) => t.hasMonster).length,
    inScopeCount,
    total: terms.length,
    radius: Math.max(extent + vision + 8, 12),
    codexFound,
    codexTotal: CONTINENT_CODEX_SLOTS,
    dueOutOfScope,
  };
}

/** 迷雾：某格离最近已开拓格的曼哈顿距离（> vision 视为全黑）。返回 Map 仅覆盖 vision 范围内 */
export function fogDistances(tiles: readonly { row: number; col: number }[], vision: number): Map<string, number> {
  const dist = new Map<string, number>();
  let wave = tiles.map((t) => ({ row: t.row, col: t.col }));
  for (const t of wave) dist.set(cellKey(t.row, t.col), 0);
  for (let d = 1; d <= vision + 1; d += 1) {
    const next: Array<{ row: number; col: number }> = [];
    for (const c of wave) {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const k = cellKey(c.row + dr, c.col + dc);
        if (dist.has(k)) continue;
        dist.set(k, d);
        next.push({ row: c.row + dr, col: c.col + dc });
      }
    }
    wave = next;
  }
  return dist;
}

/** 某一格的悬停文案（唯一文案源） */
export function cellHint(
  cell: { row: number; col: number } | null,
  ctx: {
    tiles: readonly ContinentTileView[];
    monsters: readonly ContinentTileView[];
    frontier: readonly { row: number; col: number }[];
    buildings: readonly Building[];
    npcs: readonly { row: number; col: number; name: string; distressed: boolean }[];
    tokens: number;
  },
): string | null {
  if (!cell) return null;
  const n = ctx.npcs.find((x) => x.row === cell.row && x.col === cell.col);
  if (n) return `「${n.name}」你的学习伙伴${n.distressed ? '· 被怪堵住了，点他看看' : '· 点他跟他说句话'}`;
  const m = ctx.monsters.find((x) => x.row === cell.row && x.col === cell.col);
  if (m) return `野怪 · ${m.species.length} 型组合 · ${m.hp} 滴血 · 走到旁边点它开打，打赢一次开一片地`;
  const t = ctx.tiles.find((x) => x.row === cell.row && x.col === cell.col);
  if (t) return tileHint(t);
  if (ctx.frontier.some((f) => f.row === cell.row && f.col === cell.col)) {
    return ctx.tokens > 0 ? `迷雾 · 站到旁边点它开拓（剩 ${ctx.tokens} 枚开拓令）` : '迷雾 · 开拓令用完了：多学几条词条，或去打迷雾边上的怪';
  }
  return '迷雾深处 · 先把旁边的地开出来';
}

/** 英雄起点：出生点（第 0 块）优先，否则第一块能站的地 */
export function initialHeroCell(tiles: readonly ContinentTileView[]): ContinentTileView | null {
  return tiles.find((t) => t.walkable) ?? tiles[0] ?? null;
}

export function manhattan(a: { row: number; col: number }, b: { row: number; col: number }): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

/** 「够得着吗」：正相邻或同格（见旧注释：库里只有一格且就是怪时，英雄只能站在它脚下） */
export function canStrike(hero: { row: number; col: number } | null, tile: { row: number; col: number }): boolean {
  return hero !== null && manhattan(hero, tile) <= 1;
}

export function neighbors(
  tiles: readonly ContinentTileView[],
  at: { row: number; col: number },
): ContinentTileView[] {
  return tiles.filter((t) => manhattan(t, at) === 1);
}

export function cellLabel(t: Pick<ContinentTileView, 'row' | 'col'>): string {
  return `坐标 (${t.col}, ${t.row})`;
}

const LV_NAME = ['初垦', '良田', '石基', '符文'];

export function tileLevelName(lv: number): string {
  return LV_NAME[Math.min(Math.max(lv, 0), 3)] ?? LV_NAME[0]!;
}

/** 一格的副标题（悬停面板/答题弹窗共用） */
export function tileStatusText(t: ContinentTileView): string {
  if (t.wild) return `迷雾边缘的野怪 · ${t.species.length} 型组合 · ${t.hp} 滴血`;
  if (!t.hasTerm) return '荒地 · 还没有词条落户，多学一条词条它就有主了';
  if (!t.inScope) return `${tileLevelName(t.lv)} · 未纳入复习范围（不冒遗忘之影）`;
  if (t.status === 'overdue') return `逾期 ${t.overdueDays} 天 · ${t.daysSince} 天没复习`;
  if (t.status === 'due') return `今天该复习 · ${t.daysSince} 天没复习`;
  if (t.status === 'mastered') return `${tileLevelName(t.lv)} · 已入长期记忆`;
  return `${tileLevelName(t.lv)} · ${t.daysSince} 天没复习 · 还有 ${t.dueInDays} 天到期`;
}

export function tileHint(t: ContinentTileView): string {
  if (t.hasMonster) return `${t.term}（${t.domain}）· 遗忘之影 · 走到旁边点它开打`;
  if (!t.hasTerm) return '荒地 · 还没有词条落户';
  return `${t.term}（${t.domain}）· ${tileLevelName(t.lv)} ${t.lv}/3 · 点击查看 / 追问升级`;
}
