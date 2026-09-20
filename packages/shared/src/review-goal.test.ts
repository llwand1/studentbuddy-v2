/**
 * shared/review-goal.test — 自定义复习目标的归一闸门（EBBINGHAUS-SPEC §10.2/§10.6，2026-09-21 新建）。
 *
 * ★ 本文件锁的是**唯一一份**目标归一实现，它同时决定两件事——服务端按 `count` 截断队列、
 *   前端按 `count` 画达标进度。一条判错就是「进度条说还差 3 条、队列里已经没了」这种当场露馅的
 *   不一致，故逐条钉死。
 * ★ 最要紧的一条是「**`count = 0` 是合法值**」：它承载本节唯一的向后兼容承诺
 *   （不设目标 = 什么都没变）。若有人把 0 当非法、回落到某个非 0 默认值，
 *   所有老用户升级后队列会从 3 条变 30 条，而**没有任何测试会因此变红**——只有这条能挡住。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_GOAL,
  REVIEW_GOAL_DOMAINS_MAX,
  REVIEW_GOAL_MAX,
  normalizeReviewGoal,
  reviewGoalActive,
  reviewGoalProgress,
} from './review-goal.js';

describe('normalizeReviewGoal — 形状归一', () => {
  it('空值/非对象一律回落默认（关闭），且从不抛异常', () => {
    // 归一挂在读口上（每次队列请求都跑一次），抛异常等于整个复习面板打不开
    for (const bad of [null, undefined, 0, 30, '30', true, [], 'x']) {
      expect(normalizeReviewGoal(bad)).toEqual(DEFAULT_REVIEW_GOAL);
    }
  });

  it('★ count = 0 是合法值（＝关闭自定义目标），不被当成非法而替换', () => {
    // 这条守的是向后兼容：默认关闭 ⇒ 行为与 v1.1 逐字相同
    expect(normalizeReviewGoal({ count: 0 })).toEqual({ count: 0, domains: [] });
    expect(normalizeReviewGoal({ count: 0, domains: ['cs'] })).toEqual({ count: 0, domains: ['cs'] });
  });

  it('count 负数钳到 0、超上限钳到 REVIEW_GOAL_MAX', () => {
    expect(normalizeReviewGoal({ count: -5 }).count).toBe(0);
    expect(normalizeReviewGoal({ count: REVIEW_GOAL_MAX + 1 }).count).toBe(REVIEW_GOAL_MAX);
    expect(normalizeReviewGoal({ count: REVIEW_GOAL_MAX }).count).toBe(REVIEW_GOAL_MAX);
  });

  it('count 小数取整（不是四舍五入到最近整数档）', () => {
    expect(normalizeReviewGoal({ count: 30.9 }).count).toBe(30);
    expect(normalizeReviewGoal({ count: 0.9 }).count).toBe(0);
  });

  it('count 为 NaN / Infinity / 字符串一律 0——不做宽松转换', () => {
    // ★ 不尝试 Number('30')：那是**猜测**用户意图，而猜错的方向恰好是
    //   「把关闭读成开启」，用户会莫名其妙被塞 30 条复习任务
    expect(normalizeReviewGoal({ count: Number.NaN }).count).toBe(0);
    expect(normalizeReviewGoal({ count: Number.POSITIVE_INFINITY }).count).toBe(0);
    expect(normalizeReviewGoal({ count: '30' }).count).toBe(0);
  });

  it('domains 非数组一律空数组（不抛）', () => {
    for (const bad of [undefined, null, 'cs', 3, {}]) {
      expect(normalizeReviewGoal({ count: 5, domains: bad }).domains).toEqual([]);
    }
  });

  it('domains 过滤非字符串、trim、丢空串', () => {
    expect(normalizeReviewGoal({ domains: ['cs', 3, null, '  math  ', '', '   '] }).domains).toEqual(['cs', 'math']);
  });

  it('domains 去重且保持首次出现顺序（顺序有语义：它是段内排序的权重序）', () => {
    expect(normalizeReviewGoal({ domains: ['math', 'cs', 'math', 'cs'] }).domains).toEqual(['math', 'cs']);
  });

  it('domains 超上限截断到 REVIEW_GOAL_DOMAINS_MAX', () => {
    const many = Array.from({ length: REVIEW_GOAL_DOMAINS_MAX + 10 }, (_, i) => `d${i}`);
    const out = normalizeReviewGoal({ domains: many }).domains;
    expect(out).toHaveLength(REVIEW_GOAL_DOMAINS_MAX);
    expect(out[0]).toBe('d0');
  });

  it('两个字段互不牵连（一边坏不拖累另一边）', () => {
    expect(normalizeReviewGoal({ count: 'bad', domains: ['cs'] })).toEqual({ count: 0, domains: ['cs'] });
    expect(normalizeReviewGoal({ count: 12, domains: 'bad' })).toEqual({ count: 12, domains: [] });
  });

  it('★ 返回的 domains 是新数组，改它不会污染 DEFAULT_REVIEW_GOAL', () => {
    // 浅拷贝（{...DEFAULT}）会让返回值与常量共享同一个数组：调用方一次 push 就把全局默认值改了，
    // 下一个请求拿到的"默认值"里凭空多一个领域——两次请求之间没有任何写操作
    const a = normalizeReviewGoal(null);
    a.domains.push('污染');
    const b = normalizeReviewGoal(null);
    expect(b.domains).toEqual([]);
    expect(DEFAULT_REVIEW_GOAL.domains).toEqual([]);
    expect(a.domains).not.toBe(b.domains);
  });
});

describe('reviewGoalActive — 生效判据', () => {
  it('count > 0 才生效；count = 0（默认/关闭）不生效', () => {
    expect(reviewGoalActive({ count: 0, domains: [] })).toBe(false);
    expect(reviewGoalActive({ count: 1, domains: [] })).toBe(true);
    expect(reviewGoalActive({ count: REVIEW_GOAL_MAX, domains: ['cs'] })).toBe(true);
  });
});

describe('reviewGoalProgress — 达标进度', () => {
  it('未达标：remaining = 目标 - 已完成', () => {
    expect(reviewGoalProgress({ count: 30, domains: [] }, 12)).toEqual({ done: 12, target: 30, remaining: 18, reached: false });
  });

  it('恰好达标（边界不误伤）：done === count 即 reached', () => {
    expect(reviewGoalProgress({ count: 30, domains: [] }, 30)).toEqual({ done: 30, target: 30, remaining: 0, reached: true });
  });

  it('★ 超额完成时 remaining 钳在 0（不显示「-3 条」这种负数噪声）', () => {
    const p = reviewGoalProgress({ count: 30, domains: [] }, 33);
    expect(p.remaining).toBe(0);
    expect(p.reached).toBe(true);
  });

  it('★ 关闭目标时 reached 恒 false——没设目标就不存在「达标」这回事', () => {
    // 否则 count=0 且 doneCards=0 会满足 done >= count，UI 一进来就显示"今日已达标"
    expect(reviewGoalProgress({ count: 0, domains: [] }, 0).reached).toBe(false);
    expect(reviewGoalProgress({ count: 0, domains: [] }, 5).reached).toBe(false);
  });

  it('doneCards 为负数/NaN 时当 0（不产出负数进度）', () => {
    expect(reviewGoalProgress({ count: 10, domains: [] }, -3).done).toBe(0);
    expect(reviewGoalProgress({ count: 10, domains: [] }, Number.NaN).done).toBe(0);
  });
});
