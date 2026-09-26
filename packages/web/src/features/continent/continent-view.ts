/**
 * features/continent/continent-view — 知识大陆的**视图模型**（纯函数，无 DOM / 无 canvas）。
 *
 * ★ 为什么单拆一层：地图的渲染（canvas 像素）与派生口径（谁有怪、几级、图鉴亮几格）必须分开测。
 *   塞进组件里就只能靠"渲染出来看一眼"，而本仓已为"只有肉眼可见的错误"付过学费
 *   （先例：`study-flow/flow-viewport.ts` 把布局算法从视口组件里拆出来单测）。
 * ★ 本文件**不重算任何业务口径**：到期与否走 `shared/ebbinghaus.ts`（服务端已算好，直接读
 *   `review.status`）、怪种/等级/图鉴走 `shared/continent.ts`。这里只做「拼装 + 计数」。
 */
import {
  CONTINENT_CODEX_SLOTS,
  codexDiscovered,
  layoutTiles,
  monsterLevel,
  monsterOccupies,
  speciesTypes,
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
  /** 逾期天数（0 = 未逾期）；地块越久越暗、越可能裂 */
  overdueDays: number;
  /** 多久没碰了（真实可见的时间） */
  daysSince: number;
  /** 距下次复习还有几天（负 = 已逾期） */
  dueInDays: number;
  stage: number;
  inScope: boolean;
  /** 该格有没有怪（= 在复习范围内 且 到期/逾期） */
  hasMonster: boolean;
  /** 等级 = 题数 = 血量；无怪时为 0 */
  level: number;
  /** 怪的题型序列（＝每道题/每滴血；无怪时为空） */
  species: ContinentQType[];
  /** 有过复习记录（图鉴据此算「已发现」） */
  discovered: boolean;
}

export interface ContinentView {
  tiles: ContinentTileView[];
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
}

/** 词条列表 → 地图视图模型（铺格顺序由 `layoutTiles` 定，早入库靠中心） */
export function buildContinentView(terms: readonly ContinentMapTerm[]): ContinentView {
  const placed = layoutTiles(terms);
  let monsterCount = 0;
  let inScopeCount = 0;
  let dueOutOfScope = 0;
  const tiles: ContinentTileView[] = placed.map(({ term, row, col }) => {
    const inScope = term.review_in_scope === 1;
    const hasMonster = monsterOccupies(term.review.status, inScope);
    const level = monsterLevel(term.review_stage);
    if (hasMonster) monsterCount += 1;
    if (inScope) inScopeCount += 1;
    if (!inScope && (term.review.status === 'due' || term.review.status === 'overdue')) dueOutOfScope += 1;
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
    };
  });
  return {
    tiles,
    monsterCount,
    inScopeCount,
    total: terms.length,
    truncated: Math.max(terms.length - tiles.length, 0),
    codexFound: codexDiscovered(terms),
    codexTotal: CONTINENT_CODEX_SLOTS,
    dueOutOfScope,
  };
}

/** 格子编号（图鉴/提示文案用：「第 12 格」比「row3col5」好读） */
export function cellLabel(t: Pick<ContinentTileView, 'row' | 'col'>): string {
  return `第 ${t.row + 1} 行 · 第 ${t.col + 1} 列`;
}

/** 一格的副标题（悬停面板/答题弹窗共用同一句，免得两处各写一套文案） */
export function tileStatusText(t: ContinentTileView): string {
  if (!t.inScope) return '未纳入复习范围 · 地图上只铺地，不冒怪';
  if (t.status === 'overdue') return `逾期 ${t.overdueDays} 天 · ${t.daysSince} 天没复习`;
  if (t.status === 'due') return `今天该复习 · ${t.daysSince} 天没复习`;
  if (t.status === 'mastered') return `已入长期记忆 · ${t.daysSince} 天前复习`;
  return `${t.daysSince} 天没复习 · 还有 ${t.dueInDays} 天到期`;
}