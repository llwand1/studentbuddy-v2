/**
 * features/continent/continent-text — 知识大陆的**文案口径**（悬停提示 / 副标题 / 格子编号），纯函数。
 *
 * ★ 2026-09-30 从 `continent-view.ts` 搬出：那边加了维护磨损与话题怪之后撞上 gates 的「web .ts ≤400 行」红线。
 *   接缝取在"派生 vs 说话"：`continent-view` 只算（谁有怪、几级、哪格是领地、磨损几成），这里只负责把结论
 *   说成人话——两边都可单测，且文案永远只有这一处（组件里不许另写一套）。
 * ★ 这些函数**只读** `ContinentTileView` 的结论，不重算任何口径（不看 review 原始字段）。
 */
import { tileDurabilityDays } from '@sb/shared';
import type { ContinentCell, ContinentLandCell, ContinentTileView } from './continent-view';

/**
 * 某一格的**悬停文案**（唯一文案源，2026-09-27 从 `ContinentMap.tsx` 下沉到这里）。
 *
 * ★ 为什么下沉：① 组件要守 `.tsx ≤300 行` 红线；② 它本来就是**文案口径**——与 `tileHint` 同族，
 *   放这里才能被单测，也不会出现"组件里一套、提示里另一套"。
 * ★ **伙伴优先于地块**：他站在格子上，鼠标停上去该说的是"这是谁"，不是"这格什么状态"。
 * ★ 世界比视口大之后，落在视野里的空格也可能是**世界内但没铺词条**的格，故最后那句要说清
 *   "走不过去"而不是含糊的"空"。
 */
export function cellHint(
  cell: { row: number; col: number } | null,
  ctx: {
    tiles: readonly ContinentTileView[];
    wildLands: readonly ContinentLandCell[];
    npcs: readonly { row: number; col: number; name: string; distressed: boolean }[];
    /** 边界上的「+」（不传＝没有可开拓的格） */
    frontier?: readonly ContinentCell[];
  },
): string | null {
  if (!cell) return null;
  const n = ctx.npcs.find((x) => x.row === cell.row && x.col === cell.col);
  if (n) return `「${n.name}」你的学习伙伴${n.distressed ? '· 被怪堵住了，点他看看' : '· 点他跟他说句话'}`;
  const t = ctx.tiles.find((x) => x.row === cell.row && x.col === cell.col);
  if (t) return tileHint(t);
  const w = ctx.wildLands.find((x) => x.row === cell.row && x.col === cell.col);
  if (w) return `「${w.ownerTerm ?? ''}」怪的领地（荒地）· 领主共占 ${w.count} 格 · 点它复习领主`;
  if (ctx.frontier?.some((f) => f.row === cell.row && f.col === cell.col)) {
    return '边界空地「+」· 点它开拓：领一条新词条，答对两道题，新地块就长在这一格';
  }
  return '这一格还没铺上词条（走不过去）· 去「词条」页多存几条，或点边界上的「+」开拓过去';
}

/** 格子编号（图鉴/提示文案用：「第 12 格」比「row3col5」好读） */
export function cellLabel(t: Pick<ContinentTileView, 'row' | 'col'>): string {
  return `第 ${t.row + 1} 行 · 第 ${t.col + 1} 列`;
}

/** 一格的副标题（悬停面板/答题弹窗共用同一句，免得两处各写一套文案） */
export function tileStatusText(t: ContinentTileView): string {
  if (t.isLand) return `被「${t.landOwnerTerm ?? ''}」占为领地 · 领主共占 ${t.territoryCount} 格`;
  if (t.monsterKind === 'wild') {
    return `野怪 · 今天随机盯上了这条${t.inScope ? '' : '（未纳入复习范围，打赢即纳入）'} · ${t.daysSince} 天没碰`;
  }
  if (t.monsterKind === 'topic') {
    return `话题怪 · 今天的对话里提到了它${t.inScope ? '' : '（未纳入复习范围，打赢即纳入）'} · ${t.daysSince} 天没碰`;
  }
  if (t.ruin) return `废墟 · ${t.daysSince} 天没碰，超过了这一环 ${tileDurabilityDays(t.ring)} 天的耐久期 · 复习一次即重建`;
  if (!t.inScope) return '未纳入复习范围 · 不冒欠账怪（野怪仍可能盯上它）';
  if (t.status === 'overdue') return `逾期 ${t.overdueDays} 天 · ${t.daysSince} 天没复习`;
  if (t.status === 'due') return `今天该复习 · ${t.daysSince} 天没复习`;
  if (t.status === 'mastered') return `已入长期记忆 · ${t.daysSince} 天前复习 · 基石，永不碎`;
  return `${t.daysSince} 天没复习 · 还有 ${t.dueInDays} 天到期${wearNote(t)}`;
}

/** 磨损提醒（起裂之后才说；完好的地块不啰嗦） */
export function wearNote(t: ContinentTileView): string {
  if (t.ruin || t.wear < 0.5) return '';
  const left = Math.max(1, Math.ceil(tileDurabilityDays(t.ring) - t.daysSince));
  return ` · 地块起裂，再 ${left} 天不碰就碎`;
}

/** 悬停提示（一句话说清"这格是什么、点了会怎样"） */
export function tileHint(t: ContinentTileView): string {
  if (t.monsterKind === 'wild') return `${t.term}（${t.domain}）· ${t.level} 级野怪 · 走到旁边点它开打（打赢＝提前复习一次）`;
  if (t.monsterKind === 'topic') return `${t.term}（${t.domain}）· ${t.level} 级话题怪 · 今天聊到了它 · 走到旁边点它开打（打赢＝复习一次）`;
  if (t.hasMonster) return `${t.term}（${t.domain}）· ${t.level} 级怪 · 走到旁边点它开打`;
  if (t.isLand) return `「${t.landOwnerTerm ?? ''}」怪的领地 · 点它复习领主，收复这片地`;
  if (t.ruin) return `${t.term}（${t.domain}）· 废墟 · ${t.daysSince} 天没碰碎掉了 · 点它复习重建`;
  return `${t.term}（${t.domain}）· 已收复 · 点击查看${wearNote(t)}`;
}