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
 *
 * ★ 2026-09-29 两条新派生量（都仍是**派生、零存储**，口径在 shared）：
 *   · **野怪** `monsterKind === 'wild'`：`shared/continent-wild.ts` 按「日历日 × 词条 id」稳定哈希每天点名
 *     几条（范围外也算），让新用户第一天就有怪可打；它**不占地**（领地只从欠账怪长），打赢＝提前复习一次。
 *     只有传了 `dayKey` 才刷（页面传本地日历日；不传就是旧口径，服务端 / 老测试不受影响）。
 *   · **边界「+」** `frontier`：`shared/continent-expand.ts` 的 `frontierCells` 再排除掉怪的荒地领地格。
 *     开拓出来的地块靠 `pins`（服务端随地图一并给）钉在点的那一格——铺格仍是同一份 `layoutTiles`。
 *
 * ★ 2026-09-30 再加两条（口径都在 `shared/continent-upkeep.ts`，仍是派生、零存储）：
 *   · **磨损与废墟** `wear` / `ruin`：地块要维护——多久没碰 ÷ 这一环的耐久期；到 1 就**原地**碎成废墟
 *     （铺格一格不动：伙伴的家与钉子都是存下来的坐标）。废墟不改变怪与领地的口径，只是不再算「完好地块」。
 *   · **话题怪** `monsterKind === 'topic'`：今天对话里被提到的词条（服务端 `last_used_at`），与野怪同样只在传了
 *     `dayKey` 时刷、不占地；欠账怪 > 话题怪 > 野怪。
 */
import {
  CONTINENT_CODEX_SLOTS,
  cellKey,
  codexDiscovered,
  frontierCells,
  isRuin,
  layoutRadius,
  layoutTiles,
  monsterKindOf,
  monsterLevel,
  speciesTypes,
  spreadLands,
  tileRing,
  tileWear,
  topicMonsterIds,
  wildMonsterIds,
  type ContinentLandSource,
  type ContinentMonsterKind,
  type ContinentPin,
  type ContinentQType,
  type ReviewStatus,
  type SpellKind,
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
  /** 该格是不是怪的本体（"有怪" ⟺ 它；欠账怪与野怪都算） */
  hasMonster: boolean;
  /** 怪的来路：`due` 欠账怪（到期/逾期，占地）／`wild` 野怪（每日随机保底，不占地）／`topic` 话题怪（今天对话里提到的，不占地）；无怪 `null` */
  monsterKind: ContinentMonsterKind | null;
  /** 离中心几环（`max(|row|,|col|)`）：耐久期由它定 */
  ring: number;
  /** 维护磨损 `0..1`（多久没碰 ÷ 本环耐久期；长期记忆恒 0）；≥ 1 即废墟 */
  wear: number;
  /** 废墟：碎在原地，复习一次即重建（点它可直接「复习重建」） */
  ruin: boolean;
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

/** 收复特效的入参：那一格 + 若由魔法吟唱补刀则带上款式（`spell` ⇒ canvas 放该款的咒语版特效，契约 SPELL-CHANT §3.4） */
export type ContinentBurst = ContinentTileView & { spell?: SpellKind };

export interface ContinentView {
  tiles: ContinentTileView[];
  /**
   * **荒地上的**领地格（本体不在此格、且此格没有词条）。
   * ★ 为什么必须单列：`tiles` 只装真词条（超出**世界容量**才截断，正常量级不会），而怪吞地时优先啃**荒地**
   *   ——那些格不在 `tiles` 里。不单列一份，canvas 就画不出一整片占领区，点击也会落空
   *   （用户看到的形态是"图上明明有红地，点它没反应"，正是本仓最忌的静默死路）。
   */
  wildLands: ContinentLandCell[];
  /** 图上的**欠账怪**数（今日该收复的复习量；野怪另计） */
  monsterCount: number;
  /** 图上的**野怪**数（每日随机保底；打赢即"提前复习"一次） */
  wildCount: number;
  /** 图上的**话题怪**数（今天对话里提到的词条；打赢即复习一次） */
  topicCount: number;
  /** 废墟数（碎在原地的地块）与完好地块数（`tiles.length - ruinCount`）——「大陆保持多大」看的是后者 */
  ruinCount: number;
  intactCount: number;
  /**
   * 边界上的「+」：世界内、没铺词条、四邻至少一格词条、且不在怪的荒地领地上的格。
   * ★ 由 `shared/continent-expand.ts` 算（服务端校验用同一份口径），这里只是把荒地领地排除掉——
   *   那格画着红边，再叠一个 + 就是两种语义打架。
   */
  frontier: ContinentCell[];

  /** 已纳入复习范围的词条数 */
  inScopeCount: number;
  /** 词条总数 */
  total: number;
  /**
   * **世界半径**（2026-09-27）：世界为 `[-radius, radius]²`，共 `worldCells(radius)` 格；
   * 视口只有 `CONTINENT_VIEW_COLS × CONTINENT_VIEW_ROWS` ⇒ 屏幕只是视野。
   * ★ UI 用它说"大陆多大"（`worldCells(radius)`）与算相机边界，**不自己重推**（先例同 `landCount`）。
   */
  radius: number;
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

/** 地上的一只宝箱（打怪掉落；**只有位置与词条名，没有账**——开箱走既有每日宝箱账本） */
export interface ContinentChestDrop {
  row: number;
  col: number;
  term: string;
}

/** 一个格子（世界坐标，可为负；可能是真词条格、荒地上的领地格，或还没铺词条的空地） */
export interface ContinentCell {
  row: number;
  col: number;
}

/**
 * 「不在选位态」的空可落位格（契约 `docs/NPC-PARTNER-SPEC.md` §7）。
 * ★ 必须是**稳定引用**：`ContinentMap` 的绘制 effect 以它作默认值，每次渲染新建一个 `[]`
 *   会让 effect 每帧重跑（"长出来"的铺格动画反复重播，且白烧一格 CPU）。
 * ★ 放这里而不是 `ContinentMap.tsx`：那份文件贴 `.tsx ≤300` 红线，一个常量挤在那里不值当。
 */
export const NO_SPOTS: readonly ContinentCell[] = [];

/**
 * 地图上的一位学习伙伴（★ 只有位置与名字，**遇险是服务端结论**）。
 * ★ 不让渲染层自己算"他危不危险"：那要重算铺格 + 领地 + 曼哈顿距离，即第二份口径
 *   （图上画着遇险、清单里没有那单）；结论由 `GET /api/npc` 给，这里只是读数。
 * ★ 从 `ContinentMap.tsx` 搬来这里：与 `ContinentTileView` 同族，都属"地图的视图形状"。
 */
export interface ContinentNpcMark {
  id: string;
  name: string;
  row: number;
  col: number;
  distressed: boolean;
}

export interface ContinentViewOptions {
  /**
   * 英雄脚下的格。怪不会把这一格吞成领地（照抄 demo：扩张时跳过英雄所在格）。
   * ★ 这是「英雄走位」这个纯前端状态进入派生层的唯一入口；不传＝没有英雄在场。
   */
  hero?: { row: number; col: number } | null;
  /** 开拓出来的地块坐标（服务端 `GET /review/map` 一并给）；不传＝全走螺旋 */
  pins?: readonly ContinentPin[];
  /**
   * 野怪与话题怪的日历键（`localDayKey(new Date())`，由页面传入——本文件与 shared 一样不读时钟）。
   * **不传＝不刷野怪也不刷话题怪**：只想看欠账怪的调用方（与旧用例）拿到的图与从前一样。
   */
  dayKey?: string;
}

/** 词条列表 → 地图视图模型（铺格顺序由 `layoutTiles` 定，早入库靠中心；钉住的落钉子上） */
export function buildContinentView(
  terms: readonly ContinentMapTerm[],
  opts: ContinentViewOptions = {},
): ContinentView {
  const pins = opts.pins ?? [];
  const placed = layoutTiles(terms, pins);
  const wild = opts.dayKey ? wildMonsterIds(terms, opts.dayKey) : new Set<string>();
  const topic = opts.dayKey ? topicMonsterIds(terms, opts.dayKey) : new Set<string>();
  const termCells = new Set<string>();
  /** 有欠账怪的格子（＝领地扩散的源；野怪 / 话题怪不占地，不进这里） */
  const bodySources: ContinentLandSource[] = [];
  let monsterCount = 0;
  let wildCount = 0;
  let topicCount = 0;
  let ruinCount = 0;
  let inScopeCount = 0;
  let dueOutOfScope = 0;
  for (const { term, row, col } of placed) {
    termCells.add(cellKey(row, col));
    const inScope = term.review_in_scope === 1;
    if (inScope) inScopeCount += 1;
    if (!inScope && (term.review.status === 'due' || term.review.status === 'overdue')) dueOutOfScope += 1;
    if (isRuin(tileWear(term, { row, col }))) ruinCount += 1;
    const kind = monsterKindOf(term, wild, topic);
    if (kind === 'wild') wildCount += 1;
    if (kind === 'topic') topicCount += 1;
    if (kind === 'due') {
      monsterCount += 1;
      bodySources.push({ id: term.id, row, col, overdueDays: term.review.overdueDays });
    }
  }
  // ★ 领地只从**本体格**往外长（demo 口径），且跳过英雄脚下那一格
  // ★ 世界半径与 `layoutTiles` 同源（都是 `layoutRadius(词条数, 钉子)`）⇒ 领地边界不可能与铺格范围打架
  const radius = layoutRadius(terms.length, pins);
  const spread = spreadLands(bodySources, {
    radius,
    termCells,
    blocked: opts.hero ? new Set([cellKey(opts.hero.row, opts.hero.col)]) : undefined,
  });
  const termOfId = new Map(placed.map(({ term }) => [term.id, term.term]));

  const tiles: ContinentTileView[] = placed.map(({ term, row, col }) => {
    const inScope = term.review_in_scope === 1;
    const monsterKind = monsterKindOf(term, wild, topic);
    const hasMonster = monsterKind !== null;
    const level = monsterLevel(term.review_stage);
    const wear = tileWear(term, { row, col });
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
      monsterKind,
      ring: tileRing({ row, col }),
      wear,
      ruin: isRuin(wear),
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

  // 边界上的「+」：荒地领地那些格排除掉（它们已经有一个身份了）
  const landKeys = new Set(spread.lands.keys());
  const frontier: ContinentCell[] = frontierCells(placed, radius, landKeys);

  return {
    tiles,
    wildLands,
    monsterCount,
    wildCount,
    topicCount,
    ruinCount,
    intactCount: tiles.length - ruinCount,
    frontier,
    inScopeCount,
    total: terms.length,
    radius,
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

/** 曼哈顿距离（"够不够得着"的判断标准：只有正相邻才允许打本体，照抄 demo 的 `near_hero`） */
export function manhattan(a: { row: number; col: number }, b: { row: number; col: number }): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

/**
 * 「够得着这只怪吗」——**靠近才开打**闸门。
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

/**
 * 开打用的格（2026-09-30）：有怪的照原样；**废墟**没有怪，就地立一只"废墟守卫"——等级 / 怪种按与怪同一套派生
 * （`monsterLevel(stage)` / `speciesTypes`），于是同一场战斗、同一张脸、同一份图鉴口径。
 * ★ 只补 `level/species`，**不改** `hasMonster`：弹窗据此把标题说成"重建"而不是"讨伐"，页面据此挑收复文案。
 */
export function fightTile(tile: ContinentTileView): ContinentTileView {
  if (tile.hasMonster || !tile.ruin) return tile;
  const level = monsterLevel(tile.stage);
  return { ...tile, level, species: speciesTypes(tile.id, level) };
}

// 文案口径（悬停提示 / 副标题 / 格子编号）2026-09-30 搬到 `continent-text.ts`；这里再导出一次，
// 调用方（地图 / 页面 / 弹窗 / 测试）不必知道这次搬家。
export { cellHint, cellLabel, tileHint, tileStatusText } from './continent-text';
