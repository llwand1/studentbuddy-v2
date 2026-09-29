/**
 * continent-wild.test — 野怪（每日随机保底刷怪）的纯口径。
 *
 * 锁四件事：
 *  ① 数量：`1 + floor(n/8)` 夹 `[1, 8]`，零词条零野怪——**一条词条也有一只**（新用户保底）。
 *  ② 出场资格：欠账怪不重复出；今天复习过的不出（打赢即消失的机制就靠这一条）；**范围外也出**。
 *  ③ 同一天恒同、换一天换一批；配额对全部词条排名——打掉一只不会有下一只顶上来（不是无限刷）。
 *  ④ `monsterKindOf`：欠账怪优先于野怪。
 */
import { describe, expect, it } from 'vitest';
import {
  WILD_MONSTER_MAX,
  monsterKindOf,
  reviewedToday,
  wildEligible,
  wildMonsterCountFor,
  wildMonsterIds,
  type ContinentSpawnTerm,
} from './index.js';

function term(id: string, over: Partial<ContinentSpawnTerm['review']> = {}, inScope = 0): ContinentSpawnTerm {
  return { id, review_in_scope: inScope, review: { status: 'upcoming', basis: 'created', daysSince: 0, ...over } };
}

describe('wildMonsterCountFor — 数量', () => {
  it('① 0 ⇒ 0；1..7 ⇒ 1；8 ⇒ 2；56+ ⇒ 封顶 8', () => {
    expect(wildMonsterCountFor(0)).toBe(0);
    expect(wildMonsterCountFor(1)).toBe(1);
    expect(wildMonsterCountFor(7)).toBe(1);
    expect(wildMonsterCountFor(8)).toBe(2);
    expect(wildMonsterCountFor(56)).toBe(WILD_MONSTER_MAX);
    expect(wildMonsterCountFor(5000)).toBe(WILD_MONSTER_MAX);
  });
});

describe('wildEligible — 出场资格', () => {
  it('② 刚入库（basis=created, 0 天）可出；今天复习过（basis=review, 0 天）不出', () => {
    expect(reviewedToday({ basis: 'created', daysSince: 0 })).toBe(false);
    expect(reviewedToday({ basis: 'review', daysSince: 0 })).toBe(true);
    expect(reviewedToday({ basis: 'review', daysSince: 1 })).toBe(false);
    expect(wildEligible(term('a'))).toBe(true);
    expect(wildEligible(term('a', { basis: 'review', daysSince: 0 }))).toBe(false);
  });

  it('② 范围内到期/逾期 = 欠账怪 ⇒ 不出野怪；范围外到期的仍可出（它不是欠账怪）', () => {
    expect(wildEligible(term('a', { status: 'due' }, 1))).toBe(false);
    expect(wildEligible(term('a', { status: 'overdue', daysSince: 5 }, 1))).toBe(false);
    expect(wildEligible(term('a', { status: 'overdue', daysSince: 5 }, 0))).toBe(true);
    expect(wildEligible(term('a', { status: 'mastered', basis: 'review', daysSince: 40 }, 1))).toBe(true);
  });
});

describe('wildMonsterIds — 每日一批', () => {
  const many = Array.from({ length: 20 }, (_, i) => term(`t${i}`));

  it('③ 同一天恒同；换一天换一批；数量守配额', () => {
    const a = wildMonsterIds(many, '2026-09-29');
    expect(a).toEqual(wildMonsterIds(many, '2026-09-29'));
    expect(a.size).toBe(wildMonsterCountFor(20));
    const days = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'];
    expect(days.some((d) => [...wildMonsterIds(many, d)].join() !== [...a].join())).toBe(true);
  });

  it('③ 新用户：唯一一条范围外的新词条必是野怪', () => {
    expect(wildMonsterIds([term('only')], '2026-09-29')).toEqual(new Set(['only']));
  });

  it('③ 打赢（今天复习过）就消失，且**不会有下一名顶上来**', () => {
    const day = '2026-09-29';
    const before = wildMonsterIds(many, day);
    const [slain] = [...before];
    if (!slain) throw new Error('应该有野怪');
    const after = wildMonsterIds(
      many.map((t) => (t.id === slain ? term(t.id, { basis: 'review', daysSince: 0 }) : t)),
      day,
    );
    expect(after.has(slain)).toBe(false);
    expect(after.size).toBe(before.size - 1);
    expect([...after].every((id) => before.has(id))).toBe(true);
  });

  it('③ 野怪位撞上欠账怪 ⇒ 那一位空着（两种怪不叠格，也不补位）', () => {
    const day = '2026-09-29';
    const before = wildMonsterIds(many, day);
    const [hit] = [...before];
    if (!hit) throw new Error('应该有野怪');
    const after = wildMonsterIds(many.map((t) => (t.id === hit ? term(t.id, { status: 'due', daysSince: 1 }, 1) : t)), day);
    expect(after.has(hit)).toBe(false);
    expect(after.size).toBe(before.size - 1);
  });
});

describe('monsterKindOf — 来路', () => {
  it('④ 欠账怪优先；野怪集合里的才是 wild；都不是 ⇒ null', () => {
    const wild = new Set(['w']);
    expect(monsterKindOf(term('w', { status: 'due' }, 1), wild)).toBe('due');
    expect(monsterKindOf(term('w'), wild)).toBe('wild');
    expect(monsterKindOf(term('x'), wild)).toBeNull();
  });
});
