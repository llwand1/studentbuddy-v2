/**
 * chat/date-context 单测（**零依赖、零 IO、零真实时间**）。
 *
 * 全部用例的时间都**显式注入**：日期代码唯一会错的地方就是边界（凌晨、跨月、跨年、闰日），
 * 而这些边界一天只出现一次、还依赖跑测试的机器时区——不注入就测不到，只能靠"上线后某天
 * 早上用户发现日期不对"来发现。
 *
 * ★ 本文件里最值钱的一条是「本地时区口径」：它锁的是**实现方式**（走 `getFullYear` 等
 *   本地取值，而不是 `toISOString().slice(0, 10)` 那类 UTC 口径）。用 UTC 写法在 UTC 时区
 *   的 CI 上**照样全绿**，只有东八区凌晨才会露馅——所以必须用「当地凌晨」这个输入来逼它。
 */
import { describe, it, expect, vi } from 'vitest';
import { buildDateBlock } from './date-context.js';

/** 本地时区构造（`new Date(y, m, d)` 的月是 0 基）——刻意不用 ISO 串，那会按 UTC 解释。 */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

describe('buildDateBlock', () => {
  it('逐字给出年月日与星期（三句话各自成行）', () => {
    expect(buildDateBlock(at(2026, 9, 17))).toBe(
      [
        '【当前日期】今天是 2026年9月17日（星期四）。',
        '涉及「今天／今年／最近」这类时间判断时以该日期为准；用户说「明天／下周／还有几天」时按它推算。',
        '你的训练数据有截止日期、早于今天——近期事件若不确定就直说不确定，不要编日期。',
      ].join('\n'),
    );
  });

  it('本地时区口径：当地凌晨仍算「今天」，不因 UTC 偏移退回昨天', () => {
    // UTC+8 的 09-17 00:30 == UTC 的 09-16 16:30：按 UTC 取日期会得到 16 日。
    // 这正是用户一大早问「今天几号」的时刻——错了还不显眼，故单独立锁。
    expect(buildDateBlock(at(2026, 9, 17, 0, 30))).toContain('2026年9月17日');
    // 一天最后一分钟同理：不能被推到次日
    expect(buildDateBlock(at(2026, 9, 17, 23, 59))).toContain('2026年9月17日');
  });

  it('一天之内恒定（prompt 前缀缓存的不变量：同日不同时刻必须逐字相同）', () => {
    expect(buildDateBlock(at(2026, 9, 17, 0, 0))).toBe(buildDateBlock(at(2026, 9, 17, 23, 59)));
  });

  it('跨天必须跟着变（锁「实时取值」，而非「模块加载时算一次」）', () => {
    // ★ 与上一条是一对，缺一不可：只锁「一天内恒定」的话，把 `new Date()` 换成模块顶层的
    //   `const DATE = buildDateBlock()` 会让**所有测试照样全绿**，而功能从第二天起就废了
    //   —— 永远报第一次启动那天的日期，且不报错。这类「静默陈旧」正是最难发现的一类失效。
    vi.useFakeTimers({ toFake: ['Date'] }); // 只假 Date，不动 setTimeout（不干扰异步流程）
    try {
      vi.setSystemTime(new Date(2026, 8, 17, 23, 59));
      const day1 = buildDateBlock();
      vi.setSystemTime(new Date(2026, 8, 18, 0, 1));
      const day2 = buildDateBlock();

      expect(day1).toContain('2026年9月17日');
      expect(day2).toContain('2026年9月18日');
      expect(day2).not.toBe(day1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('段里不含时分秒（带时间戳会让 system 前缀每轮都变、缓存永不命中）', () => {
    expect(buildDateBlock(at(2026, 9, 17, 14, 30))).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('星期七档映射（`getDay()` 是 0=周日，不是 1=周一）', () => {
    const names = ['日', '一', '二', '三', '四', '五', '六'] as const;
    for (let i = 0; i < 7; i++) {
      // 2026-09-13 是周日，往后一周逐日校验七档全对上
      expect(buildDateBlock(at(2026, 9, 13 + i))).toContain(`（星期${names[i] ?? ''}）`);
    }
  });

  it('月份是 1 基（`getMonth()` 忘了 +1 会整月错位）', () => {
    expect(buildDateBlock(at(2026, 1, 5))).toContain('2026年1月5日');
    expect(buildDateBlock(at(2026, 12, 31))).toContain('2026年12月31日');
  });

  it('跨月/跨年边界不漂', () => {
    expect(buildDateBlock(at(2026, 12, 31))).toContain('2026年12月31日');
    expect(buildDateBlock(at(2027, 1, 1))).toContain('2027年1月1日');
  });

  it('闰日不漂（2028-02-29 存在）', () => {
    expect(buildDateBlock(at(2028, 2, 29))).toContain('2028年2月29日');
  });

  it('不传时间时取当下（生产调用路径，默认参数不得缺失）', () => {
    expect(buildDateBlock()).toContain(String(new Date().getFullYear()));
  });
});
