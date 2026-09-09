import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatMsgTime,
  formatRoundMeta,
  formatTokens,
  shouldAutoScroll,
  toolLabel,
} from './chat-meta';

describe('toolLabel（工具中文名）', () => {
  it('已登记的工具给中文名', () => {
    expect(toolLabel('search_web')).toBe('联网搜索');
    expect(toolLabel('tidy_terms')).toBe('整理词条');
    expect(toolLabel('manage_terms')).toBe('管理词条');
  });

  it('未登记的新工具回退原 key——宁可露英文也不把「有工具在跑」藏掉（ADR-5 不静默）', () => {
    expect(toolLabel('generate_quiz')).toBe('generate_quiz');
    expect(toolLabel('mcp__my-lab__foo')).toBe('mcp__my-lab__foo');
  });

  it('空串不炸：回退空串而不是 undefined（进 JSX 会渲染成 "undefined" 字样）', () => {
    expect(toolLabel('')).toBe('');
  });
});

describe('formatTokens（token 数人话）', () => {
  it('三档：原样 / 一位小数 k / 整数 k', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(842)).toBe('842');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(12_400)).toBe('12k');
  });

  it('脏数据不显示 NaN：非有限值与负数一律归零，不把 "NaN" 打到界面上', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
    expect(formatTokens(-5)).toBe('0');
  });
});

describe('formatDuration（耗时人话）', () => {
  it('毫秒 / 秒 / 分秒三档', () => {
    expect(formatDuration(820)).toBe('820ms');
    expect(formatDuration(8300)).toBe('8.3s');
    expect(formatDuration(125_000)).toBe('2 分 5 秒');
  });

  it('整分钟不带 "0 秒"，负数与非有限值返回空串（调用方据此整段不渲染）', () => {
    expect(formatDuration(120_000)).toBe('2 分');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });
});

describe('formatRoundMeta（轮次元信息）', () => {
  it('usage 与耗时齐备：`1.2k tokens · 8.3s`', () => {
    expect(formatRoundMeta({ promptTokens: 900, completionTokens: 300 }, 8300)).toBe('1.2k tokens · 8.3s');
  });

  it('usage 缺失时只显示耗时——不编造 token 数', () => {
    expect(formatRoundMeta(null, 8300)).toBe('8.3s');
    expect(formatRoundMeta({ promptTokens: 0, completionTokens: 0 }, 8300)).toBe('8.3s');
  });

  it('两者都无 → 空串，调用方据此不渲染那一行（不显示"0 tokens"这种废话）', () => {
    expect(formatRoundMeta(null)).toBe('');
    expect(formatRoundMeta(null, 0)).toBe('');
  });
});

describe('formatMsgTime（消息时间）', () => {
  const at = (s: string): Date => new Date(s);

  it('今天的消息只显示时分', () => {
    expect(formatMsgTime('2026-09-09 07:52:03', at('2026-09-09T12:00:00+08:00'))).toBe('15:52');
  });

  it('跨天补上月日', () => {
    expect(formatMsgTime('2026-09-08 07:52:03', at('2026-09-09T12:00:00+08:00'))).toBe('9月8日 15:52');
  });

  it('★ UTC 修正：SQLite 的 datetime(now) 不带时区，按 Z 解析才是真时刻', () => {
    const raw = '2026-09-09 07:52:03';
    const asUtc = new Date('2026-09-09T07:52:03Z');
    const asLocal = new Date('2026-09-09 07:52:03'); // 错的那种解析
    const hhmm = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(formatMsgTime(raw, at('2026-09-09T12:00:00+08:00'))).toBe(hhmm(asUtc));
    // 这条只在非 UTC 时区下才有鉴别力（老板机器是 +8，正是要防的那种环境）
    if (hhmm(asUtc) !== hhmm(asLocal)) {
      expect(formatMsgTime(raw, at('2026-09-09T12:00:00+08:00'))).not.toBe(hhmm(asLocal));
    }
  });

  it('已带时区的 ISO 串按原样解析，不二次加工', () => {
    expect(formatMsgTime('2026-09-09T07:52:03Z', at('2026-09-09T12:00:00+08:00'))).toBe('15:52');
  });

  it('空值与非法串返回空串——调用方据此不渲染那一格，不显示 Invalid Date', () => {
    expect(formatMsgTime(undefined)).toBe('');
    expect(formatMsgTime('')).toBe('');
    expect(formatMsgTime('不是时间')).toBe('');
  });
});

describe('shouldAutoScroll（贴底判定）', () => {
  it('距底 ≤80px 视为在看最新，超出即不跟随——用户上翻后不被强拉回底部', () => {
    expect(shouldAutoScroll(0)).toBe(true);
    expect(shouldAutoScroll(80)).toBe(true);
    expect(shouldAutoScroll(81)).toBe(false);
    expect(shouldAutoScroll(2400)).toBe(false);
  });

  it('阈值为何不是 0：smooth 滚动未落定时距离会在几十像素内抖动，用 0 会假阴性', () => {
    expect(shouldAutoScroll(42)).toBe(true);
    expect(shouldAutoScroll(42, 0)).toBe(false);
  });

  it('距离算不出来（NaN）时按跟随处理：跟随是默认行为，不因一次量不到就停止滚动', () => {
    expect(shouldAutoScroll(Number.NaN)).toBe(true);
  });
});
