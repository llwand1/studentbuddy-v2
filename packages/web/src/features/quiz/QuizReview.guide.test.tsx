// @vitest-environment jsdom
/**
 * QuizReview.guide.test — 题卡复盘面板向引路灯「报名」的生命周期（契约 `docs/GUIDE-SPEC.md` §3）。
 *
 * 「一键解析」要用题卡里的作答状态，提灯不越界去抓，而是让面板自己在**真能点**的时候登记处理器。锁六条：
 *  ① 没答完 ⇒ 什么都不登记；答完 ⇒ `quiz.explain` 与 `quiz.retry` 都在；没有会话 id 讲解不了 ⇒ 只剩重练；
 *  ② ★ 执行「一键解析」：真的以当前作答调讲解接口，并先把这一区滚进视野（用户可能正停在别处，转圈要看得见）；
 *  ③ 生成中两个都撤销（与面板按钮生成中隐藏同口径），成功后**只剩重练**；失败后解析回来（按钮文案是「重新生成」）；
 *  ④ 执行「再练一遍」：交给 onRetry，并滚回这组题的顶部；
 *  ⑤ 卸载即注销；
 *  ⑥ 一个会话里好几张题卡：最近答完的那张生效，它卸载后退回前一张。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { QuizReviewItem } from '@sb/shared';
import { QuizReview } from './QuizReview';
import { getGuideLive, resetGuideStore, runGuideCap } from '../guide/guide-store';

const apiMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: apiMock }));

const result = {
  summary: '先区分能量和物质。',
  sections: [
    {
      title: '光能去向',
      questions: [1],
      explanation: '光能转为化学能。',
      svg: "<svg viewBox='0 0 200 100'><rect x='10' y='10' width='100' height='30'/><text x='20' y='60'>光能</text></svg>",
      caption: '方框表示转化。',
    },
  ],
  transfer: { question: '如果没有光呢？', answer: '光反应不能继续。' },
};
const item = (verdict: QuizReviewItem['verdict'] = 'wrong'): QuizReviewItem => ({ question: '叶绿体的作用？', answer: 'B', expected: 'A', verdict, context: '解析' });

const scroll = vi.fn();
beforeEach(() => {
  resetGuideStore();
  apiMock.request.mockReset();
  scroll.mockReset();
  HTMLElement.prototype.scrollIntoView = scroll;
});
afterEach(() => {
  cleanup();
  resetGuideStore();
});

const mount = (over: Partial<Parameters<typeof QuizReview>[0]> = {}) =>
  render(<QuizReview sessionId="s" title="练习" kind="quiz" items={[item()]} total={1} onRetry={() => undefined} {...over} />);

describe('① 什么时候报名', () => {
  it('没答完 ⇒ 不登记；答完 ⇒ 解析与重练都在', () => {
    const { rerender } = mount({ items: [], total: 2 });
    expect(getGuideLive().kinds).toEqual([]);
    rerender(<QuizReview sessionId="s" title="练习" kind="quiz" items={[item(), item('correct')]} total={2} onRetry={() => undefined} />);
    expect(getGuideLive().kinds).toEqual(['quiz.explain', 'quiz.retry']);
  });

  it('没有会话 id（讲解要按会话出）⇒ 只剩重练；没有 onRetry ⇒ 不登记重练', () => {
    mount({ sessionId: null });
    expect(getGuideLive().kinds).toEqual(['quiz.retry']);
    cleanup();
    mount({ onRetry: undefined });
    expect(getGuideLive().kinds).toEqual(['quiz.explain']);
  });
});

describe('② 执行一键解析', () => {
  it('★ 以当前作答调讲解接口，并先把这一区滚进视野', async () => {
    apiMock.request.mockResolvedValue(result);
    mount();
    act(() => void runGuideCap('quiz.explain'));
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    expect(apiMock.request).toHaveBeenCalledTimes(1);
    const [url, init] = apiMock.request.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/quiz/explain');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({ sessionId: 's', title: '练习', kind: 'quiz', items: [{ answer: 'B', verdict: 'wrong' }] });
    await waitFor(() => expect(getGuideLive().kinds).toEqual(['quiz.retry']));
  });
});

describe('③ 生成中 / 成功 / 失败', () => {
  it('生成中两个都撤销；成功后只剩重练', async () => {
    let done: (v: unknown) => void = () => undefined;
    apiMock.request.mockReturnValue(new Promise((r) => (done = r)));
    mount();
    act(() => void runGuideCap('quiz.explain'));
    await waitFor(() => expect(getGuideLive().kinds).toEqual([]));
    await act(async () => done(result));
    await waitFor(() => expect(getGuideLive().kinds).toEqual(['quiz.retry']));
  });

  it('★ 失败后解析回来（可重新生成），重练也回来', async () => {
    apiMock.request.mockRejectedValue(new Error('讲解生成失败'));
    mount();
    act(() => void runGuideCap('quiz.explain'));
    await waitFor(() => expect(getGuideLive().kinds).toEqual(['quiz.explain', 'quiz.retry']));
  });

  it('生成中再点一次解析：没人登记了 ⇒ runGuideCap 返回 false（提灯会说「现在做不了」），不会发第二次请求', async () => {
    apiMock.request.mockReturnValue(new Promise(() => undefined));
    mount();
    act(() => void runGuideCap('quiz.explain'));
    await waitFor(() => expect(getGuideLive().kinds).toEqual([]));
    expect(runGuideCap('quiz.explain')).toBe(false);
    expect(apiMock.request).toHaveBeenCalledTimes(1);
  });
});

describe('④ 执行再练一遍', () => {
  it('交给 onRetry，并滚回这组题的顶部（面板的父节点）', () => {
    const onRetry = vi.fn();
    mount({ onRetry });
    act(() => void runGuideCap('quiz.retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
  });
});

describe('⑤⑥ 卸载与多张题卡', () => {
  it('卸载即注销', () => {
    const { unmount } = mount();
    expect(getGuideLive().kinds).toEqual(['quiz.explain', 'quiz.retry']);
    unmount();
    expect(getGuideLive().kinds).toEqual([]);
  });

  it('★ 两张都答完了：执行的是最近登记的那张；它卸载后退回前一张', () => {
    const first = vi.fn();
    const second = vi.fn();
    mount({ onRetry: first });
    const b = mount({ onRetry: second });
    act(() => void runGuideCap('quiz.retry'));
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    b.unmount();
    act(() => void runGuideCap('quiz.retry'));
    expect(first).toHaveBeenCalledTimes(1);
  });
});
