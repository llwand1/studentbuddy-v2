/**
 * continent-view.test — 知识大陆**视图模型**的派生口径锁（纯函数，零 DOM 零 canvas）。
 *
 * 为什么单测这一层：地图上「谁有怪 / 几级 / 图鉴亮几格 / 有没有被截断」全是派生结论，
 * 一旦算错，用户看到的是**一张自洽但错误的地图**（图上冒怪、点进去 409 的那种死路就是它算错的形态），
 * 而 canvas 渲染根本不会报错。故把口径钉在这里，渲染层只负责画。
 *
 * ★ 复习状态**不自己编**：全部由 `computeReviewState`（判定唯一实现）现算，只注入 `now`
 *   ——本文件若手写 `review` 对象，锁的就是"我以为是的样子"，而不是系统真正会给出的状态。
 */
import { describe, it, expect } from 'vitest';
import { CONTINENT_CODEX_SLOTS, cellKey, computeReviewState, newWorld, worldFromPlacements, type WorldSave } from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import {
  buildContinentView,
  canStrike,
  cellLabel,
  fogDistances,
  initialHeroCell,
  manhattan,
  tileHint,
  tileStatusText,
  type ContinentTileView,
} from './continent-view';

/** 注入的「现在」（12:00Z 是为了在任何时区下都与偏移日同属一个本地日历日，天数差稳定） */
const NOW = new Date('2026-09-26T12:00:00Z');

/** 相对 NOW 偏移 n 天的 SQLite UTC 文本（与 `datetime('now')` 同格式） */
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
}

function termOf(id: string, createdAt: string, over: Partial<ContinentMapTerm> = {}): ContinentMapTerm {
  const base: ContinentMapTerm = {
    id,
    term: `词条${id}`,
    definition: `释义${id}`,
    domain: 'js',
    importance: 0.5,
    usage_count: 1,
    created_at: createdAt,
    updated_at: createdAt,
    review_stage: 0,
    last_reviewed_at: null,
    review_in_scope: 0,
    review: computeReviewState({ stage: 0, createdAt, now: NOW }),
  };
  const merged: ContinentMapTerm = { ...base, ...over };
  return {
    ...merged,
    // 覆盖了 stage/last_reviewed_at 时按**结果**重算状态（保证 review 与字段永远一致）
    review: over.review ?? computeReviewState({
      stage: merged.review_stage,
      lastReviewedAt: merged.last_reviewed_at,
      createdAt,
      now: NOW,
    }),
  };
}

/** 逾期词条（stage 0 间隔 1 天，入库 3 天前 ⇒ 逾期 2 天；在范围内才冒怪） */
function overdueTerm(id: string, over: Partial<ContinentMapTerm> = {}): ContinentMapTerm {
  return termOf(id, daysAgo(3), { review_in_scope: 1, ...over });
}

function tile(view: ReturnType<typeof buildContinentView>, id: string): ContinentTileView {
  const t = view.tiles.find((x) => x.id === id);
  if (!t) throw new Error(`地图上没有 ${id}`);
  return t;
}

/** 一张把词条按给定坐标视为「已开拓」的存档 */
function worldWith(cells: Array<[string, number, number]>, seed = 7): WorldSave {
  return worldFromPlacements(seed, cells.map(([id, row, col]) => ({ id, row, col })));
}

describe('buildContinentView 开拓制', () => {
  it('★ 从零开始：新世界只有出生点一格，没铺满词条；迷雾边缘是它的四邻', () => {
    const terms = ['a', 'b', 'c'].map((id) => termOf(id, daysAgo(0)));
    const view = buildContinentView(terms, newWorld(1), 0);
    expect(view.tiles).toHaveLength(1);
    expect(view.explored).toBe(1);
    expect(view.frontier).toHaveLength(4);
    // 开拓令 = 起始 2 + 3 条词条
    expect(view.tokens).toBe(5);
  });

  it('存档没到（取数中）不炸：零格、零怪、图鉴总数仍由题型表派生', () => {
    const view = buildContinentView([], null, 0);
    expect(view.tiles).toHaveLength(0);
    expect(view.monsters).toHaveLength(0);
    expect(view.codexTotal).toBe(CONTINENT_CODEX_SLOTS);
  });

  it('荒地没有词条信息、可站；有词条的地块带上词条与等级', () => {
    const w = worldWith([['a', 0, 0]]);
    w.cells[cellKey(0, 1)] = { t: null, lv: 0, n: 1 };
    w.cells[cellKey(0, 0)]!.lv = 2;
    const view = buildContinentView([termOf('a', daysAgo(0))], w, 0);
    expect(tile(view, 'a').lv).toBe(2);
    const wild = view.tiles.find((t) => !t.hasTerm);
    expect(wild?.walkable).toBe(true);
    expect(tileStatusText(wild!)).toMatch(/荒地/);
  });

  it('逾期且在范围内的词条：它落户的地块冒遗忘之影、不可站', () => {
    const view = buildContinentView([overdueTerm('a')], worldWith([['a', 0, 0]]), 0);
    const a = tile(view, 'a');
    expect(a.hasMonster).toBe(true);
    expect(a.walkable).toBe(false);
    expect(a.hp).toBe(a.level);
  });

  it('★ 范围外到期不冒怪，只计数给提示', () => {
    const view = buildContinentView([termOf('b', daysAgo(3))], worldWith([['b', 0, 0]]), 0);
    expect(tile(view, 'b').hasMonster).toBe(false);
    expect(view.dueOutOfScope).toBe(1);
  });

  it('★ 有词条就会刷野怪（修「不刷怪」）：站在迷雾边缘、不在已开拓格上', () => {
    const terms = ['a', 'b', 'c', 'd'].map((id) => termOf(id, daysAgo(0)));
    const w = worldWith([['a', 0, 0], ['b', 0, 1], ['c', 1, 0], ['d', 1, 1]]);
    const view = buildContinentView(terms, w, 3);
    expect(view.monsters.length).toBeGreaterThan(0);
    for (const m of view.monsters) {
      expect(m.wild).toBe(true);
      expect(w.cells[cellKey(m.row, m.col)]).toBeUndefined();
      expect(view.frontier.some((f) => f.row === m.row && f.col === m.col)).toBe(true);
      expect(m.hp).toBeGreaterThanOrEqual(m.species.length);
    }
    expect(view.monsterCount).toBe(view.monsters.length);
  });

  it('没有词条就不刷野怪（出不了题），也不会给出空的怪', () => {
    expect(buildContinentView([], newWorld(3), 0).monsters).toHaveLength(0);
  });

  it('图鉴：击败过的怪种也点亮', () => {
    const w = newWorld(1);
    w.codex = ['judge', 'choice+fill'];
    expect(buildContinentView([], w, 0).codexFound.size).toBe(2);
  });
});

describe('迷雾与走位', () => {
  it('fogDistances：已开拓格为 0，向外逐格 +1', () => {
    const d = fogDistances([{ row: 0, col: 0 }], 2);
    expect(d.get('0,0')).toBe(0);
    expect(d.get('0,1')).toBe(1);
    expect(d.get('1,1')).toBe(2);
  });

  it('initialHeroCell：第一块能站的地；全是怪时退到第一格', () => {
    const view = buildContinentView([overdueTerm('a'), termOf('b', daysAgo(0))], worldWith([['a', 0, 0], ['b', 0, 1]]), 0);
    expect(initialHeroCell(view.tiles)?.id).toBe('b');
    const only = buildContinentView([overdueTerm('a')], worldWith([['a', 0, 0]]), 0);
    expect(initialHeroCell(only.tiles)?.id).toBe('a');
  });

  it('canStrike：正相邻或同格才够得着', () => {
    const at = { row: 0, col: 0 };
    expect(canStrike(at, { row: 0, col: 1 })).toBe(true);
    expect(canStrike(at, at)).toBe(true);
    expect(canStrike(at, { row: 1, col: 1 })).toBe(false);
    expect(canStrike(null, at)).toBe(false);
    expect(manhattan(at, { row: 2, col: -1 })).toBe(3);
  });
});

describe('文案口径', () => {
  it('tileHint：怪 / 荒地 / 普通地块各说各的', () => {
    const w = worldWith([['a', 0, 0], ['b', 0, 1]]);
    w.cells[cellKey(1, 0)] = { t: null, lv: 0, n: 2 };
    const view = buildContinentView([overdueTerm('a'), termOf('b', daysAgo(0))], w, 0);
    expect(tileHint(tile(view, 'a'))).toMatch(/遗忘之影/);
    expect(tileHint(tile(view, 'b'))).toMatch(/追问升级/);
    expect(tileHint(view.tiles.find((t) => !t.hasTerm)!)).toMatch(/荒地/);
  });

  it('cellLabel 用坐标说话', () => {
    expect(cellLabel({ row: -1, col: 2 })).toBe('坐标 (2, -1)');
  });
});
