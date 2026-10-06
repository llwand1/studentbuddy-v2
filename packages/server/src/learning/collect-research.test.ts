import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCollectReport } from '@sb/shared';
import type { ExamContext } from './exam-mode.js';
const mock = vi.hoisted(() => ({ search: vi.fn(), generic: vi.fn(), fetch: vi.fn(), ai: vi.fn() }));
vi.mock('../search/exam-search.js', () => ({ searchExamWeb: mock.search }));
vi.mock('../search/index.js', async (original) => ({ ...await original<typeof import('../search/index.js')>(), searchWeb: mock.generic }));
vi.mock('../search/ssrf-guard.js', () => ({ fetchSafe: mock.fetch }));
vi.mock('../llm/router.js', () => ({ routeRole: () => ({ model: 'test' }) }));
vi.mock('../ai/gateway.js', () => ({ aiText: mock.ai }));
const { collectQuiz } = await import('./collect.js');
const topic = 'Java 线程池 拒绝策略';
const question = 'Java 线程池在任务队列已满时有哪些拒绝策略？';
const url = 'https://study.example/java-concurrent';
const exam: ExamContext = { on: true, hosts: ['study.example'], sources: [], summary: '技术面试', signature: 'test' };
beforeEach(() => {
  vi.clearAllMocks();
  mock.search.mockResolvedValue({ results: [{ title: 'Java 并发', url, snippet: question, source: 'entry' }], providers: ['entry'], failed: [], dropped: 8, directSites: ['技术资料'] });
  mock.generic.mockResolvedValue({ results: [], providers: ['bing'], failed: [], dropped: 0 });
  mock.fetch.mockResolvedValue(new Response(`<title>Java 并发</title><main>${'填充内容。'.repeat(9000)}${question}AbortPolicy 拒绝任务并抛出异常。CallerRunsPolicy 由调用者执行。</main>`, { headers: { 'content-type': 'text/html' } }));
  mock.ai.mockResolvedValue({ ok: true, text: `[QUIZ]${JSON.stringify({ title: topic, questions: [{ type: 'essay', question, answer: 'AbortPolicy 抛异常；CallerRunsPolicy 调用者执行。', explanation: '' }] })}[/QUIZ]` });
});

describe('主题检索到真实题目的完整搜集接线', () => {
  it('实时主题命中先抓，长文后半段题通过原文锁并带真实来源', async () => {
    const report = emptyCollectReport();
    const result = await collectQuiz(topic, report, { ownerId: 'user-a', exam });
    expect(mock.search).toHaveBeenCalledWith(topic, 'user-a', exam, { skipCache: true, signal: undefined, purpose: 'collect' });
    expect(mock.generic).not.toHaveBeenCalled();
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(mock.fetch.mock.calls[0]?.[0]).toBe(url);
    expect(mock.ai.mock.calls[0]?.[0].messages[0].content).toContain(`本次主题：${topic}`);
    expect(mock.ai.mock.calls[0]?.[0].messages[0].content).toContain(question);
    expect(result.candidates[0]).toMatchObject({ ok: true, question: { question, tier: 'real', source: { kind: 'collect', url } } });
    expect(report.accepted).toBe(1);
  });

  it('范围内无相关结果就不抓固定入口，更不调用摘题模型', async () => {
    mock.search.mockResolvedValue({ results: [], providers: ['bing'], failed: [], dropped: 8, directSites: [] });
    const report = emptyCollectReport();
    expect((await collectQuiz(topic, report, { exam })).candidates).toEqual([]);
    expect(report.scope?.empty).toBe(true);
    expect(mock.fetch).not.toHaveBeenCalled();
    expect(mock.ai).not.toHaveBeenCalled();
  });

  it('其它语言题即使逐字来自网页也不能混进本次 Java 主题', async () => {
    const wrong = 'C++ 的智能指针是如何管理对象生命周期的？';
    mock.ai.mockResolvedValue({ ok: true, text: `[QUIZ]${JSON.stringify({ title: topic, questions: [{ type: 'essay', question: wrong, answer: '引用计数' }] })}[/QUIZ]` });
    const result = await collectQuiz(topic, emptyCollectReport(), { exam });
    expect(result.candidates[0]).toMatchObject({ ok: false, reason: '题目语言与本次主题不匹配' });
  });

  it('关闭模式维持原有三条通用搜集词', async () => {
    await collectQuiz(topic, emptyCollectReport(), { exam: { ...exam, on: false } });
    expect(mock.search).not.toHaveBeenCalled();
    expect(mock.generic.mock.calls.map((c: unknown[]) => c[0])).toEqual([`${topic} 真题`, `${topic} 练习题 答案`, `${topic} 题库`]);
  });
});
