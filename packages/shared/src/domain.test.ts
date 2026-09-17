/**
 * 深度理解类型登记锁定（DEEP-UNDERSTANDING-SPEC v1.1 §6.1/§8/§9.1 · WBS 任务 1）。
 * 本文件多数断言在「编译即通过」层面生效——BlockKind 摘掉 'verdict'、
 * ContentBlock<'verdict'> 的 payload 退回 GenericPayload、met 被改成必填，
 * 都会让 tsc 直接红；运行期 expect 只锁字段名与形状，防手滑改名。
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlock } from './content-blocks.js';
import type { Verdict, EvolutionState, EvolutionEventRow } from './domain.js';

describe('深度理解类型登记 — Verdict（v1.1 含 met）', () => {
  it('必填仅 term/level/verdict，gaps/nextGoal/evidence/met 全可选（v1 兼容形状可构造）', () => {
    const bare: Verdict = { term: '闭包', level: 2, verdict: '说清了捕获' };
    expect(bare.met).toBeUndefined();
    expect(bare.gaps).toBeUndefined();
  });

  it('v1.1 完整形状：met 与 gaps/nextGoal/evidence 共存，字段透传', () => {
    const v: Verdict = {
      term: '闭包',
      level: 2,
      verdict: '你把「函数记住外部变量」说清楚了，但没说清捕获的是变量本身还是值。',
      gaps: ['未区分捕获变量与捕获值'],
      nextGoal: '说清闭包捕获变量的生命周期，并举一个踩坑例子',
      evidence: '用户原话中最能支撑判定的一句',
      met: ['说清了捕获的是变量本身而非值'],
    };
    expect(v.met).toHaveLength(1);
    expect(v.gaps).toHaveLength(1);
    expect(v.nextGoal).toContain('生命周期');
  });

  it('met 空数组合法（诚实档：本轮无新证据，与字段缺失同形可构造）', () => {
    const honest: Verdict = { term: '栈', level: 1, verdict: '本轮无新证据', met: [] };
    expect(honest.met).toEqual([]);
  });
});

describe('深度理解类型登记 — BlockKind verdict（§9.1）', () => {
  it("ContentBlock<'verdict'> 的 payload 收窄为 Verdict（退回 GenericPayload 则此编译不过）", () => {
    const b: ContentBlock<'verdict'> = {
      kind: 'verdict',
      blockId: 'evo-t1-1755000000000',
      payload: { term: '闭包', level: 1, verdict: '要素齐了', met: [] },
    };
    // 编译锁：payload 若不是 Verdict，这一行赋值不过
    const p: Verdict = b.payload;
    expect(p.term).toBe('闭包');
  });

  it("BlockKind 联合含 'verdict'（摘除登记则数组字面量编译红）", () => {
    const kinds: ContentBlock['kind'][] = ['quiz', 'chart', 'actions', 'svg', 'verdict'];
    expect(kinds).toContain('verdict');
  });
});

describe('深度理解类型登记 — §8 shared 三件套', () => {
  it('EvolutionState：active + terms（level 当前级 / bestLevel 只增级并列）', () => {
    const s: EvolutionState = {
      active: true,
      terms: [{ id: 't1', term: '闭包', domain: 'cs', definition: '函数记住外部变量', level: 2, bestLevel: 3 }],
    };
    expect(s.terms[0]?.bestLevel).toBe(3);
    expect(s.terms[0]?.level).toBe(2);
  });

  it('EvolutionEventRow：链节点行（termText 抗删快照；gaps 为解析后的 string[]）', () => {
    const row: EvolutionEventRow = {
      id: 'e1',
      sessionId: 's1',
      termId: 't1',
      termText: '闭包',
      fromLevel: 1,
      toLevel: 2,
      verdict: '要素完整、术语用对',
      gaps: ['说不出适用边界'],
      nextGoal: '讲清边界与反例',
      userSay: '闭包就是函数记住了外面的变量……',
      createdAt: '2026-09-06 10:00:00',
    };
    expect(row.toLevel).toBeGreaterThan(row.fromLevel);
    expect(row.gaps).toHaveLength(1);
    expect(row.nextGoal).toBeTruthy();
  });
});
