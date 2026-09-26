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
import { CONTINENT_CELLS, CONTINENT_CODEX_SLOTS, codexSlotsForTerm, computeReviewState } from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import { buildContinentView, cellLabel, tileStatusText, type ContinentTileView } from './continent-view';

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

describe('buildContinentView 铺格', () => {
  it('越早入库越靠中心：第一条落在网格中心格，格数 = 词条数', () => {
    const view = buildContinentView([
      termOf('b', daysAgo(1)),
      termOf('a', daysAgo(5)),
      termOf('c', daysAgo(0)),
    ]);
    expect(view.tiles).toHaveLength(3);
    // 中心 = floor(rows/2)=5 行、floor(cols/2)=7 列（14×10）
    expect(view.tiles[0]?.id).toBe('a');
    expect(view.tiles[0]).toMatchObject({ row: 5, col: 7 });
    // 同为 0 行 0 列不可能；三格互不重叠（铺格是螺旋次序而非覆盖）
    expect(new Set(view.tiles.map((t) => `${t.row}:${t.col}`)).size).toBe(3);
  });

  it('超过 140 格截断：只图上 140 格，其余进 truncated 计数', () => {
    const many = Array.from({ length: CONTINENT_CELLS + 7 }, (_, i) => termOf(`t${i}`, daysAgo(i)));
    const view = buildContinentView(many);
    expect(view.tiles).toHaveLength(CONTINENT_CELLS);
    expect(view.truncated).toBe(7);
    expect(view.total).toBe(CONTINENT_CELLS + 7);
  });

  it('空库不炸：零格、零怪、图鉴总数仍由题型表派生', () => {
    const view = buildContinentView([]);
    expect(view.tiles).toEqual([]);
    expect(view.monsterCount).toBe(0);
    expect(view.codexTotal).toBe(CONTINENT_CODEX_SLOTS);
    expect(view.codexFound.size).toBe(0);
  });
});

describe('buildContinentView 怪与范围', () => {
  it('在范围内且逾期 ⇒ 冒怪；题数 = 等级 = 血量', () => {
    const view = buildContinentView([overdueTerm('a')]);
    const t = tile(view, 'a');
    expect(t.status).toBe('overdue');
    expect(t.hasMonster).toBe(true);
    expect(t.level).toBeGreaterThanOrEqual(1);
    expect(t.species).toHaveLength(t.level);
    expect(view.monsterCount).toBe(1);
    expect(view.dueOutOfScope).toBe(0);
  });

  it('★ 范围外到期**不冒怪**（点了必 409 的死路）——只计数给提示', () => {
    const view = buildContinentView([termOf('a', daysAgo(3))]);
    const t = tile(view, 'a');
    expect(t.inScope).toBe(false);
    expect(t.hasMonster).toBe(false);
    expect(t.level).toBe(0);
    expect(t.species).toEqual([]);
    expect(view.monsterCount).toBe(0);
    expect(view.dueOutOfScope).toBe(1);
  });

  it('今天到期（due）也冒怪；未到期（upcoming）不冒', () => {
    const view = buildContinentView([
      termOf('a', daysAgo(1), { review_in_scope: 1 }), // stage 0 间隔 1 天 ⇒ 今天到期
      termOf('b', daysAgo(0), { review_in_scope: 1 }), // 刚入库 ⇒ 未到期
    ]);
    expect(tile(view, 'a').status).toBe('due');
    expect(tile(view, 'a').hasMonster).toBe(true);
    expect(tile(view, 'b').status).toBe('upcoming');
    expect(tile(view, 'b').hasMonster).toBe(false);
  });

  it('等级由复习阶段派生：stage 0/1→1 级、4→3 级（题干数随之变）', () => {
    const view = buildContinentView([
      overdueTerm('a', { review_stage: 1 }),
      overdueTerm('b', { review_stage: 4, last_reviewed_at: daysAgo(20) }), // stage 4 间隔 15 天 ⇒ 仍逾期
    ]);
    expect(tile(view, 'a').level).toBe(1);
    expect(tile(view, 'a').species).toHaveLength(1);
    expect(tile(view, 'b').level).toBe(3);
    expect(tile(view, 'b').species).toHaveLength(3);
  });

  it('统计口径：inScopeCount / total / monsterCount 各按自己的分母算', () => {
    const view = buildContinentView([
      overdueTerm('a'),
      termOf('b', daysAgo(3), { review_in_scope: 1, review_stage: 6, last_reviewed_at: daysAgo(1) }), // 毕业，不催
      termOf('c', daysAgo(3)), // 范围外
      termOf('d', daysAgo(0), { review_in_scope: 1 }),
    ]);
    expect(view.total).toBe(4);
    expect(view.inScopeCount).toBe(3); // a/b/d 在范围内；c 不在
    expect(view.monsterCount).toBe(1); // 只有 a 同时满足「在范围内 + 到期」
    expect(view.dueOutOfScope).toBe(1); // 只有 c 是「到期但没纳入」
  });
});

describe('buildContinentView 图鉴', () => {
  it('无复习记录 ⇒ 一格不亮（图鉴靠复习行为解锁，不是靠有词条）', () => {
    const view = buildContinentView([overdueTerm('a')]);
    expect(tile(view, 'a').discovered).toBe(false);
    expect(view.codexFound.size).toBe(0);
  });

  it('有复习记录 ⇒ 亮出该词条当前等级对应的槽（且与派生函数一致）', () => {
    const view = buildContinentView([overdueTerm('a', { review_stage: 2, last_reviewed_at: daysAgo(1) })]);
    expect(tile(view, 'a').discovered).toBe(true);
    const expected = codexSlotsForTerm('a', 2, true);
    expect(expected.length).toBeGreaterThan(0);
    for (const slot of expected) expect(view.codexFound.has(slot)).toBe(true);
  });
});

describe('文案口径', () => {
  it('tileStatusText：范围外 / 逾期 / 今天到期 / 已入长期记忆各说各的话', () => {
    const view = buildContinentView([
      termOf('out', daysAgo(3)),
      overdueTerm('over'),
      termOf('due', daysAgo(1), { review_in_scope: 1 }),
      termOf('done', daysAgo(40), { review_in_scope: 1, review_stage: 7, last_reviewed_at: daysAgo(1) }),
    ]);
    expect(tileStatusText(tile(view, 'out'))).toContain('未纳入复习范围');
    expect(tileStatusText(tile(view, 'over'))).toContain('逾期');
    expect(tileStatusText(tile(view, 'due'))).toContain('今天该复习');
    expect(tileStatusText(tile(view, 'done'))).toContain('长期记忆');
  });

  it('cellLabel 用 1 起的行列号（写「第 1 行」而不是「第 0 行」）', () => {
    expect(cellLabel({ row: 5, col: 7 })).toBe('第 6 行 · 第 8 列');
  });
});