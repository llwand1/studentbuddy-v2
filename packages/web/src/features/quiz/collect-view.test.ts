/**
 * collect-view 呈现层纯函数（契约 RESOURCE-SPEC §7：判定层必须可单测）。
 * 核心锁：commitSelection 只交「机验 ok 且人勾选」交集——ok=false 的草稿勾了也不提交。
 */
import { describe, it, expect } from 'vitest';
import type { CollectCandidate, CollectReport } from '@sb/shared';
import { collectNote, commitSelection } from './collect-view';

const okQ: CollectCandidate = {
  question: { type: 'single', question: '牛顿第二定律表达式？', options: ['F=ma', 'F=mv'], answer: [0] },
  ok: true,
};
const badQ: CollectCandidate = { question: { type: 'single', question: '疑似编制的长题干内容' }, ok: false, reason: 'verbatim 未命中' };

const report = (over: Partial<CollectReport>): CollectReport => ({
  queries: ['虚拟语气 练习题 答案'],
  providers: ['bing'],
  failed: [],
  pages: [],
  total: 2,
  accepted: 1,
  rejected: 1,
  ...over,
});

describe('collectNote', () => {
  it('逐层数字都念到：来源 / 抓页 n/m / 摘录可用拒绝', () => {
    const note = collectNote(
      report({ pages: [{ url: 'https://a', title: 't', fetched: true }, { url: 'https://b', title: 't2', fetched: false, reason: '超时' }] }),
    );
    expect(note).toContain('来源：bing');
    expect(note).toContain('抓页 1/2');
    expect(note).toContain('可用 1、拒绝 1');
  });
  it('有失败源时如实带出，不粉饰', () => {
    expect(collectNote(report({ failed: ['exa: 401'] }))).toContain('exa: 401');
  });
  it('没跑过（null / 空查询）返回空串，组件据此不渲染', () => {
    expect(collectNote(null)).toBe('');
    expect(collectNote(report({ queries: [] }))).toBe('');
  });
});

describe('commitSelection', () => {
  it('★ 全勾选也剔得掉机验未过的草稿（人验不能替机验放水）', () => {
    expect(commitSelection([okQ, badQ], [true, true])).toHaveLength(1);
  });
  it('人没勾的通过题也不提交（提交集=两门交集，不多不少）', () => {
    expect(commitSelection([okQ, badQ], [false, false])).toHaveLength(0);
  });
  it('勾选状态错位（数组比候选短）按未勾处理，不崩', () => {
    expect(commitSelection([okQ], [])).toHaveLength(0);
  });
});
