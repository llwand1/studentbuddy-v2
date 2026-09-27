import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizExplanationRequest } from '@sb/shared';
import { generateExplanation, parseExplanation, parseReviewRequest } from './quiz-explanation.js';
const model = vi.hoisted(() => ({ route: vi.fn(), chat: vi.fn() }));
vi.mock('../llm/router.js', () => ({ routeRole: model.route }));
const svg = "<svg viewBox='0 0 640 360'><rect x='10' y='10' width='180' height='80'/><text x='20' y='50'>光能转化</text></svg>";
const output = { summary: '你的答案把原料和产物混淆了。', sections: [{
  title: '能量与物质', questions: [1], explanation: '光能驱动水和二氧化碳转化。', svg, caption: '方框表示反应过程。',
}], transfer: { question: '没有光时会怎样？', answer: '需要区分光反应与其他阶段。' } };
const input: QuizExplanationRequest = { sessionId: 's', title: '光合作用', kind: 'quiz',
  items: [{ question: '产物是什么？', answer: '二氧化碳', expected: '有机物', verdict: 'wrong', context: '原题解析' }] };
beforeEach(() => {
  model.route.mockReset(); model.chat.mockReset();
  model.route.mockReturnValue({ model: 'test', apiKey: 'mock', baseUrl: 'mock', adapter: { chat: model.chat } });
  model.chat.mockImplementation(async function* () { yield { content: JSON.stringify(output), done: true }; });
});
describe('复盘协议与生成', () => {
  it('接受有界真实作答，剥离额外字段；拒绝空题组、异常题项与超长文本', () => {
    expect(parseReviewRequest({ ...input, extra: 'ignore' })).toEqual(input);
    expect(parseReviewRequest({ ...input, items: [] })).toBeNull();
    expect(parseReviewRequest({ ...input, items: [null] })).toBeNull();
    expect(parseReviewRequest({ ...input, title: 'x'.repeat(501) })).toBeNull();
    expect(parseReviewRequest({ ...input, items: Array(21).fill(input.items[0]) })).toBeNull();
  });
  it('完整 JSON 必须每节带图、文字、读图说明和迁移题，且覆盖每道题', () => {
    expect(parseExplanation(JSON.stringify(output), 1)).toEqual(output);
    expect(parseExplanation(JSON.stringify(output), 2)).toBeNull();
    expect(parseExplanation(JSON.stringify({ ...output, transfer: null }), 1)).toBeNull();
    expect(parseExplanation('普通文字解析', 1)).toBeNull();
  });
  it.each(['', '<svg></svg>', svg.replace('rect', 'script'), svg.replace('<text', '<image'), svg.replace("x='20'", "onload='alert(1)'")])('无效或危险 SVG 不算完成：%s', (bad) => {
    expect(parseExplanation(JSON.stringify({ ...output, sections: [{ ...output.sections[0], svg: bad }] }), 1)).toBeNull();
  });
  it('把真实作答交给题解角色，并显式传请求者与取消信号', async () => {
    const signal = new AbortController().signal;
    expect(await generateExplanation(input, 'owner', signal)).toEqual(output);
    expect(model.route).toHaveBeenCalledWith('solver', undefined, 'owner');
    const request = model.chat.mock.calls[0]?.[0];
    expect(request.signal).toBe(signal);
    expect(request.messages[1].content).toContain('二氧化碳');
    expect(request.messages[0].content).toContain('每节必须有真正解释原理的 SVG');
  });
  it('缺图重试一次，第二次仍缺图就明确失败', async () => {
    model.chat.mockImplementation(async function* () { yield { content: '{}', done: true }; });
    await expect(generateExplanation(input, null, new AbortController().signal)).rejects.toThrow('完整的图文');
    expect(model.chat).toHaveBeenCalledTimes(2);
  });
  it('第一次失败、第二次有效时保留完整图文', async () => {
    model.chat.mockImplementationOnce(async function* () { yield { content: '{}', done: true }; });
    expect(await generateExplanation(input, null, new AbortController().signal)).toEqual(output);
    expect(model.chat).toHaveBeenCalledTimes(2);
  });
  it('无模型与已取消都不启动生成', async () => {
    model.route.mockReturnValueOnce(null);
    await expect(generateExplanation(input, null, new AbortController().signal)).rejects.toThrow('题解');
    const c = new AbortController(); c.abort();
    await expect(generateExplanation(input, null, c.signal)).rejects.toThrow();
    expect(model.chat).not.toHaveBeenCalled();
  });
});
