/**
 * continent-upkeep.test — 地块维护（越靠边碎得越快）与话题怪（对话里提到的词条今天冒怪）的纯口径。
 *
 * 锁六件事：
 *  ① 耐久期随环数递减：中心 120 天、第 8 环起 7 天；环数 = `max(|row|,|col|)`。
 *  ② 磨损 = daysSince / 耐久期，夹到 1；`≥ 1` 即废墟；档位 0.5 / 0.8 / 1 三刀。
 *  ③ 长期记忆（mastered）恒 0（基石，永不碎）。
 *  ④ 话题怪只认**今天**（本地日历日）提到的：`last_used_at` 是 UTC 文本，跨日边界按本地日算。
 *  ⑤ 出场资格：欠账怪不重复出、今天复习过的不出、范围外照出；最多 6 只取最近提到的（先筛再截）。
 *  ⑥ `monsterKindOf`：欠账怪 > 话题怪 > 野怪。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTINENT_DURABILITY_DAYS,
  TOPIC_MONSTER_MAX,
  isRuin,
  localDayKey,
  monsterKindOf,
  tileDurabilityDays,
  tileRing,
  tileWear,
  topicEligible,
  topicMonsterIds,
  usedOnDay,
  wearStage,
  type ContinentTopicTerm,
} from './index.js';

function term(id: string, over: Partial<ContinentTopicTerm['review']> = {}, extra: Partial<ContinentTopicTerm> = {}): ContinentTopicTerm {
  return { id, review_in_scope: 0, review: { status: 'upcoming', basis: 'created', daysSince: 0, ...over }, ...extra };
}

describe('地块维护 — 耐久与磨损', () => {
  it('① 环数与耐久期：中心 120 天，逐环递减，第 8 环起封底 7 天', () => {
    expect(tileRing({ row: 0, col: 0 })).toBe(0);
    expect(tileRing({ row: -3, col: 2 })).toBe(3);
    expect(tileRing({ row: 1, col: -7 })).toBe(7);
    expect(tileDurabilityDays(0)).toBe(120);
    expect(tileDurabilityDays(4)).toBe(30);
    expect(tileDurabilityDays(8)).toBe(7);
    expect(tileDurabilityDays(40)).toBe(7);
    // 表本身单调不增：越靠外越不耐放，是这条口径的全部意思
    for (let i = 1; i < CONTINENT_DURABILITY_DAYS.length; i += 1) {
      expect(CONTINENT_DURABILITY_DAYS[i]!).toBeLessThanOrEqual(CONTINENT_DURABILITY_DAYS[i - 1]!);
    }
  });

  it('② 磨损 = 天数 / 耐久，夹到 1；同样 20 天：中心毫发无损，第 8 环已是废墟', () => {
    const t = term('a', { daysSince: 20 });
    expect(tileWear(t, { row: 0, col: 0 })).toBeCloseTo(20 / 120);
    expect(tileWear(t, { row: 0, col: 8 })).toBe(1);
    expect(isRuin(tileWear(t, { row: 0, col: 8 }))).toBe(true);
    expect(isRuin(tileWear(t, { row: 0, col: 0 }))).toBe(false);
    // 环数 4（耐久 30 天）：15 天起裂、24 天快碎、30 天碎
    expect(wearStage(tileWear(term('b', { daysSince: 14 }), { row: 4, col: 0 }))).toBe(0);
    expect(wearStage(tileWear(term('b', { daysSince: 15 }), { row: 4, col: 0 }))).toBe(1);
    expect(wearStage(tileWear(term('b', { daysSince: 24 }), { row: 4, col: 0 }))).toBe(2);
    expect(wearStage(tileWear(term('b', { daysSince: 30 }), { row: 4, col: 0 }))).toBe(3);
    // 负天数（时钟倒拨）按 0
    expect(tileWear(term('c', { daysSince: -3 }), { row: 8, col: 8 })).toBe(0);
  });

  it('③ 长期记忆恒 0：哪怕在最外环放了一年', () => {
    expect(tileWear(term('m', { status: 'mastered', daysSince: 365 }), { row: 9, col: 9 })).toBe(0);
  });
});

describe('话题怪 — 今天对话里提到的词条', () => {
  const day = '2026-09-30';

  it('④ 只认今天：UTC 文本按本地日算；坏值 / 空值不算', () => {
    // 用运行环境自己的时区造"今天正午"的 UTC 文本，避免测试机时区不同时假红
    const noon = new Date(2026, 8, 30, 12, 0, 0);
    const utcText = noon.toISOString().slice(0, 19).replace('T', ' ');
    expect(localDayKey(noon)).toBe(day);
    expect(usedOnDay(utcText, day)).toBe(true);
    expect(usedOnDay('2026-09-29 12:00:00', day)).toBe(false);
    expect(usedOnDay(null, day)).toBe(false);
    expect(usedOnDay('昨天', day)).toBe(false);
  });

  it('⑤ 资格：欠账怪不重复、今天复习过的不出、范围外照出；多于 6 只取最近提到的', () => {
    const noon = new Date(2026, 8, 30, 12, 0, 0);
    const at = (minuteOffset: number): string => new Date(noon.getTime() + minuteOffset * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const used = at(0);
    expect(topicEligible(term('x', {}, { last_used_at: used }), day)).toBe(true);
    expect(topicEligible(term('x', {}, { last_used_at: used, review_in_scope: 1 }), day)).toBe(true);
    expect(topicEligible(term('due', { status: 'overdue' }, { last_used_at: used, review_in_scope: 1 }), day)).toBe(false);
    expect(topicEligible(term('done', { basis: 'review', daysSince: 0 }, { last_used_at: used }), day)).toBe(false);
    expect(topicEligible(term('old', {}, { last_used_at: '2026-09-01 00:00:00' }), day)).toBe(false);

    const many = Array.from({ length: 9 }, (_, i) => term(`t${i}`, {}, { last_used_at: at(i) }));
    const ids = topicMonsterIds(many, day);
    expect(ids.size).toBe(TOPIC_MONSTER_MAX);
    // 最近提到的（分钟数最大的）留下
    expect([...ids].sort()).toEqual(['t3', 't4', 't5', 't6', 't7', 't8']);
    // 先筛再截：欠账怪不占名额
    const withDue = [term('due', { status: 'due' }, { last_used_at: at(99), review_in_scope: 1 }), ...many];
    expect(topicMonsterIds(withDue, day).has('due')).toBe(false);
    expect(topicMonsterIds(withDue, day).size).toBe(TOPIC_MONSTER_MAX);
  });

  it('⑥ monsterKindOf：欠账怪 > 话题怪 > 野怪', () => {
    const due = term('a', { status: 'overdue' }, { review_in_scope: 1 });
    expect(monsterKindOf(due, new Set(['a']), new Set(['a']))).toBe('due');
    const plain = term('b');
    expect(monsterKindOf(plain, new Set(['b']), new Set(['b']))).toBe('topic');
    expect(monsterKindOf(plain, new Set(['b']))).toBe('wild');
    expect(monsterKindOf(plain, new Set(), new Set())).toBeNull();
  });
});
