/**
 * coach-cards — 卡片流合并/排序/时间文案的纯函数测试。
 *
 * 这里最要紧的是 `mergeCards`：同一条流水会经过「乐观插入 → 服务端落库 → 断线重放」
 * 三个阶段出现多次，合并错了就是**屏幕上出现几张一模一样的复习卡**（真机最容易复现的丑 bug）。
 */
import { describe, it, expect } from 'vitest';
import type { CoachCard } from '@sb/shared';
import {
  STREAMING_CARD_ID,
  TREND_BUBBLE_TEXT,
  capsuleTone,
  dropStreaming,
  formatCardTime,
  mergeCards,
  retentionLevel,
  reviewCardResult,
  sortCards,
  trendBubble,
  withStreaming,
} from './coach-cards';

/** Date → 库里那种 SQLite 文本形状（UTC、无时区标记） */
const sqlite = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

const aiCard = (id: string, at: string, text = '该背了'): CoachCard => ({ id, kind: 'ai', text, at });
const nudgeCard = (id: string, at: string): CoachCard => ({ id, kind: 'nudge', text: '欠 3 条', at });
const reviewCard = (id: string, at: string, remembered = true): CoachCard => ({
  id,
  kind: 'review',
  at,
  termId: 't1',
  term: '闭包',
  remembered,
  stage: 1,
  intervalDays: 2,
});
/** 趋势卡（记忆联动 P4 起的第 5 种 kind）：图与榜的数据都由服务端 SQL 出 */
const trendCard = (id: string, at: string): CoachCard => ({
  id,
  kind: 'trend',
  at,
  windowDays: 7,
  labels: ['09-12', '09-13', '09-14'],
  values: [1, 3, 2],
  topDomains: [{ domain: 'math', count: 4 }],
  topTerms: [{ term: '二分查找', count: 3 }],
  summary: '近 7 天共提及 6 次，最活跃的是「math」（4 次）。',
  summarySource: 'ai',
});

describe('mergeCards — 合并而不是追加', () => {
  it('同 id 的卡被新版本覆盖（乐观插入随后落库的同一张，不能变成两张）', () => {
    const a = aiCard('x', '2026-09-18 04:00:00', '旧');
    const b = aiCard('x', '2026-09-18 04:00:00', '新');
    expect(mergeCards([a], [b])).toHaveLength(1);
    expect((mergeCards([a], [b])[0] as { text: string }).text).toBe('新');
  });

  it('新 id 追加，且结果按时间正序（服务端已正序，合并后仍须正序）', () => {
    const early = aiCard('a', '2026-09-18 01:00:00');
    const late = nudgeCard('b', '2026-09-18 03:00:00');
    const mid = reviewCard('c', '2026-09-18 02:00:00');
    expect(mergeCards([late], [early, mid]).map((c) => c.id)).toEqual(['a', 'c', 'b']);
  });

  it('空入参不炸（首屏还没拉到流水就要渲染）', () => {
    expect(mergeCards([], [])).toEqual([]);
    expect(mergeCards([aiCard('a', '2026-09-18 01:00:00')], [])).toHaveLength(1);
  });
});

describe('sortCards — 时间正序', () => {
  it('按库里的 UTC 文本排序（不是按字符串长度或插入顺序）', () => {
    const cards = [aiCard('b', '2026-09-18 03:00:00'), aiCard('a', '2026-09-18 01:00:00')];
    expect(sortCards(cards).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('时间解析不出来的卡不参与排序崩溃（归零处理）', () => {
    expect(() => sortCards([aiCard('a', '坏值'), aiCard('b', '2026-09-18 01:00:00')])).not.toThrow();
  });
});

describe('withStreaming / dropStreaming — 临时卡', () => {
  it('挂一张固定 id 的临时卡在末尾，且不重复挂', () => {
    const cards = [aiCard('a', '2026-09-18 01:00:00')];
    const once = withStreaming(cards, '先背', '2026-09-18 05:00:00');
    const twice = withStreaming(once, '先背「闭包」', '2026-09-18 05:00:00');
    expect(twice.filter((c) => c.id === STREAMING_CARD_ID)).toHaveLength(1);
    expect(twice.map((c) => c.id)).toEqual(['a', STREAMING_CARD_ID]);
    expect((twice.at(-1) as { text: string }).text).toBe('先背「闭包」');
  });

  it('文本为空 ⇒ 不插空卡（否则屏幕上多一个空框）', () => {
    expect(withStreaming([aiCard('a', '2026-09-18 01:00:00')], '', '2026-09-18 05:00:00')).toHaveLength(1);
  });

  it('dropStreaming 摘掉临时卡（done 后由落库的真卡接管）', () => {
    const cards = withStreaming([aiCard('a', '2026-09-18 01:00:00')], '流到一半', '2026-09-18 05:00:00');
    expect(dropStreaming(cards).map((c) => c.id)).toEqual(['a']);
  });
});

describe('formatCardTime — 相对/绝对时间', () => {
  const now = new Date(2026, 8, 18, 12, 0, 0); // 本地时间 2026-09-18 12:00

  it('一分钟内 → 刚刚', () => {
    expect(formatCardTime(sqlite(new Date(now.getTime() - 30_000)), now)).toBe('刚刚');
  });

  it('一小时内 → N 分钟前', () => {
    expect(formatCardTime(sqlite(new Date(now.getTime() - 5 * 60_000)), now)).toBe('5 分钟前');
  });

  it('同一本地日的更早时刻 → 今天 HH:MM（按本地小时显示，不是 UTC）', () => {
    const morning = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 30);
    expect(formatCardTime(sqlite(morning), now)).toBe('今天 08:30');
  });

  it('昨天 → 昨天 HH:MM；更早 → MM-DD HH:MM', () => {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 21, 5);
    expect(formatCardTime(sqlite(yesterday), now)).toBe('昨天 21:05');
    const older = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 9, 0);
    expect(formatCardTime(sqlite(older), now)).toMatch(/^\d{2}-\d{2} 09:00$/);
  });

  it('坏值 → 空串（不显示 NaN，也不抛）', () => {
    expect(formatCardTime('不是时间', now)).toBe('');
  });
});

describe('展示派生值', () => {
  it('reviewCardResult：记得给"第 N/7 档 · 下次 X 天后"，忘了给归零，毕业给长期记忆', () => {
    expect(reviewCardResult({ ...(reviewCard('a', '2026-09-18 01:00:00') as Extract<CoachCard, { kind: 'review' }>), stage: 1, intervalDays: 2 })).toBe(
      '第 2/7 档 · 下次 2 天后',
    );
    expect(reviewCardResult(reviewCard('a', '2026-09-18 01:00:00', false) as Extract<CoachCard, { kind: 'review' }>)).toBe(
      '已归零，明天重来',
    );
    expect(
      reviewCardResult({ ...(reviewCard('a', '2026-09-18 01:00:00') as Extract<CoachCard, { kind: 'review' }>), stage: 7 }),
    ).toBe('已入长期记忆，不再催了');
  });

  it('retentionLevel 分 5 档且钳制越界值', () => {
    expect([0.95, 0.7, 0.5, 0.3, 0.1].map(retentionLevel)).toEqual([4, 3, 2, 1, 0]);
    expect(retentionLevel(-1)).toBe(0);
    expect(retentionLevel(2)).toBe(4);
    expect(retentionLevel(Number.NaN)).toBe(0);
  });

  it('capsuleTone：逾期=alert、有欠账=warn、清零=ok', () => {
    expect(capsuleTone({ due: 3, overdue: 1 })).toBe('alert');
    expect(capsuleTone({ due: 3, overdue: 0 })).toBe('warn');
    expect(capsuleTone({ due: 0, overdue: 0 })).toBe('ok');
  });
});

/**
 * 趋势卡气泡（P5，契约 MEMORY-TREND-SPEC §4.4）。
 * 准入条件只有两条：**是趋势卡** + **抽屉关着**。这两条各挡住一个具体的错：
 * 前者挡住"胶囊同时报数又报消息、用户分不清哪个更急"，后者挡住"卡片就在眼前还弹一个"。 */
describe('trendBubble — 趋势卡气泡的准入条件', () => {
  it('趋势卡 + 抽屉关着 ⇒ 冒泡：文案是契约原话，落点是那张卡自己', () => {
    expect(trendBubble(trendCard('t9', '2026-09-18 05:00:00'), false)).toEqual({
      cardId: 't9',
      text: TREND_BUBBLE_TEXT,
    });
  });

  it('抽屉开着 ⇒ 不冒泡（卡片会自己出现在他眼前，再弹一个只是重复告知）', () => {
    expect(trendBubble(trendCard('t9', '2026-09-18 05:00:00'), true)).toBeNull();
  });

  it('非趋势卡 ⇒ 不冒泡（提醒卡的红点语义已在胶囊上，叠加会让用户分不清哪个更急）', () => {
    expect(trendBubble(nudgeCard('n1', '2026-09-18 05:00:00'), false)).toBeNull();
    expect(trendBubble(aiCard('a1', '2026-09-18 05:00:00'), false)).toBeNull();
    expect(trendBubble(reviewCard('r1', '2026-09-18 05:00:00'), false)).toBeNull();
  });

  it('回退摘要照样冒泡：气泡宣告的是"图出来了"，与那句摘要由谁写无关（§4.3）', () => {
    const fb = { ...trendCard('t9', '2026-09-18 05:00:00'), summarySource: 'fallback' as const };
    expect(trendBubble(fb, false)?.cardId).toBe('t9');
  });
});
