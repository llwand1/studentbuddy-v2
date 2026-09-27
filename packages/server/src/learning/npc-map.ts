/**
 * learning/npc-map — 铺一次图，分出「没冒怪的地块」与「怪的本体格」（伙伴域与求救单共用）。
 *
 * ★ 为什么单独一个文件（而不是塞进 `learning/npc.ts`）：视图层（`npc.ts`）与花名册层
 *   （`npc-party.ts`）都要这份扫描结果，而花名册层要被视图层 import ⇒ 扫描放这里才**不出环**。
 * ★ 只扫一次、只此一处：前端不重算铺格/领地，双份口径的开端就是「图上画着伙伴遇险、清单里没有那单」。
 * ★ 两桶是**同一个形状**：`candidates`（没冒怪 ⇒ 可落脚）与 `monsters`（冒了怪 ⇒ 威胁源）。
 *   领地格算在 `candidates` 里（已占领的格仍然 `!hasMonster`）——伙伴站在怪的地盘上正是"他遇险了"
 *   的视觉前提（SPEC §2.2）。
 */
import { layoutTiles, monsterOccupies } from '@sb/shared';
import { continentMap } from './continent.js';

/** 图上的一个词条格（`candidates` 与 `monsters` 是同一个形状的两桶） */
export interface NpcCell {
  termId: string;
  term: string;
  domain: string;
  row: number;
  col: number;
}

export interface MapScan {
  /** 没冒怪的词条格：创建伙伴的合法落位（**含已被占领的领地格**——伙伴不怕怪的地盘） */
  candidates: NpcCell[];
  /** 怪的本体格：遇险判断标准的输入（★ 领地格不算威胁源，按 `monsterOccupies` 现判） */
  monsters: NpcCell[];
  /** 词条总数（名额上限与"有没有地"都读它，不读格子数） */
  terms: number;
}

/** 铺一次图。★ 半径由 `layoutTiles` 自己现算（`worldRadiusFor(词条数)`），调用方传不出错的半径 */
export function scanMap(ownerId: string | null): MapScan {
  const list = continentMap(ownerId);
  const tiles = layoutTiles(list);
  const candidates: NpcCell[] = [];
  const monsters: NpcCell[] = [];
  for (const t of tiles) {
    const cell: NpcCell = {
      termId: t.term.id,
      term: t.term.term,
      domain: t.term.domain,
      row: t.row,
      col: t.col,
    };
    if (monsterOccupies(t.term.review.status, t.term.review_in_scope === 1)) monsters.push(cell);
    else candidates.push(cell);
  }
  return { candidates, monsters, terms: list.length };
}