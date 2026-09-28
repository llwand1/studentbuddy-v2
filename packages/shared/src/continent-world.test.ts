/**
 * continent-world.test — 开拓制大陆的**纯规则**锁：从零开拓、打怪开一片、难度随图长、建筑合成、一种题型组合一种怪。
 */
import { describe, it, expect } from 'vitest';
import {
  bindTerms, cellKey, delveQuizSize, detectBuildings, exploreCells, exploredCount, frontierCells, hpRoundsFor,
  isFrontier, maxComboFor, monsterCapFor, newWorld, parseWorld, qtypesFor, slayReward, tierFor, tokensLeft,
  visionFor, wildMonsters, buildSpeciesQuestions, type WorldSave,
} from './index.js';

function withLevels(cells: Array<[number, number, number]>): WorldSave {
  const w = newWorld(3);
  cells.forEach(([r, c, lv], i) => (w.cells[cellKey(r, c)] = { t: null, lv, n: i + 1 }));
  return w;
}

describe('从零开拓', () => {
  it('新世界只有出生点；迷雾边缘是它的四邻', () => {
    const w = newWorld(9);
    expect(exploredCount(w)).toBe(1);
    expect(frontierCells(w)).toHaveLength(4);
    expect(isFrontier(w, 0, 1)).toBe(true);
    expect(isFrontier(w, 0, 0)).toBe(false);
    expect(isFrontier(w, 2, 2)).toBe(false);
  });

  it('坏存档回落到新世界，不炸', () => {
    expect(exploredCount(parseWorld('{oops', 1))).toBe(1);
    expect(exploredCount(parseWorld(null, 1))).toBe(1);
  });

  it('exploreCells 只开新格，序号递增', () => {
    const w = newWorld(1);
    const fresh = exploreCells(w, [{ row: 0, col: 1 }, { row: 0, col: 0 }, { row: 1, col: 0 }]);
    expect(fresh).toHaveLength(2);
    expect(w.cells[cellKey(1, 0)]!.n).toBe(2);
  });

  it('bindTerms：新词条落在最早开拓的空地；删掉的词条让出地块', () => {
    const w = newWorld(1);
    exploreCells(w, [{ row: 0, col: 1 }]);
    bindTerms(w, ['a', 'b', 'c']);
    expect(w.cells[cellKey(0, 0)]!.t).toBe('a');
    expect(w.cells[cellKey(0, 1)]!.t).toBe('b');
    bindTerms(w, ['b']);
    expect(w.cells[cellKey(0, 0)]!.t).toBeNull();
  });

  it('开拓令＝起始 + 词条数 + 建筑奖励 − 已花', () => {
    const w = newWorld(1);
    w.spent = 3;
    expect(tokensLeft(w, 5, [])).toBe(4);
    expect(tokensLeft(w, 0, [])).toBe(0);
  });
});

describe('打怪与难度', () => {
  it('★ 有词条就刷怪（修「不刷怪」）；没词条不刷', () => {
    const w = newWorld(5);
    exploreCells(w, [{ row: 0, col: 1 }, { row: 1, col: 0 }, { row: 1, col: 1 }]);
    expect(wildMonsters(w, ['a'], 0).length).toBeGreaterThan(0);
    expect(wildMonsters(w, [], 0)).toHaveLength(0);
  });

  it('野怪都站在迷雾边缘、彼此不贴脸、血量 ≥ 组合长度', () => {
    const w = newWorld(11);
    for (let r = -3; r <= 3; r++) for (let c = -3; c <= 3; c++) exploreCells(w, [{ row: r, col: c }]);
    const ms = wildMonsters(w, ['a', 'b'], 2);
    for (const m of ms) {
      expect(isFrontier(w, m.row, m.col)).toBe(true);
      expect(m.hp).toBeGreaterThanOrEqual(m.species.length);
      for (const o of ms) if (o !== m) expect(Math.abs(o.row - m.row) + Math.abs(o.col - m.col)).toBeGreaterThan(1);
    }
  });

  it('★ 难度随地图增长：怪数上限、题型、组合长度、血量轮数都单调不减', () => {
    let prev = { t: 0, cap: 0, q: 0, combo: 0, hp: 0 };
    for (const n of [1, 8, 20, 40, 70, 110, 160, 230]) {
      const t = tierFor(n);
      const cur = { t, cap: monsterCapFor(t), q: qtypesFor(t).length, combo: maxComboFor(t), hp: hpRoundsFor(t) };
      expect(cur.t).toBeGreaterThan(prev.t);
      expect(cur.cap).toBeGreaterThanOrEqual(prev.cap);
      expect(cur.q).toBeGreaterThanOrEqual(prev.q);
      expect(cur.combo).toBeGreaterThanOrEqual(prev.combo);
      expect(cur.hp).toBeGreaterThanOrEqual(prev.hp);
      prev = cur;
    }
    expect(prev.cap).toBeGreaterThan(monsterCapFor(1));
  });

  it('★ 打倒一只怪一次开多格（含怪脚下），且都是新格', () => {
    const w = newWorld(4);
    const at = frontierCells(w)[0]!;
    const got = slayReward(w, at);
    expect(got.length).toBeGreaterThanOrEqual(3);
    expect(got[0]).toEqual(at);
    for (const c of got) expect(w.cells[cellKey(c.row, c.col)]).toBeUndefined();
  });

  it('一种题型组合一种怪：整套题的题型按组合循环', () => {
    const term = { id: 'a', term: '闭包', definition: '函数与其词法环境的组合', domain: 'js' };
    const pool = [term, { id: 'b', term: '原型', definition: '对象继承的来源', domain: 'js' }, { id: 'c', term: '提升', definition: '声明被移到作用域顶部', domain: 'js' }];
    const qs = buildSpeciesQuestions(term, ['judge', 'fill'], 4, pool);
    expect(qs).toHaveLength(4);
    expect(qs.map((q) => q.type)).toEqual(['judge', 'fill', 'judge', 'fill']);
  });

  it('追问题数随等级上升', () => {
    expect(delveQuizSize(0)).toBeLessThan(delveQuizSize(2));
  });
});

describe('建筑合成', () => {
  it('单独一块 3 级地 ⇒ 记忆石碑', () => {
    expect(detectBuildings(withLevels([[5, 5, 3]])).map((b) => b.kind)).toEqual(['stele']);
  });
  it('2×2 四块 2 级地 ⇒ 贤者书库（开拓令 +2）', () => {
    const b = detectBuildings(withLevels([[1, 1, 2], [1, 2, 2], [2, 1, 2], [2, 2, 2]]));
    expect(b.map((x) => x.kind)).toEqual(['library']);
    expect(tokensLeft(newWorld(1), 0, b)).toBe(4);
  });
  it('一字 3 块 1 级地 ⇒ 瞭望塔（视野 +2）', () => {
    const b = detectBuildings(withLevels([[1, 1, 1], [2, 1, 1], [3, 1, 1]]));
    expect(b.map((x) => x.kind)).toContain('tower');
    expect(visionFor(b)).toBe(4);
  });
  it('L 形 3 块 1 级地 ⇒ 篝火营地；一格只属于一座', () => {
    const b = detectBuildings(withLevels([[1, 1, 1], [2, 1, 1], [2, 2, 1]]));
    expect(b.map((x) => x.kind)).toEqual(['camp']);
  });
  it('零散 1 级地不成建筑', () => {
    expect(detectBuildings(withLevels([[0, 0, 1], [3, 3, 1]]))).toHaveLength(0);
  });
});
