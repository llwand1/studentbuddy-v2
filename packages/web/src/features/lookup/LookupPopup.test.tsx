// @vitest-environment jsdom
/**
 * LookupPopup：划词速查小窗（契约 `docs/LOOKUP-SPEC.md`）。
 *
 * 钉四条产品口径，每条都对应上一版踩过的坑或用户明确提出的要求：
 *   ① **划中的原文原样显示在窗口顶部** —— 上一版翻车正是因为"模型拿到了什么"不可见；
 *   ② **先查维基、不烧额度** —— 开窗自动打维基，且此时**一次 AI 都不调**；
 *   ③ **维基查不到就把 AI 讲解提为主按钮**，划的是整句时直接跳过维基（不猜词）；
 *   ④ **答案只在小窗里** —— 组件完全不碰对话的任何入口（无 setInput、无发送）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { closeLookup, openLookup } from './lookup-store';

const wikiMock = vi.fn();
const explainMock = vi.fn();
const quizMock = vi.fn();
vi.mock('../../lib/api-lookup', () => ({
  lookupWiki: (...a: unknown[]) => wikiMock(...a),
  lookupExplain: (...a: unknown[]) => explainMock(...a),
  lookupQuiz: (...a: unknown[]) => quizMock(...a),
}));
vi.mock('../../lib/api', () => ({ api: { terms: { add: vi.fn(), extract: vi.fn() } } }));

const { LookupPopup } = await import('./LookupPopup');

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const TERM = { text: '闭包', heading: '闭包', section: '闭包\n它让内层函数记住外层变量', sourceTitle: 'JS 基础', sourceUrl: 'https://e.com/js' };
const SENTENCE = { ...TERM, text: '它让内层函数记住外层变量。' };

beforeEach(() => {
  wikiMock.mockReset().mockResolvedValue({ ok: true, title: '闭包 (计算机科学)', extract: '闭包是…', url: 'https://zh.wikipedia.org/wiki/闭包', lang: 'zh', redirected: true });
  explainMock.mockReset().mockResolvedValue({ ok: true, text: 'AI 的讲解内容' });
  quizMock.mockReset().mockResolvedValue({ ok: true, text: '三道题' });
});
afterEach(() => {
  closeLookup();
  cleanup();
});

describe('① 原文可见 + ② 免费优先', () => {
  it('开窗显示划中的原文，并自动查维基、此时一次 AI 都不调', async () => {
    render(<LookupPopup />);
    act(() => openLookup(TERM, 100, 100));
    await flush();
    expect(screen.getByTestId('lookup-popup').textContent).toContain('闭包');
    expect(wikiMock).toHaveBeenCalledTimes(1);
    expect(wikiMock.mock.calls[0]?.[0]).toBe('闭包');
    expect(explainMock).not.toHaveBeenCalled();
    expect(quizMock).not.toHaveBeenCalled();
  });

  it('命中的条目名与查询词不同时如实提示，不假装查的就是它', async () => {
    render(<LookupPopup />);
    act(() => openLookup(TERM, 100, 100));
    await flush();
    const t = screen.getByTestId('lookup-popup').textContent ?? '';
    expect(t).toContain('闭包 (计算机科学)');
    expect(t).toContain('你划的是');
  });
});

describe('③ 查不到 / 划整句时的降级', () => {
  it('维基查不到 ⇒ 显示原因，并切到 AI 讲解页签（但仍不自动烧额度）', async () => {
    wikiMock.mockResolvedValue({ ok: false, reason: '维基百科没有「闭包」的条目' });
    render(<LookupPopup />);
    act(() => openLookup(TERM, 100, 100));
    await flush();
    expect(screen.getByTestId('lookup-popup').textContent).toContain('没有「闭包」的条目');
    expect(explainMock).not.toHaveBeenCalled();
  });

  it('划的是整句 ⇒ 跳过维基（不猜词），直接把 AI 讲解摆到前台', async () => {
    render(<LookupPopup />);
    act(() => openLookup(SENTENCE, 100, 100));
    await flush();
    expect(wikiMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('lookup-popup').textContent).toContain('整句');
  });
});

describe('④ AI 结果只落在小窗里', () => {
  it('点「AI 讲解」才调模型，结果渲染在窗内；重复点不重复调', async () => {
    render(<LookupPopup />);
    act(() => openLookup(TERM, 100, 100));
    await flush();
    fireEvent.click(screen.getByText('AI 讲解'));
    await flush();
    expect(explainMock).toHaveBeenCalledTimes(1);
    expect(explainMock.mock.calls[0]?.[0]).toMatchObject({ text: '闭包', sourceUrl: 'https://e.com/js' });
    expect(screen.getByTestId('lookup-popup').textContent).toContain('AI 的讲解内容');
    fireEvent.click(screen.getByText('AI 讲解'));
    await flush();
    expect(explainMock).toHaveBeenCalledTimes(1); // 已有结果不再烧一次额度
  });

  it('模型失败 ⇒ 窗里显示原因，不留空白', async () => {
    explainMock.mockResolvedValue({ ok: false, reason: '模型 60 秒内没有答完' });
    render(<LookupPopup />);
    act(() => openLookup(TERM, 100, 100));
    await flush();
    fireEvent.click(screen.getByText('AI 讲解'));
    await flush();
    expect(screen.getByTestId('lookup-popup').textContent).toContain('没有答完');
  });

  it('Esc 与 × 都能关窗', async () => {
    render(<LookupPopup />);
    act(() => openLookup(TERM, 100, 100));
    await flush();
    fireEvent.keyDown(window, { key: 'Escape' });
    await flush();
    expect(screen.queryByTestId('lookup-popup')).toBeNull();
  });
});
