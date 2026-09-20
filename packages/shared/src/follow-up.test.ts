/**
 * shared/follow-up 单测（契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §5.1）。
 *
 * 钉四件事：① `term` 不合格 ⇒ **整体拒绝**（含超长：拒绝而不截断，因为截断会连错图上节点）；
 * ② `question` 不合格 ⇒ **降级为缺省**，一个坏的可选字段不该让整次追问失败；
 * ③ 标题截断后长度受控且仍带前缀（侧栏要一眼看出"这是追问出来的"）；
 * ④ 归一**从不抛异常**（返回判别联合）——坏 body 只该变 400，不该变 500。
 */
import { describe, it, expect } from 'vitest';
import {
  FOLLOW_UP_QUESTION_MAX,
  FOLLOW_UP_TERM_MAX,
  FOLLOW_UP_TITLE_MAX,
  FOLLOW_UP_TITLE_PREFIX,
  defaultFollowUpQuestion,
  followUpTitle,
  normalizeFollowUpRequest,
} from './follow-up.js';

/** 取归一成功后的值；失败就抛（测试里不写非空断言，AGENTS.md 红线） */
function ok(raw: unknown): { term: string; question?: string } {
  const r = normalizeFollowUpRequest(raw);
  if (!r.ok) throw new Error(`本该归一成功，却报错：${r.error}`);
  return r.value;
}

/** 取归一失败的错误文案；成功就抛 */
function err(raw: unknown): string {
  const r = normalizeFollowUpRequest(raw);
  if (r.ok) throw new Error(`本该归一失败，却拿到：${JSON.stringify(r.value)}`);
  return r.error;
}

describe('normalizeFollowUpRequest — term 不合格一律拒绝', () => {
  it.each([
    ['不是对象（字符串）', '闭包'],
    ['是 null', null],
    ['是数组', []],
    ['缺 term', { question: 'x' }],
    ['term 不是字符串', { term: 42 }],
    ['term 是空串', { term: '' }],
    ['term 只有空白', { term: '   \n\t ' }],
  ])('%s ⇒ 报错', (_label, raw) => {
    expect(err(raw)).toBeTruthy();
  });

  it('★ term 超长 ⇒ 拒绝（不是截断：截断会连到错误的图上节点，不可自愈）', () => {
    const long = 'x'.repeat(FOLLOW_UP_TERM_MAX + 1);
    const message = err({ term: long });
    expect(message).toContain('过长');
    expect(message).toContain(String(FOLLOW_UP_TERM_MAX));
  });

  it('term 恰好等于上限 ⇒ 通过（边界不能误伤）', () => {
    const edge = 'x'.repeat(FOLLOW_UP_TERM_MAX);
    expect(ok({ term: edge }).term).toHaveLength(FOLLOW_UP_TERM_MAX);
  });

  it('term 前后空白被 trim（"闭包 " 与 "闭包" 是同一次追问，不该在图上分叉）', () => {
    expect(ok({ term: '  闭包  ' }).term).toBe('闭包');
  });
});

describe('normalizeFollowUpRequest — question 不合格降级为缺省', () => {
  it.each([
    ['数字', 42],
    ['null', null],
    ['对象', {}],
  ])('question 是 %s ⇒ 当作没填，term 照常通过', (_label, q) => {
    const v = ok({ term: '闭包', question: q });
    expect(v.term).toBe('闭包');
    expect(v).not.toHaveProperty('question');
  });

  it('question 是空白串 ⇒ 当作没填（不产出 question: "" 这种脏值）', () => {
    expect(ok({ term: '闭包', question: '   ' })).not.toHaveProperty('question');
  });

  it('★ question 超长 ⇒ 截断（与 term 相反：坏问题只是这次问得不完整，可重问）', () => {
    const v = ok({ term: '闭包', question: 'y'.repeat(FOLLOW_UP_QUESTION_MAX + 50) });
    expect(v.question).toHaveLength(FOLLOW_UP_QUESTION_MAX);
  });

  it('question 前后空白被 trim', () => {
    expect(ok({ term: '闭包', question: '  它和前端的闭包一样吗？  ' }).question).toBe('它和前端的闭包一样吗？');
  });

  it('★ 归一从不抛异常：喂各种奇怪 body 都只返回判别联合', () => {
    const weird: unknown[] = [undefined, 0, true, Symbol('s'), () => undefined, new Date()];
    for (const w of weird) {
      expect(() => normalizeFollowUpRequest(w)).not.toThrow();
    }
  });
});

describe('followUpTitle', () => {
  it('带前缀（侧栏要一眼看出这是追问出来的会话）', () => {
    expect(followUpTitle('闭包')).toBe(`${FOLLOW_UP_TITLE_PREFIX}闭包`);
  });

  it('★ 空词条名 ⇒ 退回裸「追问」，不产出「追问：undefined」这类脏标题', () => {
    expect(followUpTitle('  ')).toBe('追问');
  });

  it('超长词条名 ⇒ 截断且总长不超过上限（末尾带省略号）', () => {
    const t = followUpTitle('z'.repeat(200));
    expect(t.length).toBeLessThanOrEqual(FOLLOW_UP_TITLE_MAX);
    expect(t.startsWith(FOLLOW_UP_TITLE_PREFIX)).toBe(true);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('defaultFollowUpQuestion', () => {
  it('带上词条名（否则模型不知道该讲哪个词）', () => {
    expect(defaultFollowUpQuestion('闭包')).toContain('闭包');
  });

  it('空词条名 ⇒ 用「这个词条」兜底，不产出「请把「」讲透」', () => {
    const q = defaultFollowUpQuestion('   ');
    expect(q).toContain('这个词条');
    expect(q).not.toContain('「」');
  });
});
