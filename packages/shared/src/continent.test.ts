/**
 * shared/continent.test — 知识大陆铺格 / 怪种 / 出题 / 图鉴的派生口径锁。
 *
 * ★ 本文件锁的是「**同一份数据必得同一张地图**」这条承诺（头注口径 1）。断了它，用户每次刷新
 *   都会看到大陆重排、图鉴乱跳——那不是地图，是噪声；而这类 bug 在 UI 上只表现为"好像变了"，
 *   没有一条断言就会长期无人发现。
 * ★ 另两条最容易写错的：**题数 = 等级 = 血量**（`buildMonsterQuestions` 的长度）与
 *   **图鉴槽位是派生的**（改可用题型数它会自己变），故逐条钉死。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTINENT_CELLS,
  CONTINENT_CODEX_SLOTS,
  CONTINENT_COLS,
  CONTINENT_MAX_LEVEL,
  CONTINENT_PLAYABLE_QTYPES,
  CONTINENT_ROWS,
  buildMonsterQuestions,
  buildQuestion,
  codexDiscovered,
  codexSlot,
  codexSlotTypes,
  codexSlotsForTerm,
  continentHash,
  gradeAnswer,
  isDiscovered,
  layoutTiles,
  monsterLevel,
  monsterOccupies,
  normText,
  speciesKey,
  speciesTypes,
  spiralCells,
} from './continent.js';

interface T {
  id: string;
  term: string;
  definition: string;
  created_at: string;
}

const term = (n: number, createdAt = `2026-09-${`${n}`.padStart(2, '0')} 00:00:00`): T => ({
  id: `t${n}`,
  term: `词条${n}`,
  definition: `这是第 ${n} 个词条的释义内容`,
  created_at: createdAt,
});

/** 够出干扰项的池子（判断/选择/连线都要「别的词条」） */
const pool: T[] = Array.from({ length: 8 }, (_, i) => term(i + 1));

describe('continent / 铺格', () => {
  it('螺旋格子数 = 网格格数，且**无重复无越界**', () => {
    const cells = spiralCells(CONTINENT_COLS, CONTINENT_ROWS);
    expect(cells).toHaveLength(CONTINENT_CELLS);
    const keys = new Set(cells.map((c) => `${c.row},${c.col}`));
    expect(keys.size).toBe(CONTINENT_CELLS);
    for (const c of cells) {
      expect(c.row).toBeGreaterThanOrEqual(0);
      expect(c.row).toBeLessThan(CONTINENT_ROWS);
      expect(c.col).toBeGreaterThanOrEqual(0);
      expect(c.col).toBeLessThan(CONTINENT_COLS);
    }
  });

  it('第一个格子是网格中心（知识从中心长出来）', () => {
    const [first] = spiralCells(CONTINENT_COLS, CONTINENT_ROWS);
    expect(first).toEqual({ row: Math.floor(CONTINENT_ROWS / 2), col: Math.floor(CONTINENT_COLS / 2) });
  });

  it('铺格确定性：同输入两次结果一致，且**与输入数组顺序无关**', () => {
    const a = layoutTiles(pool);
    const b = layoutTiles([...pool].reverse());
    expect(a.map((t) => t.term.id)).toEqual([...pool].map((t) => t.id));
    expect(a).toEqual(b);
  });

  it('早入库的词条更靠中心（按 created_at 升序填螺旋序）', () => {
    const tiles = layoutTiles(pool);
    const first = tiles[0];
    expect(first?.term.id).toBe('t1');
  });

  it('超格截断：141 条只铺 140 格', () => {
    const many = Array.from({ length: 141 }, (_, i) => term(i + 1));
    expect(layoutTiles(many)).toHaveLength(CONTINENT_CELLS);
  });
});

describe('continent / 等级与怪种', () => {
  it('等级 = clamp(1 + floor(stage/2), 1, 3)', () => {
    expect([0, 1].map(monsterLevel)).toEqual([1, 1]);
    expect([2, 3].map(monsterLevel)).toEqual([2, 2]);
    expect([4, 5, 6, 7, 99].map(monsterLevel)).toEqual([3, 3, 3, 3, 3]);
  });

  it('怪种长度 = 等级，取值全在可用题型内，且**同 id 恒定**', () => {
    for (const id of ['t1', 't2', 'abcdef', '中文-id']) {
      for (let l = 1; l <= CONTINENT_MAX_LEVEL; l += 1) {
        const types = speciesTypes(id, l);
        expect(types).toHaveLength(l);
        for (const t of types) expect(CONTINENT_PLAYABLE_QTYPES).toContain(t);
        expect(speciesTypes(id, l)).toEqual(types);
      }
    }
  });

  it('怪种是**前缀稳定**的：升级只是往后长一型，不改已有位次（图鉴前缀槽据此单调）', () => {
    const one = speciesTypes('t1', 1);
    const two = speciesTypes('t1', 2);
    const three = speciesTypes('t1', 3);
    expect(two.slice(0, 1)).toEqual(one);
    expect(three.slice(0, 2)).toEqual(two);
  });

  it('speciesKey 可读', () => {
    expect(speciesKey(['judge', 'match'])).toBe('judge+match');
  });

  it('哈希确定性 + 不同输入基本不同', () => {
    expect(continentHash('a#0')).toBe(continentHash('a#0'));
    expect(continentHash('a#0')).not.toBe(continentHash('a#1'));
  });
});

describe('continent / 图鉴', () => {
  it('槽总数是**派生**的 = Σ|可用题型|^L', () => {
    const expected = [1, 2, 3]
      .map((l) => Math.pow(CONTINENT_PLAYABLE_QTYPES.length, l))
      .reduce((a, b) => a + b, 0);
    expect(CONTINENT_CODEX_SLOTS).toBe(expected);
    expect(CONTINENT_CODEX_SLOTS).toBe(84); // 四型可用时；scene 落地后应为 155
  });

  it('codexSlot 与 codexSlotTypes 互为逆（全槽遍历）', () => {
    for (let slot = 0; slot < CONTINENT_CODEX_SLOTS; slot += 1) {
      const types = codexSlotTypes(slot);
      expect(types.length).toBeGreaterThanOrEqual(1);
      expect(types.length).toBeLessThanOrEqual(CONTINENT_MAX_LEVEL);
      expect(codexSlot(types)).toBe(slot);
    }
  });

  it('有序：judge+match 与 match+judge 是两个槽（老板要的排列组合）', () => {
    expect(codexSlot(['judge', 'match'])).not.toBe(codexSlot(['match', 'judge']));
  });

  it('「已发现」= 有复习记录；无记录一条槽也不贡献', () => {
    expect(isDiscovered(0, null)).toBe(false);
    expect(isDiscovered(0, '2026-09-25 01:00:00')).toBe(true);
    expect(isDiscovered(1, null)).toBe(true);
    expect(codexSlotsForTerm('t1', 0, false)).toEqual([]);
    expect(codexSlotsForTerm('t1', 0, true)).toEqual([codexSlot(speciesTypes('t1', 1))]);
  });

  it('升级不丢前缀槽（1 级那格在 3 级时仍在集合里）', () => {
    const one = codexSlotsForTerm('t1', 1, true);
    const three = codexSlotsForTerm('t1', 4, true);
    expect(three).toHaveLength(3);
    for (const slot of one) expect(three).toContain(slot);
  });

  it('codexDiscovered 只收在册且已复习的词条', () => {
    const found = codexDiscovered([
      { ...term(1), review_stage: 0, last_reviewed_at: null },
      { ...term(2), review_stage: 0, last_reviewed_at: '2026-09-25 01:00:00' },
    ]);
    expect(found.size).toBe(1);
  });
});

describe('continent / 出题与判分', () => {
  it('题数 = 等级 = 血量；即便池子只有自己也能凑满', () => {
    const solo = [term(1)];
    for (let l = 1; l <= CONTINENT_MAX_LEVEL; l += 1) {
      expect(buildMonsterQuestions(term(1), l, pool)).toHaveLength(l);
      expect(buildMonsterQuestions(term(1), l, solo)).toHaveLength(l);
    }
  });

  it('判断题：真陈述用自己释义，假陈述用别人的释义，answer 与之一致', () => {
    const q = buildQuestion('judge', term(1), pool, 'seed');
    if (q === null || q.type !== 'judge') throw new Error('期望判断题');
    // 真陈述＝自己的释义；假陈述＝别人的释义（故**不含**自己的释义）
    expect(q.statement.includes(term(1).definition)).toBe(q.answer);
    expect(gradeAnswer(q, q.answer)).toBe(true);
    expect(gradeAnswer(q, !q.answer)).toBe(false);
  });

  it('选择题：正确项在 options 里且 answerIndex 指向它；选项确定不重排', () => {
    const q = buildQuestion('choice', term(1), pool, 'seed');
    if (q === null || q.type !== 'choice') throw new Error('期望选择题');
    expect(q.options[q.answerIndex]).toBe(term(1).definition);
    expect(buildQuestion('choice', term(1), pool, 'seed')).toEqual(q);
    expect(gradeAnswer(q, q.answerIndex)).toBe(true);
    expect(gradeAnswer(q, (q.answerIndex + 1) % q.options.length)).toBe(false);
  });

  it('填空题：释义含词条名则挖空，否则由释义写词条；两种答案都是词条名', () => {
    const withName = { id: 'x', term: '光合作用', definition: '光合作用 是植物把光能转为化学能的过程', created_at: '' };
    const a = buildQuestion('fill', withName, pool, 's');
    if (a === null || a.type !== 'fill') throw new Error('期望填空题');
    expect(a.prompt).toContain('____');
    expect(a.prompt).not.toContain('光合作用');
    expect(a.answer).toBe('光合作用');
    // 归一化判分：全角/标点/空白不影响
    expect(gradeAnswer(a, ' 光合作用 ')).toBe(true);
    expect(gradeAnswer(a, '')).toBe(false);
  });

  it('连线题：answer 是 left→right 的映射，全对才过', () => {
    const q = buildQuestion('match', term(1), pool, 'seed');
    if (q === null || q.type !== 'match') throw new Error('期望连线题');
    expect(q.left).toHaveLength(3);
    expect(q.right).toHaveLength(3);
    expect(gradeAnswer(q, q.answer)).toBe(true);
    const halfRight = [...q.answer];
    halfRight[0] = (halfRight[0] ?? 0) + 1;
    expect(gradeAnswer(q, halfRight)).toBe(false);
  });

  it('情景题是**显式空桩**：造题返回 null（不造假题污染血条）', () => {
    expect(buildQuestion('scene', term(1), pool, 'seed')).toBeNull();
  });

  it('monsterOccupies：只有「范围内 + 到期/逾期」才冒怪', () => {
    expect(monsterOccupies('due', true)).toBe(true);
    expect(monsterOccupies('overdue', true)).toBe(true);
    expect(monsterOccupies('due', false)).toBe(false); // 范围外点了必然 409 ⇒ 不许画成怪
    expect(monsterOccupies('upcoming', true)).toBe(false);
    expect(monsterOccupies('mastered', true)).toBe(false);
  });

  it('normText 归一：全角转半角、去空白与标点', () => {
    expect(normText(' ＡＢＣ，１２３ ')).toBe('abc123');
  });
});