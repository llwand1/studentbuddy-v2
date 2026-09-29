/**
 * api-ai-ops — 题型映射与"答题上报发了就不管"。
 */
import { describe, it, expect, vi } from 'vitest';

const req = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./api-request.js', () => ({ request: req.fn }));
const { aiOpsApi, answerQType } = await import('./api-ai-ops');

describe('answerQType', () => {
  it('前端题型映射到学习事件题型；解答题没有对错 ⇒ null（不上报）', () => {
    expect(answerQType('single')).toBe('choice');
    expect(answerQType('multiple')).toBe('multi');
    expect(answerQType('judge')).toBe('judge');
    expect(answerQType('fill')).toBe('fill');
    expect(answerQType('essay')).toBeNull();
  });
});

describe('reportAnswer', () => {
  it('批量形状发出；★ 服务端报错不往外抛（不能打断答题）', async () => {
    req.fn.mockRejectedValueOnce(new Error('offline'));
    expect(() => aiOpsApi.reportAnswer({ correct: true, qtype: 'fill', ms: 10 })).not.toThrow();
    await Promise.resolve();
    expect(req.fn).toHaveBeenCalledWith('/api/learning/answers', { method: 'POST', body: JSON.stringify({ items: [{ correct: true, qtype: 'fill', ms: 10 }] }) });
  });
});
