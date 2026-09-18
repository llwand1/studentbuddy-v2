/**
 * shared/coach — 督促契约的纯函数（判定唯一性 + 文案同源 + 频道隔离）。
 *
 * 这层测试的价值在于：**「该不该催」只有一份实现**，前端胶囊的红点、抽屉里的提醒卡、
 * 服务端 /nudge 的落库判断，三处都调这里的 `shouldNudge`。它错了，三处一起错；
 * 它对了，三处不可能打架。
 */
import { describe, it, expect } from 'vitest';
import {
  COACH_QUICK_ACTIONS,
  NUDGE_MIN_BACKLOG,
  NUDGE_MIN_OVERDUE_DAYS,
  capsuleLine,
  coachChannel,
  nudgeLine,
  parseCoachTime,
  shouldNudge,
} from './coach.js';

const NOW = new Date('2026-09-18T04:00:00Z');
/** 相对 NOW 前推 N 小时的 SQLite 文本（库里存的就是这种形状：UTC、无时区标记） */
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

describe('coachChannel — 频道隔离', () => {
  it('前缀恒为 coach:，未登录（单人本地模式）落到 coach:local', () => {
    expect(coachChannel(null)).toBe('coach:local');
    expect(coachChannel(undefined)).toBe('coach:local');
    expect(coachChannel('u1')).toBe('coach:u1');
    // 与聊天 sessionId、PK 的 `pk:` 三者不可能撞（v1 串台教训）
    expect(coachChannel('u1').startsWith('coach:')).toBe(true);
  });
});

describe('shouldNudge — 唯一判据', () => {
  const base = { due: 0, overdue: 0, maxOverdueDays: 0, lastNudgeAt: null, now: NOW };

  it('一条欠账都没有 ⇒ empty，且**不产生文案**（前端不该渲染任何东西）', () => {
    const r = shouldNudge(base);
    expect(r.should).toBe(false);
    expect(r.reason).toBe('empty');
    expect(r.line).toBe('');
  });

  it('★ 有逾期且最久 ≥3 天 ⇒ overdue', () => {
    const r = shouldNudge({ ...base, due: 4, overdue: 2, maxOverdueDays: NUDGE_MIN_OVERDUE_DAYS });
    expect(r).toMatchObject({ should: true, reason: 'overdue' });
    expect(r.line).toContain('2 个词条');
    expect(r.line).toContain('3 天');
  });

  it('逾期只 1~2 天且没堆量 ⇒ 不打扰（正常节奏，不值得打断人）', () => {
    expect(shouldNudge({ ...base, due: 2, overdue: 2, maxOverdueDays: 2 }).should).toBe(false);
  });

  it(`单条都没逾期但堆到 ${NUDGE_MIN_BACKLOG} 条 ⇒ backlog（量变引起质变）`, () => {
    const r = shouldNudge({ ...base, due: NUDGE_MIN_BACKLOG, overdue: 0, maxOverdueDays: 0 });
    expect(r).toMatchObject({ should: true, reason: 'backlog' });
    expect(r.line).toContain('今天');
  });

  it('★ 冷却优先于一切：2 小时内念过就不再念（哪怕欠账很凶）', () => {
    const r = shouldNudge({ ...base, due: 30, overdue: 10, maxOverdueDays: 20, lastNudgeAt: hoursAgo(1) });
    expect(r).toMatchObject({ should: false, reason: 'cooldown', line: '' });
  });

  it('冷却已过（>2h）⇒ 恢复可催', () => {
    const r = shouldNudge({ ...base, due: 30, overdue: 10, maxOverdueDays: 20, lastNudgeAt: hoursAgo(3) });
    expect(r.should).toBe(true);
  });
});

describe('文案同源（前端不各写一套）', () => {
  it('逾期时说"欠着没背 + 最久几天"，不逾期时说"今天到期"', () => {
    expect(nudgeLine({ due: 5, overdue: 3, maxOverdueDays: 7 })).toContain('最久的已经 7 天');
    expect(nudgeLine({ due: 5, overdue: 0, maxOverdueDays: 0 })).toContain('今天 5 个词条到期');
  });

  it('胶囊一行：有欠账给"欠 N 条 · 连续 M 天"，清零给"今日无欠账/已清 N 条"', () => {
    expect(capsuleLine({ due: 12, streak: 3, todayDone: 4 })).toBe('欠 12 条 · 连续 3 天');
    expect(capsuleLine({ due: 0, streak: 3, todayDone: 0 })).toBe('今日无欠账');
    expect(capsuleLine({ due: 0, streak: 3, todayDone: 6 })).toBe('今日已清 6 条');
  });

  it('快捷指令是固定三条且都带可发的提示词（点了就能发，不是装饰）', () => {
    expect(COACH_QUICK_ACTIONS).toHaveLength(3);
    for (const a of COACH_QUICK_ACTIONS) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.prompt.length).toBeGreaterThan(10);
    }
  });
});

describe('parseCoachTime — 库里的 UTC 文本', () => {
  it('解析 datetime(now) 形状并**当作 UTC**（按本地时间读会差 8 小时）', () => {
    const d = parseCoachTime('2026-09-18 04:00:00');
    expect(d?.toISOString()).toBe('2026-09-18T04:00:00.000Z');
  });

  it('坏值返回 null（卡片时间显示空，而不是把整条流画崩）', () => {
    expect(parseCoachTime(null)).toBeNull();
    expect(parseCoachTime('')).toBeNull();
    expect(parseCoachTime('不是时间')).toBeNull();
  });
});
