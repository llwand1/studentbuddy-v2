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
import {
  buildContinentView,
  canStrike,
  cellLabel,
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

/** 逾期 4 天且在范围内 ⇒ `landCountFor(4) = 3`（本体 1 格 + 向外占 2 格） */
function deepTerm(id = 'a'): ContinentMapTerm {
  return termOf(id, daysAgo(5), { review_in_scope: 1 });
}

/**
 * 铺满内圈的普通词条（今天入库 ⇒ 不冒怪）。
 * ★ 为什么要它：只有一条词条时，怪四周全是**荒地**，领地只能落进 `wildLands`；
 *   要验证「领地压在**词条格**上」这条口径，就必须让中心怪的邻居都是词条格。
 */
function ringTerms(): ContinentMapTerm[] {
  return ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id) => termOf(id, daysAgo(0)));
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

describe('buildContinentView 领地与可通行', () => {
  it('逾期越久，怪向外占的地越多；地盘数按「本体 + 领地」一起数', () => {
    const view = buildContinentView([deepTerm()]);
    expect(tile(view, 'a').status).toBe('overdue');
    expect(tile(view, 'a').overdueDays).toBe(4);
    expect(view.landCount).toBe(2); // landCountFor(4)=3，减去本体那一格
    // ★ 库里只有这一条词条 ⇒ 怪四周全是**没铺过词条的荒地** ⇒ 2 格领地只能落在 `wildLands`，
    //   而 `tiles` 里一格领地都没有（这正是"必须单列 wildLands"的原因，见 ContinentView 头注）
    expect(view.wildLands).toHaveLength(2);
    expect(view.tiles.filter((t) => t.isLand)).toHaveLength(0);
    for (const l of view.wildLands) {
      expect(l.owner).toBe('a');
      expect(l.ownerTerm).toBe('词条a');
      expect(l.count).toBe(3); // 本体 1 + 领地 2
    }
    // 荒地上没有 tile ⇒ 领地格不可能被算成"有怪"（怪只在**本体**那一格）
    expect(view.tiles.filter((t) => t.hasMonster)).toHaveLength(1);
  });

  it('★ 领地落在**词条格**上时（多词条）：那一格变墙，并带上领主信息', () => {
    // 内圈铺满词条 ⇒ 中心那只怪的四个邻居全是词条格，取 2 格领地必然吃掉词条格（demo 口径「词条格优先」）
    const view = buildContinentView([deepTerm('a'), ...ringTerms()]);
    const termLands = view.tiles.filter((t) => t.isLand);
    expect(termLands.length).toBeGreaterThan(0);
    for (const l of termLands) {
      expect(l.landOwner).toBe('a');
      expect(l.landOwnerTerm).toBe('词条a');
      expect(l.territoryCount).toBe(3);
      expect(l.walkable).toBe(false); // 领地是墙：挡路才让"绕开或先打怪"成为选择
      expect(l.hasMonster).toBe(false); // 怪只在**本体**那一格
    }
    // 守恒：词条格吞掉的 + 荒地吞掉的 = landCount（两处加起来才是"大陆被啃了多少"）
    expect(termLands.length + view.wildLands.length).toBe(view.landCount);
  });

  it('今天才到期（overdueDays = 0）⇒ 一格也不占：刚冒的怪还没长出地盘', () => {
    const view = buildContinentView([termOf('a', daysAgo(1), { review_in_scope: 1 })]);
    expect(tile(view, 'a').status).toBe('due');
    expect(tile(view, 'a').overdueDays).toBe(0);
    expect(view.landCount).toBe(0);
    expect(view.wildLands).toEqual([]);
  });

  it('收复（不冒怪）之后地盘全归：范围外的逾期词条不占任何格', () => {
    const view = buildContinentView([termOf('a', daysAgo(5))]); // 范围外 ⇒ 不冒怪
    expect(view.monsterCount).toBe(0);
    expect(view.landCount).toBe(0);
    expect(view.wildLands).toEqual([]);
    expect(tile(view, 'a').walkable).toBe(true);
  });

  it('★ 英雄脚下那格不会被吞成领地（「站在哪」看得见后果）', () => {
    const plain = buildContinentView([deepTerm()]);
    const land = plain.wildLands[0];
    if (!land) throw new Error('这名怪应该占出地盘来');
    const stood = buildContinentView([deepTerm()], { hero: { row: land.row, col: land.col } });
    // 站上去的那一格既不在荒地里、也不在任何 tile 的领地标记里
    expect(stood.wildLands.some((l) => l.row === land.row && l.col === land.col)).toBe(false);
    expect(stood.tiles.some((t) => t.row === land.row && t.col === land.col && t.isLand)).toBe(false);
    expect(stood.landCount).toBe(plain.landCount); // 只换位置，不少占（候选 > 需求）
  });

  it('怪的本体格也不可通行（本体与领地都挡路）', () => {
    const view = buildContinentView([deepTerm()]);
    expect(tile(view, 'a').walkable).toBe(false);
  });
});

describe('走位与「靠近才开打」', () => {
  it('initialHeroCell：取铺格序里第一格可通行地（＝最靠中心那块没被占的）', () => {
    // 中心那格是怪（不可通行），内圈还有 2 格被它占成领地 ⇒ 起点必须跳过这些
    const view = buildContinentView([deepTerm('a'), ...ringTerms()]);
    const start = initialHeroCell(view.tiles);
    expect(start?.walkable).toBe(true);
    // 「第一格」的意思：在它之前的地块一个都不该可通行（否则起点就不是最靠中心的）
    const at = view.tiles.findIndex((t) => t.id === start?.id);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(view.tiles.slice(0, at).every((t) => !t.walkable)).toBe(true);
  });

  it('initialHeroCell：整张图一格可通行地都没有时退到第一格（不许返回 null 让页面没英雄）', () => {
    const view = buildContinentView([termOf('a', daysAgo(5), { review_in_scope: 1 })]);
    expect(initialHeroCell(view.tiles)?.id).toBe('a');
  });

  it('canStrike：正相邻才算够得着；同格也放行（否则"库里只有一条词条"的新手第一步就卡死）', () => {
    expect(manhattan({ row: 1, col: 1 }, { row: 1, col: 2 })).toBe(1);
    expect(canStrike({ row: 1, col: 1 }, { row: 1, col: 2 })).toBe(true);
    expect(canStrike({ row: 1, col: 1 }, { row: 1, col: 1 })).toBe(true);
    expect(canStrike({ row: 1, col: 1 }, { row: 1, col: 3 })).toBe(false);
    expect(canStrike({ row: 3, col: 3 }, { row: 3, col: 4 })).toBe(true);
    expect(canStrike(null, { row: 1, col: 2 })).toBe(false);
  });

  it('tileHint 三种说法各不相同（怪要"走到旁边"，领地要"复习领主"）', () => {
    const view = buildContinentView([deepTerm('a'), ...ringTerms()]);
    expect(tileHint(tile(view, 'a'))).toContain('走到旁边');
    // 找一块**既没怪也不是领地**的地：它的说法才是"已收复"
    const free = view.tiles.find((t) => t.walkable);
    if (!free) throw new Error('内圈铺了 8 条词条，总该有几格是空的');
    expect(tileHint(free)).toContain('已收复');
    // 领地那格（词条格被吞）说法又不同：点它是去复习**领主**
    const land = view.tiles.find((t) => t.isLand);
    if (!land) throw new Error('这名怪应该占出地盘来');
    expect(tileHint(land)).toContain('复习领主');
  });
});

describe('文案口径', () => {
  it('tileStatusText：范围外 / 未到期 / 已入长期记忆各说各的话（无怪 ⇒ 没有领地把它们吞掉）', () => {
    const view = buildContinentView([
      termOf('out', daysAgo(3)), // 范围外（有欠账但不冒怪）
      termOf('soon', daysAgo(0), { review_in_scope: 1 }), // 未到期
      termOf('done', daysAgo(40), { review_in_scope: 1, review_stage: 7, last_reviewed_at: daysAgo(1) }),
    ]);
    expect(view.monsterCount).toBe(0);
    expect(view.landCount).toBe(0);
    expect(tileStatusText(tile(view, 'out'))).toContain('未纳入复习范围');
    expect(tileStatusText(tile(view, 'soon'))).toContain('还有');
    expect(tileStatusText(tile(view, 'done'))).toContain('长期记忆');
  });

  it('tileStatusText：怪本体说「逾期 N 天」；今天到期的说「今天该复习」', () => {
    // ★ 分开各来一条、各成一张图：多词条时相邻的词条格会被吞成领地，那样读到的是领地文案而不是本体文案
    const late = buildContinentView([overdueTerm('over')]);
    expect(tile(late, 'over').hasMonster).toBe(true);
    expect(tile(late, 'over').landOwner).toBeNull(); // 本体永远不会变成领地
    expect(tileStatusText(tile(late, 'over'))).toContain('逾期');

    const today = buildContinentView([termOf('due', daysAgo(1), { review_in_scope: 1 })]);
    expect(tile(today, 'due').hasMonster).toBe(true);
    expect(tileStatusText(tile(today, 'due'))).toContain('今天该复习');
  });

  it('cellLabel 用 1 起的行列号（写「第 1 行」而不是「第 0 行」）', () => {
    expect(cellLabel({ row: 5, col: 7 })).toBe('第 6 行 · 第 8 列');
  });
});