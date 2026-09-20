/**
 * learning/review-queue.test — 三段补位队列的构建（EBBINGHAUS-SPEC §10.3/§10.4，2026-09-21 新建）。
 *
 * ★ 本文件锁的是**队列里放什么、按什么顺序放**——它是本批最容易被"顺手改一下"改坏的地方，
 *   而且改坏之后**不会有任何运行时错误**：队列只是顺序不对或漏了几条，页面照常渲染。
 *   故逐条钉死。
 * ★ 最要紧的两条（写错就等于把 §5 的既有口径稀释掉）：
 *   ① **① 段（真账）的排序不受优先领域影响**——否则勾了 `cs` 之后，`math` 里逾期 20 天的词条
 *      会被 `cs` 里今天刚到期的挤下去，用户的老账永远还不完；
 *   ② **毕业档不进队列**——塞回去等于让"毕业"失效（§5）。
 * ★ 全程纯函数、不碰 DB（判定逻辑留在可单测的纯函数里，是本仓既有约定）。
 */
import { describe, expect, it } from 'vitest';
import type { ReviewStatus } from '@sb/shared';
import type { ReviewTerm } from './term-review.js';
import { buildReviewQueue, clampQueueLimit } from './review-queue.js';

/** 造一条队列候选词条；只填本文件用得到的字段（其余给中性值，避免用例里出现无关噪声） */
function makeTerm(
  id: string,
  p: { status: ReviewStatus; domain?: string; importance?: number; overdueDays?: number; dueInDays?: number },
): ReviewTerm {
  return {
    id,
    term: id,
    definition: `${id} 的释义`,
    domain: p.domain ?? 'general',
    importance: p.importance ?? 0,
    usage_count: 0,
    created_at: '2026-09-01 00:00:00',
    updated_at: '2026-09-01 00:00:00',
    review_stage: 0,
    last_reviewed_at: null,
    review: {
      stage: p.status === 'mastered' ? 7 : 0,
      intervalDays: 1,
      daysSince: 0,
      dueInDays: p.dueInDays ?? 0,
      overdueDays: p.overdueDays ?? 0,
      retention: 0.7,
      status: p.status,
      mastered: p.status === 'mastered',
      basis: 'created',
      nextDueDay: '2026-09-22',
    },
  };
}

const NO_PREF = { count: 99, domains: [] as string[] };

describe('clampQueueLimit — 未设目标时的条数归一', () => {
  it('缺省/非法回落到默认 20，且钳在 1..100', () => {
    expect(clampQueueLimit(undefined)).toBe(20);
    expect(clampQueueLimit(Number.NaN)).toBe(20);
    expect(clampQueueLimit(0)).toBe(20);
    // ★ 负数**不**回落默认，而是钳到下限 1（`||` 只兜 0/NaN/undefined）——这是 v1.1 的既有行为，
    //   本批原样搬过来，不顺手改语义（改了会让"传错一个负数"从 1 条变 20 条，是更大的意外）
    expect(clampQueueLimit(-5)).toBe(1);
    expect(clampQueueLimit(999)).toBe(100);
    expect(clampQueueLimit(7)).toBe(7);
  });
});

describe('buildReviewQueue — 三段顺序', () => {
  it('拼接顺序恒为 真账 → 提前背 → 重复巩固', () => {
    const items = [
      makeTerm('up', { status: 'upcoming', dueInDays: 3 }),
      makeTerm('over', { status: 'overdue', overdueDays: 2 }),
      makeTerm('fresh', { status: 'upcoming', dueInDays: 1 }),
    ];
    const today = new Map([['fresh', '2026-09-21 08:00:00']]);
    const out = buildReviewQueue(items, today, NO_PREF, 99);
    // fresh 今天打过卡 ⇒ 落到 ③ 段；over 是真账排最前；up 在 ② 段
    expect(out.map((t) => t.id)).toEqual(['over', 'up', 'fresh']);
    expect(out.map((t) => t.segment)).toEqual(['due', 'extra', 'repeat']);
  });

  it('① 段：按逾期天数降序，同欠账按重要度降序（§5「先还旧账」原样）', () => {
    const items = [
      makeTerm('a', { status: 'overdue', overdueDays: 1, importance: 9 }),
      makeTerm('b', { status: 'overdue', overdueDays: 7, importance: 1 }),
      makeTerm('c', { status: 'overdue', overdueDays: 7, importance: 5 }),
      makeTerm('d', { status: 'due' }),
    ];
    const out = buildReviewQueue(items, new Map(), NO_PREF, 99);
    // 逾期 7 天里重要的 c 在前；然后 a（逾期 1 天）；最后 d（今天到期，欠账 0）
    expect(out.map((t) => t.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('② 段：越接近到期越靠前，同距按重要度降序', () => {
    const items = [
      makeTerm('far', { status: 'upcoming', dueInDays: 6 }),
      makeTerm('near2', { status: 'upcoming', dueInDays: 1, importance: 2 }),
      makeTerm('near9', { status: 'upcoming', dueInDays: 1, importance: 9 }),
    ];
    const out = buildReviewQueue(items, new Map(), NO_PREF, 99);
    expect(out.map((t) => t.id)).toEqual(['near9', 'near2', 'far']);
  });

  it('③ 段：按今日最后一次打卡时间升序（先背过的先回来）', () => {
    const items = [
      makeTerm('late', { status: 'upcoming', dueInDays: 5 }),
      makeTerm('early', { status: 'upcoming', dueInDays: 5 }),
      makeTerm('mid', { status: 'upcoming', dueInDays: 5 }),
    ];
    const today = new Map([
      ['late', '2026-09-21 21:00:00'],
      ['early', '2026-09-21 08:00:00'],
      ['mid', '2026-09-21 13:00:00'],
    ]);
    const out = buildReviewQueue(items, today, NO_PREF, 99);
    expect(out.map((t) => t.id)).toEqual(['early', 'mid', 'late']);
  });
});

describe('buildReviewQueue — 优先领域（§10.4）', () => {
  it('★ ① 段（真账）**不受**优先领域影响——老账永远排在前面', () => {
    const items = [
      makeTerm('cs-today', { status: 'due', domain: 'cs' }),
      makeTerm('math-overdue', { status: 'overdue', overdueDays: 20, domain: 'math' }),
    ];
    const out = buildReviewQueue(items, new Map(), { count: 99, domains: ['cs'] }, 99);
    // 若有人把优先领域提到段间比较上，这条会红：逾期 20 天的 math 必须仍在 cs 之前
    expect(out.map((t) => t.id)).toEqual(['math-overdue', 'cs-today']);
  });

  it('② 段：优先领域靠前（段内排序，不是过滤）', () => {
    const items = [
      makeTerm('gen', { status: 'upcoming', dueInDays: 1, domain: 'general' }),
      makeTerm('cs', { status: 'upcoming', dueInDays: 9, domain: 'cs' }),
    ];
    const out = buildReviewQueue(items, new Map(), { count: 99, domains: ['cs'] }, 99);
    // cs 的 dueInDays 更大（更不接近到期），但它是优先领域 ⇒ 仍排前面
    expect(out.map((t) => t.id)).toEqual(['cs', 'gen']);
  });

  it('★ 优先领域是**排序**不是**过滤**：指定域不够时其他域照常补位', () => {
    const items = [
      makeTerm('cs', { status: 'upcoming', dueInDays: 1, domain: 'cs' }),
      makeTerm('math', { status: 'upcoming', dueInDays: 2, domain: 'math' }),
      makeTerm('eng', { status: 'upcoming', dueInDays: 3, domain: 'eng' }),
    ];
    const out = buildReviewQueue(items, new Map(), { count: 99, domains: ['cs'] }, 99);
    expect(out.map((t) => t.id)).toHaveLength(3);
  });

  it('③ 段：优先领域靠前，段内仍按打卡时间升序', () => {
    const items = [
      makeTerm('gen-early', { status: 'upcoming', dueInDays: 5, domain: 'general' }),
      makeTerm('cs-late', { status: 'upcoming', dueInDays: 5, domain: 'cs' }),
    ];
    const today = new Map([
      ['gen-early', '2026-09-21 08:00:00'],
      ['cs-late', '2026-09-21 20:00:00'],
    ]);
    const out = buildReviewQueue(items, today, { count: 99, domains: ['cs'] }, 99);
    expect(out.map((t) => t.id)).toEqual(['cs-late', 'gen-early']);
  });

  it('domains 为空 = 不设优先（不是"全部优先"，不改变原有排序）', () => {
    const items = [
      makeTerm('b', { status: 'upcoming', dueInDays: 2 }),
      makeTerm('a', { status: 'upcoming', dueInDays: 1 }),
    ];
    const out = buildReviewQueue(items, new Map(), { count: 99, domains: [] }, 99);
    expect(out.map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('buildReviewQueue — 截断 / 去重 / 毕业档', () => {
  it('截断到 count', () => {
    const items = Array.from({ length: 10 }, (_, i) => makeTerm(`t${i}`, { status: 'overdue', overdueDays: 10 - i }));
    expect(buildReviewQueue(items, new Map(), NO_PREF, 3)).toHaveLength(3);
    expect(buildReviewQueue(items, new Map(), NO_PREF, 3).map((t) => t.id)).toEqual(['t0', 't1', 't2']);
  });

  it('★ 凑不满 count 就如实短——**不复制同一条词条充数**', () => {
    const items = [makeTerm('only', { status: 'overdue', overdueDays: 1 })];
    const out = buildReviewQueue(items, new Map(), NO_PREF, 30);
    expect(out).toHaveLength(1);
    expect(new Set(out.map((t) => t.id)).size).toBe(out.length);
  });

  it('★ 毕业档（stage=7 / mastered）不进队列——塞回去等于让毕业失效', () => {
    const items = [
      makeTerm('grad', { status: 'mastered', domain: 'cs' }),
      makeTerm('due', { status: 'due' }),
    ];
    const out = buildReviewQueue(items, new Map(), NO_PREF, 99);
    expect(out.map((t) => t.id)).toEqual(['due']);
  });

  it('★ 同一词条在三段里只出现一次（跨段去重不靠"三段天然互斥"）', () => {
    // 构造一条同时"逾期"且"今天打过卡"的词条：真实场景是跨日瞬间，但去重必须不依赖它不发生
    const dup = makeTerm('dup', { status: 'overdue', overdueDays: 3 });
    const out = buildReviewQueue([dup, dup], new Map([['dup', '2026-09-21 09:00:00']]), NO_PREF, 99);
    expect(out).toHaveLength(1);
    expect(out[0]?.segment).toBe('due');
  });

  it('count 为 0 时返回空队列（不在本函数里替调用方兜底，兜底归 reviewQueue）', () => {
    const items = [makeTerm('a', { status: 'due' })];
    expect(buildReviewQueue(items, new Map(), NO_PREF, 0)).toEqual([]);
  });

  it('空池子返回空数组', () => {
    expect(buildReviewQueue([], new Map(), NO_PREF, 20)).toEqual([]);
  });
});
