// @vitest-environment jsdom
/**
 * ExpandDialog.test — 开拓弹窗三段（领地 → 先学 → 答题落地）的交互口径。
 *
 * 锁四件事：
 *  ① 打开即按点的坐标领地；来源如实写（词池兜底要看得出"降级"）；先学再答。
 *  ② 答错亮答案、可重答、**不重新领地**；两道全对才 `claim`，作答按题序整组提交。
 *  ③ 落地失败（凭证过期 / 格被占）话原样念出来，并留「重新领一块」这条路。
 *  ④ 领地失败（没词可领）有「再试一次」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContinentExpandOffer } from '@sb/shared';

const apiMock = { expandOffer: vi.fn(), expandClaim: vi.fn() };
vi.mock('../../lib/api', () => ({ api: { terms: apiMock } }));
// ★ 动态引入：让上面的 mock 先于组件的 `import { api }` 生效（与 ContinentPage.test 同手法）
const { ExpandDialog } = await import('./ExpandDialog');

function offerOf(over: Partial<ContinentExpandOffer> = {}): ContinentExpandOffer {
  return {
    nonce: 'n-1',
    row: 2,
    col: -1,
    term: '闭包',
    definition: '函数与它所引用的词法环境的组合',
    domain: 'js',
    source: 'fallback',
    fallbackReason: '没有绑定可用的模型，这条来自内置词池',
    questions: [
      { type: 'judge', prompt: '判断', statement: '「闭包」的意思是：函数与它所引用的词法环境的组合', answer: true },
      { type: 'fill', prompt: '填空', answer: '闭包' },
    ],
    expiresAt: Date.now() + 600_000,
    ...over,
  };
}

beforeEach(() => {
  apiMock.expandOffer.mockResolvedValue(offerOf());
  apiMock.expandClaim.mockResolvedValue({ ok: true, termId: 't-new', term: '闭包', row: 2, col: -1, source: 'fallback' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openToLearn() {
  const onExpanded = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<ExpandDialog cell={{ row: 2, col: -1 }} onExpanded={onExpanded} onClose={onClose} />);
  await waitFor(() => expect(screen.getByRole('button', { name: '记住了，开始答题' })).toBeTruthy());
  return { onExpanded, onClose };
}

describe('ExpandDialog', () => {
  it('① 打开即领地（带坐标）；先学卡片亮词条 + 释义 + 降级来源；两道题型预告', async () => {
    await openToLearn();
    expect(apiMock.expandOffer).toHaveBeenCalledWith(2, -1);
    expect(screen.getByRole('dialog', { name: '开拓新地块' })).toBeTruthy();
    expect(screen.getByText('闭包')).toBeTruthy();
    expect(screen.getByText('函数与它所引用的词法环境的组合')).toBeTruthy();
    const src = document.querySelector('.continent-expand-source');
    expect(src?.className).toContain('fallback');
    expect(src?.textContent).toContain('没有绑定可用的模型，这条来自内置词池');
    expect(src?.textContent).toContain('领域「js」');
    expect(screen.getByText(/接下来两道题：判断题 \+ 填空题/)).toBeTruthy();
  });

  it('① 模型生成的来源写「由模型按邻近领域现生成」，不带 fallback 类名', async () => {
    apiMock.expandOffer.mockResolvedValue(offerOf({ source: 'ai', fallbackReason: undefined }));
    await openToLearn();
    const src = document.querySelector('.continent-expand-source');
    expect(src?.className).not.toContain('fallback');
    expect(src?.textContent).toContain('由模型按邻近领域「js」现生成');
  });

  it('② 答错亮答案可重答（不重新领地）；两道全对 ⇒ 整组作答 claim ⇒ onExpanded(result, offer)', async () => {
    const { onExpanded } = await openToLearn();
    fireEvent.click(screen.getByRole('button', { name: '记住了，开始答题' }));
    expect(screen.getByText(/第 1 \/ 2 题/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '错' }));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(screen.getByText(/还不对。正确答案：对/)).toBeTruthy();
    expect(apiMock.expandOffer).toHaveBeenCalledTimes(1);
    expect(apiMock.expandClaim).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '对' }));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(screen.getByText(/第 2 \/ 2 题/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('填入词条'), { target: { value: ' 闭包 ' } });
    fireEvent.click(screen.getByRole('button', { name: '落地！' }));
    await waitFor(() => expect(apiMock.expandClaim).toHaveBeenCalledWith('n-1', [true, ' 闭包 ']));
    await waitFor(() => expect(onExpanded).toHaveBeenCalledTimes(1));
    expect(onExpanded.mock.calls[0]?.[0]).toMatchObject({ termId: 't-new', row: 2, col: -1 });
    expect(onExpanded.mock.calls[0]?.[1]).toMatchObject({ nonce: 'n-1', term: '闭包' });
  });

  it('③ 落地失败：话原样念出来 + 「重新领一块」重新走 offer', async () => {
    apiMock.expandClaim.mockRejectedValue(new Error('这一格已经不是空地了（刚被别的开拓占了）——换一格再开拓'));
    await openToLearn();
    fireEvent.click(screen.getByRole('button', { name: '记住了，开始答题' }));
    fireEvent.click(screen.getByRole('button', { name: '对' }));
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(screen.getByText(/第 2 \/ 2 题/)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('填入词条'), { target: { value: '闭包' } });
    fireEvent.click(screen.getByRole('button', { name: '落地！' }));
    await waitFor(() => expect(screen.getByText(/没落成：这一格已经不是空地了/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '重新领一块' }));
    await waitFor(() => expect(apiMock.expandOffer).toHaveBeenCalledTimes(2));
    // 重新领之后回到"先学"，题序归零
    await waitFor(() => expect(screen.getByRole('button', { name: '记住了，开始答题' })).toBeTruthy());
  });

  it('④ 领地失败：错误横幅 + 「再试一次」；关闭按钮走 onClose', async () => {
    apiMock.expandOffer.mockRejectedValueOnce(new Error('暂时领不到新词条：没有可用的模型，内置词池也抽完了'));
    const onClose = vi.fn();
    render(<ExpandDialog cell={{ row: 0, col: 1 }} onExpanded={vi.fn()} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/暂时领不到新词条/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '再试一次' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '记住了，开始答题' })).toBeTruthy());
    expect(apiMock.expandOffer).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: /关闭|收起|×/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
