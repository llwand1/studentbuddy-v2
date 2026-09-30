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
import { CONTINENT_CODEX_SLOTS, codexSlotsForTerm, computeReviewState, worldCells, worldRadiusFor } from '@sb/shared';
import type { ContinentMapTerm } from '../../lib/api-terms-continent';
import {
  buildContinentView,
  canStrike,
  cellHint,
  cellLabel,
  fightTile,
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
    last_used_at: null,
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
    // ★ 世界模型下中心恒为世界原点 (0,0)，**与视口大小无关**——这正是"加词不挪旧格"的前提
    expect(view.tiles[0]?.id).toBe('a');
    expect(view.tiles[0]).toMatchObject({ row: 0, col: 0 });
    // 同为 0 行 0 列不可能；三格互不重叠（铺格是螺旋次序而非覆盖）
    expect(new Set(view.tiles.map((t) => `${t.row}:${t.col}`)).size).toBe(3);
  });

  it('★ 开放世界：不再有 140 格截断——327 条全上地图，半径与格数由词条数派生', () => {
    const many = Array.from({ length: 327 }, (_, i) => termOf(`t${i}`, daysAgo(i)));
    const view = buildContinentView(many);
    expect(view.tiles).toHaveLength(327);
    expect(view.total).toBe(327);
    expect(view.radius).toBe(9);
    expect(worldCells(view.radius)).toBe(361);
    expect(worldRadiusFor(327)).toBe(view.radius);
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

describe('野怪（每日随机保底刷怪，2026-09-29）', () => {
  const DAY = '2026-09-26';

  it('★ 新用户：唯一一条范围外的新词条也冒怪——`monsterKind=wild`，不算欠账怪、不占地、不可通行', () => {
    const view = buildContinentView([termOf('a', daysAgo(0))], { dayKey: DAY });
    const t = tile(view, 'a');
    expect(t.hasMonster).toBe(true);
    expect(t.monsterKind).toBe('wild');
    expect(t.inScope).toBe(false);
    expect(t.level).toBe(1);
    expect(t.species).toHaveLength(1);
    expect(t.walkable).toBe(false);
    expect(view.wildCount).toBe(1);
    expect(view.monsterCount).toBe(0);
    expect(view.wildLands).toEqual([]);
    expect(t.territoryCount).toBe(0);
    expect(tileStatusText(t)).toContain('野怪');
    expect(tileStatusText(t)).toContain('打赢即纳入');
  });

  it('不传 dayKey ⇒ 不刷野怪（服务端/旧调用方的口径不变）；传了同一天恒同', () => {
    const terms = Array.from({ length: 12 }, (_, i) => termOf(`t${i}`, daysAgo(0)));
    expect(buildContinentView(terms).wildCount).toBe(0);
    const a = buildContinentView(terms, { dayKey: DAY });
    const b = buildContinentView(terms, { dayKey: DAY });
    expect(a.wildCount).toBe(2); // 1 + floor(12/8)
    expect(a.tiles.filter((t) => t.monsterKind === 'wild').map((t) => t.id)).toEqual(
      b.tiles.filter((t) => t.monsterKind === 'wild').map((t) => t.id),
    );
  });

  it('欠账怪优先：范围内逾期的词条是 due 怪，不会同时是野怪；两种怪分开计数', () => {
    const view = buildContinentView([overdueTerm('a'), termOf('b', daysAgo(0))], { dayKey: DAY });
    expect(tile(view, 'a').monsterKind).toBe('due');
    expect(view.monsterCount).toBe(1);
    expect(view.wildCount + view.monsterCount).toBeLessThanOrEqual(2);
  });

  it('今天复习过的词条不会被野怪盯上（打赢即消失的机制就靠这一条）', () => {
    const view = buildContinentView([termOf('a', daysAgo(3), { review_stage: 1, last_reviewed_at: daysAgo(0) })], { dayKey: DAY });
    expect(tile(view, 'a').hasMonster).toBe(false);
    expect(view.wildCount).toBe(0);
  });
});

describe('开拓：边界「+」与钉子', () => {
  it('★ 单条词条：四邻全是边界；世界半径留着下一块地的位置', () => {
    const view = buildContinentView([termOf('a', daysAgo(0))]);
    expect(view.frontier).toEqual([
      { row: -1, col: 0 },
      { row: 0, col: -1 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
    ]);
    expect(view.radius).toBeGreaterThanOrEqual(worldRadiusFor(2));
  });

  it('怪的荒地领地不画「+」（那格已是红边领地）', () => {
    const view = buildContinentView([deepTerm('a')]);
    expect(view.wildLands.length).toBeGreaterThan(0);
    for (const w of view.wildLands) expect(view.frontier).not.toContainEqual({ row: w.row, col: w.col });
    expect(view.frontier.length).toBeGreaterThan(0);
  });

  it('钉子：开拓出来的词条落在钉的那一格，其余照旧螺旋', () => {
    const terms = [termOf('a', daysAgo(2)), termOf('b', daysAgo(1)), termOf('c', daysAgo(0))];
    const plain = buildContinentView(terms);
    const pinned = buildContinentView(terms, { pins: [{ id: 'c', row: -3, col: 2 }] });
    expect(tile(pinned, 'c')).toMatchObject({ row: -3, col: 2 });
    expect(tile(pinned, 'a')).toMatchObject({ row: tile(plain, 'a').row, col: tile(plain, 'a').col });
    expect(tile(pinned, 'b')).toMatchObject({ row: tile(plain, 'b').row, col: tile(plain, 'b').col });
    // 钉出去的地块自己也长边界
    expect(pinned.frontier).toContainEqual({ row: -4, col: 2 });
  });

  it('cellHint：边界格说「点它开拓」，非边界空格说「走不过去」', () => {
    const view = buildContinentView([termOf('a', daysAgo(0))]);
    const ctx = { tiles: view.tiles, wildLands: view.wildLands, npcs: [], frontier: view.frontier };
    expect(cellHint({ row: 0, col: 1 }, ctx)).toContain('开拓');
    expect(cellHint({ row: 3, col: 3 }, ctx)).toContain('走不过去');
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
describe('地块维护：磨损与废墟（2026-09-30）', () => {
  const DAY = '2026-09-26';

  it('★ 同样 20 天没碰：中心那块完好，铺到第 7 环的那块已是废墟；废墟仍是词条格、可通行、不冒怪、不占地', () => {
    // 145 条今天刚入库的普通词条铺满前 6 环（1+8+…+48 = 169 > 145，够把 a/b 顶到第 6、7 环外）
    const filler = Array.from({ length: 200 }, (_, i) => termOf(`f${i}`, daysAgo(0)));
    const center = termOf('c', daysAgo(20), { created_at: daysAgo(30) }); // 最早入库 ⇒ 中心格
    const rim = termOf('r', daysAgo(20), { created_at: daysAgo(0), id: 'r' });
    // 让 rim 排在 filler 之后（created_at 同为今天时按 id：'r' > 'f…'）
    const view = buildContinentView([center, ...filler, rim]);
    const c = tile(view, 'c');
    const r = tile(view, 'r');
    expect(c.ring).toBe(0);
    expect(r.ring).toBeGreaterThanOrEqual(7); // 第 7 环耐久 10 天 < 20 天
    expect(c.ruin).toBe(false);
    expect(c.wear).toBeCloseTo(20 / 120, 5);
    expect(r.ruin).toBe(true);
    expect(r.wear).toBe(1);
    expect(r.walkable).toBe(true);
    expect(r.hasMonster).toBe(false);
    expect(view.ruinCount).toBe(1);
    expect(view.intactCount).toBe(view.tiles.length - 1);
    expect(view.landCount).toBe(0);
    expect(tileStatusText(r)).toContain('废墟');
    expect(tileStatusText(r)).toContain('复习一次即重建');
    expect(tileHint(r)).toContain('点它复习重建');
    // 起裂提醒：磨损 ≥ 0.5 才说
    expect(tileHint(c)).not.toContain('起裂');
  });

  it('废墟上照样能冒怪（欠账 / 野怪 / 话题），怪的口径不因废墟改变', () => {
    const filler = Array.from({ length: 200 }, (_, i) => termOf(`f${i}`, daysAgo(0)));
    const rim = termOf('r', daysAgo(20), { created_at: daysAgo(0), review_in_scope: 1 }); // 范围内、逾期 ⇒ 欠账怪
    const view = buildContinentView([...filler, rim], { dayKey: DAY });
    const r = tile(view, 'r');
    expect(r.ruin).toBe(true);
    expect(r.monsterKind).toBe('due');
    expect(r.walkable).toBe(false);
  });

  it('长期记忆是基石：mastered 的边缘地块放一年也不碎', () => {
    const filler = Array.from({ length: 200 }, (_, i) => termOf(`f${i}`, daysAgo(0)));
    const rim = termOf('r', daysAgo(0), { created_at: daysAgo(0), review_in_scope: 1, review_stage: 7, last_reviewed_at: daysAgo(365) });
    const r = tile(buildContinentView([...filler, rim]), 'r');
    expect(r.status).toBe('mastered');
    expect(r.wear).toBe(0);
    expect(r.ruin).toBe(false);
    expect(tileStatusText(r)).toContain('基石');
  });

  it('fightTile：废墟没有怪 ⇒ 就地立"废墟守卫"（等级/怪种按同一套派生，不改 hasMonster）；有怪的原样返回', () => {
    const filler = Array.from({ length: 200 }, (_, i) => termOf(`f${i}`, daysAgo(0)));
    const rim = termOf('r', daysAgo(20), { created_at: daysAgo(0), review_stage: 4 });
    const r = tile(buildContinentView([...filler, rim]), 'r');
    expect(r.level).toBe(0);
    const f = fightTile(r);
    expect(f.hasMonster).toBe(false);
    expect(f.level).toBe(3); // monsterLevel(4)
    expect(f.species).toHaveLength(3);
    const due = tile(buildContinentView([overdueTerm('a')]), 'a');
    expect(fightTile(due)).toBe(due);
  });
});

describe('话题怪：对话里提到的词条今天冒怪（2026-09-30）', () => {
  const DAY = '2026-09-26';

  it('★ 今天提到过（last_used_at 今天）且不是欠账怪 ⇒ monsterKind=topic：不占地、范围外也出、文案说"话题怪"', () => {
    const talked = termOf('t', daysAgo(0), { last_used_at: daysAgo(0) });
    const quiet = termOf('q', daysAgo(0), { last_used_at: daysAgo(2) });
    const view = buildContinentView([talked, quiet], { dayKey: DAY });
    const t = tile(view, 't');
    expect(t.monsterKind).toBe('topic');
    expect(t.hasMonster).toBe(true);
    expect(t.walkable).toBe(false);
    expect(t.territoryCount).toBe(0);
    expect(view.topicCount).toBe(1);
    expect(view.landCount).toBe(0);
    expect(tile(view, 'q').monsterKind === 'topic').toBe(false);
    expect(tileStatusText(t)).toContain('话题怪');
    expect(tileStatusText(t)).toContain('打赢即纳入');
    expect(tileHint(t)).toContain('话题怪');
  });

  it('欠账怪优先于话题怪；不传 dayKey 不刷话题怪；今天复习过的不出', () => {
    const due = overdueTerm('a', { last_used_at: daysAgo(0) });
    expect(tile(buildContinentView([due], { dayKey: DAY }), 'a').monsterKind).toBe('due');
    const talked = termOf('t', daysAgo(0), { last_used_at: daysAgo(0) });
    expect(tile(buildContinentView([talked]), 't').monsterKind).toBeNull();
    const reviewed = termOf('r', daysAgo(3), { last_used_at: daysAgo(0), review_stage: 1, last_reviewed_at: daysAgo(0) });
    expect(tile(buildContinentView([reviewed], { dayKey: DAY }), 'r').monsterKind).not.toBe('topic');
  });
});
