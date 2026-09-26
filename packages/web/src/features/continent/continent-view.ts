/**
 * features/continent/continent-view — 知识大陆的**视图模型**（纯函数，无 DOM / 无 canvas）。
 *
 * ★ 为什么单拆一层：地图的渲染（canvas 像素）与派生口径（谁有怪、几级、哪格是谁的领地、
 *   图鉴亮几格）必须分开测。塞进组件里就只能靠"渲染出来看一眼"，而本仓已为"只有肉眼可见的错误"
 *   付过学费（先例：`study-flow/flow-viewport.ts` 把布局算法从视口组件里拆出来单测）。
 * ★ 本文件**不重算任何业务口径**：到期与否走 `shared/ebbinghaus.ts`（服务端已算好，直接读
 *   `review.status`）、怪种/等级/领地/图鉴走 `shared/continent.ts`。这里只做「拼装 + 计数」。
 *
 * ★★ 领地为什么要在这里拼进视图（2026-09-26 新增）：领地是 `shared/continent.ts` 的
 *   `spreadLands` 算出来的**派生量**（按逾期天数定格数、确定性贪心定位置）。它必须与
 *   「谁有怪」同源——渲染层只认本文件的结论，不许自己再算一遍谁占了哪格（那份双写就是
 *   「图上画着红边、点进去说没怪」的开端）。故渲染层只读 `landOwner` / `walkable`。
 */
import {
  CONTINENT_CODEX_SLOTS,
  cellKey,
  codexDiscovered,
  layoutTiles,
  monsterLevel,
  monsterOccupies,
  speciesTypes,
  spreadLands,
  type ContinentLandSource,
  type ContinentQType,
  type ReviewStatus,
} from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';

/** 地图上的一格（渲染层只认这个形状，不再回头读 api 类型） */
export interface ContinentTileView {
  id: string;
  term: string;
  definition: string;
  domain: string;
  row: number;
  col: number;
  status: ReviewStatus;
  /** 逾期天数（0 = 未逾期）；地块越久越暗、越可能裂、怪领地越大 */
  overdueDays: number;
  /** 多久没碰了（真实可见的时间） */
  daysSince: number;
  /** 距下次复习还有几天（负 = 已逾期） */
  dueInDays: number;
  stage: number;
  inScope: boolean;
  /** 该格是不是怪的本体（"有怪" ⟺ 它） */
  hasMonster: boolean;
  /** 等级 = 题数 = 血量；无怪时为 0 */
  level: number;
  /** 怪的题型序列（＝每道题/每滴血；无怪时为空） */
  species: ContinentQType[];
  /** 有过复习记录（图鉴据此算「已发现」） */
  discovered: boolean;
  /**
   * 这一格是谁的**领地**（怪 id；本体那一格为 `null`——本体由 `hasMonster` 表达）。
   * ★ 领地格不可通行，且点击它＝复习**领主**的词条（解除占领的唯一路径，见 SPEC）。
   */
  landOwner: string | null;
  /** 领主的词条名（提示文案用；`landOwner` 为空时也是空） */
  landOwnerTerm: string | null;
  /** 领主当前占了几格（含本体）；没被占则为 0 */
  territoryCount: number;
  /** 英雄能否站上这一格（有词条 且 不属于任何怪的本体/领地） */
  walkable: boolean;
  /** 是否是**不可通行**的领地格（＝`landOwner` 非空；本体的不可通行是显然的，单独判） */
  isLand: boolean;
}

export interface ContinentView {
  tiles: ContinentTileView[];
  /**
   * **荒地上的**领地格（本体不在此格、且此格没有词条）。
   * ★ 为什么必须单列：`tiles` 只装真词条（超出 140 格还会截断），而怪吞地时优先啃**荒地**
   *   ——那些格不在 `tiles` 里。不单列一份，canvas 就画不出一整片占领区，点击也会落空
   *   （用户看到的形态是"图上明明有红地，点它没反应"，正是本仓最忌的静默死路）。
   */
  wildLands: ContinentLandCell[];
  /** 图上的怪数（今日可打的复习量） */
  monsterCount: number;

  /** 已纳入复习范围的词条数 */
  inScopeCount: number;
  /** 词条总数 */
  total: number;
  /** 超格被截断的词条数（140 格以外不进地图） */
  truncated: number;
  /** 图鉴**已发现**的槽集合（UI 用 `has(slot)`）/ 总槽数 */
  codexFound: Set<number>;
  codexTotal: number;
  /**
   * 「有欠账但还没纳入复习范围」的词条数——**只用于提示**。
   * 这类词条在地图上只铺普通地块（点了必 409），故要有一句话告诉用户"为什么没变怪、去哪开"。
   */
  dueOutOfScope: number;
  /** 被领地占掉的格数（不含本体，含荒地），用来给"大陆被啃了多少"一个数 */
  landCount: number;
}

/** 一块领地格（本体不在这一格）：渲染与点击共用同一份结论，避免两处各算一次归属 */
export interface ContinentLandCell {
  row: number;
  col: number;
  /** 领主（怪）的词条 id */
  owner: string;
  /** 领主的词条名（提示文案用） */
  ownerTerm: string | null;
  /** 领主当前占几格（含本体） */
  count: number;
}

export interface ContinentViewOptions {
  /**
   * 英雄脚下的格。怪不会把这一格吞成领地（照抄 demo：扩张时跳过英雄所在格）。
   * ★ 这是「英雄走位」这个纯前端状态进入派生层的唯一入口；不传＝没有英雄在场。
   */
  hero?: { row: number; col: number } | null;
}

/** 词条列表 → 地图视图模型（铺格顺序由 `layoutTiles` 定，早入库靠中心） */
export function buildContinentView(
  terms: readonly ContinentMapTerm[],
  opts: ContinentViewOptions = {},
): ContinentView {
  const placed = layoutTiles(terms);
  const termCells = new Set<string>();
  /** 有怪的格子（＝领地扩散的源） */
  const bodySources: ContinentLandSource[] = [];
  let monsterCount = 0;
  let inScopeCount = 0;
  let dueOutOfScope = 0;
  for (const { term, row, col } of placed) {
    termCells.add(cellKey(row, col));
    const inScope = term.review_in_scope === 1;
    if (inScope) inScopeCount += 1;
    if (!inScope && (term.review.status === 'due' || term.review.status === 'overdue')) dueOutOfScope += 1;
    if (monsterOccupies(term.review.status, inScope)) {
      monsterCount += 1;
      bodySources.push({ id: term.id, row, col, overdueDays: term.review.overdueDays });
    }
  }
  // ★ 领地只从**本体格**往外长（demo 口径），且跳过英雄脚下那一格
  const spread = spreadLands(bodySources, {
    termCells,
    blocked: opts.hero ? new Set([cellKey(opts.hero.row, opts.hero.col)]) : undefined,
  });
  const termOfId = new Map(placed.map(({ term }) => [term.id, term.term]));

  const tiles: ContinentTileView[] = placed.map(({ term, row, col }) => {
    const inScope = term.review_in_scope === 1;
    const hasMonster = monsterOccupies(term.review.status, inScope);
    const level = monsterLevel(term.review_stage);
    // 本体格永远不会出现在 `spread.lands` 里（`spreadLands` 先占本体再长领地），故不必排除自己
    const landOwner = spread.lands.get(cellKey(row, col)) ?? null;
    const owner = landOwner ?? (hasMonster ? term.id : null);
    return {
      id: term.id,
      term: term.term,
      definition: term.definition,
      domain: term.domain,
      row,
      col,
      status: term.review.status,
      overdueDays: term.review.overdueDays,
      daysSince: term.review.daysSince,
      dueInDays: term.review.dueInDays,
      stage: term.review_stage,
      inScope,
      hasMonster,
      level: hasMonster ? level : 0,
      species: hasMonster ? speciesTypes(term.id, level) : [],
      discovered: (term.last_reviewed_at ?? '') !== '' || term.review_stage > 0,
      landOwner,
      landOwnerTerm: landOwner ? termOfId.get(landOwner) ?? null : null,
      territoryCount: owner ? spread.countOf.get(owner) ?? 0 : 0,
      walkable: !hasMonster && landOwner === null,
      isLand: landOwner !== null,
    };
  });

  // 荒地上的领地格：有词条的那些已经在对应 tile 上标了，这里只收「tiles 装不下」的那些
  const wildLands: ContinentLandCell[] = [];
  for (const [key, owner] of spread.lands) {
    if (termCells.has(key)) continue;
    const [row, col] = key.split(',').map(Number);
    wildLands.push({
      row: row ?? 0,
      col: col ?? 0,
      owner,
      ownerTerm: termOfId.get(owner) ?? null,
      count: spread.countOf.get(owner) ?? 0,
    });
  }

  return {
    tiles,
    wildLands,
    monsterCount,
    inScopeCount,
    total: terms.length,
    truncated: Math.max(terms.length - tiles.length, 0),
    codexFound: codexDiscovered(terms),
    codexTotal: CONTINENT_CODEX_SLOTS,
    dueOutOfScope,
    landCount: spread.lands.size,
  };
}

/**
 * 英雄的**合法起点**：铺格序里第一格可通行的地块（＝最靠中心那块没被占的）。
 * ★ 用铺格序而不是"随便挑一格"：铺格序是螺旋序，第一格可通行者天然落在内圈，
 *   于是"知识从中心长出来"和"英雄站在中心"是同一个答案。
 */
export function initialHeroCell(tiles: readonly ContinentTileView[]): ContinentTileView | null {
  return tiles.find((t) => t.walkable) ?? tiles[0] ?? null;
}

/** 曼哈顿距离（"够不够得着"的判据：只有正相邻才允许打本体，照抄 demo 的 `near_hero`） */
export function manhattan(a: { row: number; col: number }, b: { row: number; col: number }): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

/**
 * 「够得着这只怪吗」——老板点单的**靠近才开打**闸门。
 * ★ 正相邻（`manhattan === 1`）为准；**额外允许 `0`（站在同一格）**。
 *   为什么要放宽这 0：整张图上可能一格可通行地都没有（库里只有一条词条、且它正好就是那只怪），
 *   此时英雄只能停在它脚下——严格判 1 会让新手第一步就点不动，那是 ADR-5 明令禁止的静默卡死。
 *   正常数据下怪的本体格不可通行，英雄永远站不上去，故这条放宽不会被"隔着零格打怪"滥用。
 */
export function canStrike(hero: { row: number; col: number } | null, tile: { row: number; col: number }): boolean {
  return hero !== null && manhattan(hero, tile) <= 1;
}

/** 四邻（越界已滤掉），走位与"够得着"共用一份邻接口径 */
export function neighbors(
  tiles: readonly ContinentTileView[],
  at: { row: number; col: number },
): ContinentTileView[] {
  return tiles.filter((t) => manhattan(t, at) === 1);
}

/** 格子编号（图鉴/提示文案用：「第 12 格」比「row3col5」好读） */
export function cellLabel(t: Pick<ContinentTileView, 'row' | 'col'>): string {
  return `第 ${t.row + 1} 行 · 第 ${t.col + 1} 列`;
}

/** 一格的副标题（悬停面板/答题弹窗共用同一句，免得两处各写一套文案） */
export function tileStatusText(t: ContinentTileView): string {
  if (t.isLand) return `被「${t.landOwnerTerm ?? ''}」占为领地 · 领主共占 ${t.territoryCount} 格`;
  if (!t.inScope) return '未纳入复习范围 · 地图上只铺地，不冒怪';
  if (t.status === 'overdue') return `逾期 ${t.overdueDays} 天 · ${t.daysSince} 天没复习`;
  if (t.status === 'due') return `今天该复习 · ${t.daysSince} 天没复习`;
  if (t.status === 'mastered') return `已入长期记忆 · ${t.daysSince} 天前复习`;
  return `${t.daysSince} 天没复习 · 还有 ${t.dueInDays} 天到期`;
}

/** 悬停提示（一句话说清"这格是什么、点了会怎样"） */
export function tileHint(t: ContinentTileView): string {
  if (t.hasMonster) return `${t.term}（${t.domain}）· ${t.level} 级怪 · 走到旁边点它开打`;
  if (t.isLand) return `「${t.landOwnerTerm ?? ''}」怪的领地 · 点它复习领主，收复这片地`;
  return `${t.term}（${t.domain}）· 已收复 · 点击查看`;
}