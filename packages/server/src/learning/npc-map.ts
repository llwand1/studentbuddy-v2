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
import { monsterOccupies, parseKey } from '@sb/shared';
import { loadWorld } from './continent-world.js';

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

/**
 * 扫一次图。★ 2026-09-28 起地图是**玩家开拓**的：只有已开拓且有词条落户的格才算地块
 *   （`loadWorld` 顺手把空闲词条绑上荒地），迷雾里的词条还没有位置。
 */
export function scanMap(ownerId: string | null): MapScan {
  const { world, terms: list } = loadWorld(ownerId);
  const byId = new Map(list.map((t) => [t.id, t]));
  const candidates: NpcCell[] = [];
  const monsters: NpcCell[] = [];
  const cells = Object.entries(world.cells).sort((a, b) => a[1].n - b[1].n);
  for (const [key, c] of cells) {
    const term = c.t ? byId.get(c.t) : undefined;
    if (!term) continue;
    const { row, col } = parseKey(key);
    const cell: NpcCell = { termId: term.id, term: term.term, domain: term.domain, row, col };
    if (monsterOccupies(term.review.status, term.review_in_scope === 1)) monsters.push(cell);
    else candidates.push(cell);
  }
  return { candidates, monsters, terms: list.length };
}