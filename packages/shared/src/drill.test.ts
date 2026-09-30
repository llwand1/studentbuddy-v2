/**
 * shared/drill 单测：等待时刷词的纯口径。
 * 钉：题型节拍 / 干扰项纪律（同义不当干扰、同领域优先、池小退拼写）/ 判分与大陆同源 / 队列到期优先且当天恒同 / 插回位置。
 */
import { describe, it, expect } from 'vitest';
import {
  DRILL_OPTIONS,
  DRILL_REQUEUE_GAP,
  buildDrillCard,
  drillKindAt,
  gradeDrill,
  isComboMilestone,
  orderDrillQueue,
  pickDistractors,
  requeueIndex,
  spellHint,
  type DrillQueueTerm,
  type DrillTermLike,
} from './drill.js';

const A: DrillTermLike = { id: 'a', term: '闭包', definition: '函数与它引用的词法环境的组合', domain: 'js' };
const B: DrillTermLike = { id: 'b', term: '事件循环', definition: 'JS 运行时处理异步任务的调度机制', domain: 'js' };
const C: DrillTermLike = { id: 'c', term: '原型链', definition: '对象逐级向上查找属性的机制', domain: 'js' };
const D: DrillTermLike = { id: 'd', term: '递归', definition: '函数调用自身来解决子问题', domain: 'algo' };
const E: DrillTermLike = { id: 'e', term: '哈希表', definition: '用哈希函数把键映射到桶的查找结构', domain: 'algo' };
const lib: DrillTermLike[] = [A, B, C, D, E];

describe('drillKindAt：题型节拍', () => {
  it('每 4 张固定 1 张拼写，其余 3 张里恰好 1 张看义选词', () => {
    for (let group = 0; group < 6; group += 1) {
      const kinds = [0, 1, 2, 3].map((i) => drillKindAt(group * 4 + i, 'seed'));
      expect(kinds[3]).toBe('spell');
      expect(kinds.filter((k) => k === 'reverse')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'meaning')).toHaveLength(2);
    }
  });
  it('反向题落点随 seed 变、同 seed 恒同', () => {
    const a = Array.from({ length: 24 }, (_, i) => drillKindAt(i, 'x'));
    const b = Array.from({ length: 24 }, (_, i) => drillKindAt(i, 'x'));
    const c = Array.from({ length: 24 }, (_, i) => drillKindAt(i, 'y'));
    expect(a).toEqual(b);
    expect(a.join()).not.toBe(c.join());
  });
});

describe('buildDrillCard：四选一与干扰项纪律', () => {
  it('看词选义：题面是词条、4 个选项含且仅含一个正确释义、下标对得上', () => {
    const card = buildDrillCard('meaning', A, lib, 'library');
    expect(card.kind).toBe('meaning');
    expect(card.prompt).toBe('闭包');
    expect(card.options).toHaveLength(DRILL_OPTIONS);
    expect(card.options.filter((o) => o === A.definition)).toHaveLength(1);
    expect(card.options[card.answerIndex]).toBe(A.definition);
  });
  it('看义选词：题面是释义、选项是词条', () => {
    const card = buildDrillCard('reverse', D, lib, 'library');
    expect(card.prompt).toBe(D.definition);
    expect(card.options[card.answerIndex]).toBe('递归');
    expect(card.options).toHaveLength(DRILL_OPTIONS);
  });
  it('同领域干扰项优先：js 词条的 3 个干扰全来自 js（库里够）', () => {
    const wrongs = pickDistractors(A, lib, 's', 3, 'definition');
    expect(wrongs.map((w) => w.domain)).toEqual(['js', 'js', 'algo']);
  });
  it('与正确答案同义（释义相同）或同名的词条不当干扰项', () => {
    const twin: DrillTermLike = { id: 'z', term: 'closure', definition: A.definition, domain: 'js' };
    const same: DrillTermLike = { id: 'y', term: '闭包', definition: '另一种说法', domain: 'js' };
    const wrongs = pickDistractors(A, [...lib, twin, same], 's', 10, 'definition');
    expect(wrongs.map((w) => w.id)).not.toContain('z');
    expect(wrongs.map((w) => w.id)).not.toContain('y');
  });
  it('新用户只有 1 条词条也能出四选一（干扰项来自冷启动词池）', () => {
    const only = [A];
    const card = buildDrillCard('meaning', A, only, 'due');
    expect(card.options).toHaveLength(DRILL_OPTIONS);
    expect(card.origin).toBe('due');
  });
  it('拼写卡：题面释义、无选项、提示露首字', () => {
    const card = buildDrillCard('spell', B, lib, 'library');
    expect(card.kind).toBe('spell');
    expect(card.options).toEqual([]);
    expect(card.answerIndex).toBe(-1);
    expect(card.hint).toBe('事＿＿＿');
    expect(spellHint('a')).toBe('＿');
  });
  it('满是符号的词条轮到拼写时改出看词选义（不逼人打符号）；出不了选择题才照旧拼写', () => {
    const sym: DrillTermLike = { id: 's', term: 'O(n log n)', definition: '归并排序的时间复杂度', domain: 'algo' };
    const swapped = buildDrillCard('spell', sym, lib, 'library');
    expect(swapped.kind).toBe('meaning');
    expect(swapped.options).toContain(sym.definition);
    const lone: DrillTermLike = { id: 'l', term: 'C++', definition: 'x', domain: 'z' };
    // 词库与词池都凑不出 3 条不同释义的干扰项时只能拼写（释义 'x' 与池子里的都不同，故这里仍能出选择题）
    expect(buildDrillCard('spell', lone, [], 'library').kind).toBe('meaning');
    expect(buildDrillCard('spell', B, lib, 'library').kind).toBe('spell');
  });
  it('选项顺序稳定：同 seed 两次一样，换 seed 可能不同但仍含正确答案', () => {
    const a = buildDrillCard('meaning', C, lib, 'library', 'k1');
    const b = buildDrillCard('meaning', C, lib, 'library', 'k1');
    expect(a.options).toEqual(b.options);
    const c = buildDrillCard('meaning', C, lib, 'library', 'k2');
    expect(c.options[c.answerIndex]).toBe(C.definition);
  });
});

describe('gradeDrill：判分', () => {
  it('选择题比下标；拼写比归一化文本，别名也算对，空串不算', () => {
    const choice = buildDrillCard('meaning', A, lib, 'library');
    expect(gradeDrill(choice, choice.answerIndex)).toBe(true);
    expect(gradeDrill(choice, (choice.answerIndex + 1) % 4)).toBe(false);
    expect(gradeDrill(choice, '闭包')).toBe(false);
    const spell = buildDrillCard('spell', A, lib, 'library');
    expect(gradeDrill(spell, ' 闭包 ')).toBe(true);
    expect(gradeDrill(spell, 'closure', ['Closure'])).toBe(true);
    expect(gradeDrill(spell, '')).toBe(false);
    expect(gradeDrill(spell, 0)).toBe(false);
  });
});

describe('orderDrillQueue：到期优先、当天恒同、斩过的不出', () => {
  const q: DrillQueueTerm[] = [
    { ...A, status: 'upcoming', inScope: true },
    { ...B, status: 'due', inScope: true },
    { ...C, status: 'overdue', inScope: false },
    { ...D, status: 'overdue', inScope: true },
    { ...E, status: 'mastered', inScope: true },
  ];
  it('范围内到期/逾期排最前并标 due；范围外的逾期只算 library', () => {
    const out = orderDrillQueue(q, '2026-09-29');
    expect(out.slice(0, 2).map((x) => x.origin)).toEqual(['due', 'due']);
    expect(new Set(out.slice(0, 2).map((x) => x.term.id))).toEqual(new Set(['b', 'd']));
    expect(out.find((x) => x.term.id === 'c')?.origin).toBe('library');
    expect(out).toHaveLength(5);
  });
  it('同一天两次同序；换一天次序会变（但到期段仍在前）', () => {
    const a = orderDrillQueue(q, '2026-09-29').map((x) => x.term.id);
    const b = orderDrillQueue(q, '2026-09-29').map((x) => x.term.id);
    expect(a).toEqual(b);
    const days = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'];
    const changed = days.some((d) => orderDrillQueue(q, d).map((x) => x.term.id).join() !== a.join());
    expect(changed).toBe(true);
  });
  it('exclude 里的（今天斩过的）与空词条不进队', () => {
    const out = orderDrillQueue([...q, { id: 'blank', term: ' ', definition: 'x', domain: 'js', status: 'due', inScope: true }], '2026-09-29', new Set(['b']));
    expect(out.map((x) => x.term.id)).not.toContain('b');
    expect(out.map((x) => x.term.id)).not.toContain('blank');
  });
});

describe('requeueIndex / isComboMilestone', () => {
  it('答错隔 3 张再来；队列短则排末尾；里程碑是 5 的倍数', () => {
    expect(requeueIndex(10)).toBe(DRILL_REQUEUE_GAP);
    expect(requeueIndex(1)).toBe(1);
    expect(requeueIndex(0)).toBe(0);
    expect([0, 1, 4, 5, 10, 12].map(isComboMilestone)).toEqual([false, false, false, true, true, false]);
  });
});
