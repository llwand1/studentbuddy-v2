// @vitest-environment jsdom
/**
 * 「存为资料」按钮回归（契约 `docs/DOC-RAG-SPEC.md` §10、`docs/SOURCE-TRACE-SPEC.md` §8.2）。
 *
 * 锁四件事，都是「写错了界面照样能用、只是悄悄不对」的：
 * ① **存的是当前这一条的网址**——翻到第 3 条却把第 1 条存进去，屏上一点看不出来；
 * ② **只写文档模式、不碰资料架**——架子是「AI 这轮读了什么」，存为资料是「以后都按这页答」，
 *    两个语义混了就会出现「存一下，架子少一条」这种鬼事；
 * ③ **写完要喊 `DOC_CHANGED_EVENT`**——composer 上的 pill 不在同一棵子树里，不喊就不刷新，
 *    用户会以为没存上，于是连点好几次；
 * ④ **失败留在屏上**（ADR-5 不静默）：不恢复成「存为资料」装作什么都没发生。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react';
import type { SourceItem } from '@sb/shared';
import { DOC_CHANGED_EVENT } from '../chat/doc-events';
import { SaveAsDocButton } from './SaveAsDocButton';

const setFromUrl = vi.fn();
vi.mock('../../lib/api', () => ({ api: { doc: { setFromUrl: (...a: unknown[]) => setFromUrl(...a) } } }));

const item = (over: Partial<SourceItem> = {}): SourceItem => ({
  n: 1,
  url: 'https://mdn.example.org/array-map',
  title: 'Array.prototype.map()',
  site: 'mdn.example.org',
  kind: 'page',
  origin: 'read',
  ...over,
});

// ★ 必须是块体，不能写成 `beforeEach(() => setFromUrl.mockReset())`：
//   `mockReset()` **返回那个 mock 本身**，而 vitest 把 `beforeEach` 返回的函数当作**收尾回调**
//   ⇒ 每条用例跑完它都会去 **调用一次这个 mock**。本文件里有一条把实现设成「抛错」的用例，
//   于是收尾时凭空多出一个没人接的 rejection，整条用例被判红（排查了半天的真账，留个记号）。
beforeEach(() => {
  setFromUrl.mockReset();
});
afterEach(cleanup);

describe('SaveAsDocButton', () => {
  it('视频条目不渲染按钮（视频抓不出正文，存了也是一份空资料）', () => {
    const { container } = render(<SaveAsDocButton sessionId="s1" item={item({ kind: 'video' })} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('没有会话 id 时不渲染（无处可存）', () => {
    const { container } = render(<SaveAsDocButton sessionId="" item={item()} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('★ 点击 → 用**当前这一条**的网址调接口，成功后转「已存为资料」', async () => {
    setFromUrl.mockResolvedValue({
      doc: { name: 'Array.prototype.map()', chars: 1200, truncated: false },
      source: { url: 'https://mdn.example.org/array-map', title: 'Array.prototype.map()', site: 'mdn.example.org', sourceChars: 1200, clipped: false },
    });
    render(<SaveAsDocButton sessionId="s1" item={item()} />);

    fireEvent.click(screen.getByRole('button', { name: '存为资料' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '已存为资料' })).toBeTruthy());
    // 第二个参数必须是这一条的 url，不是别条、也不是标题
    expect(setFromUrl).toHaveBeenCalledWith('s1', 'https://mdn.example.org/array-map');
    expect(setFromUrl).toHaveBeenCalledTimes(1);
  });

  it('★ 成功后发出 DOC_CHANGED_EVENT（composer 上的 pill 靠它去重取）', async () => {
    setFromUrl.mockResolvedValue({
      doc: { name: 'x', chars: 1, truncated: false },
      source: { url: 'https://mdn.example.org/array-map', title: 'x', site: 'mdn.example.org', sourceChars: 1, clipped: false },
    });
    const heard = vi.fn();
    window.addEventListener(DOC_CHANGED_EVENT, heard);
    render(<SaveAsDocButton sessionId="s1" item={item()} />);

    fireEvent.click(screen.getByRole('button', { name: '存为资料' }));
    await waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    window.removeEventListener(DOC_CHANGED_EVENT, heard);
  });

  it('★ 失败 → 「没存成」留在屏上，且 title 里带得上原因（不静默恢复成初态）', async () => {
    // 用 mockImplementation 而不是 mockRejectedValue：后者在**布置阶段**就造出一个被拒的 promise，
    // 还没人 await 它，vitest 当场记一笔 unhandled rejection 把这条判红（实测踩到）
    setFromUrl.mockImplementation(async () => {
      throw new Error('这个地址不是网页（内容类型 application/pdf），载入资料只支持网页正文');
    });
    render(<SaveAsDocButton sessionId="s1" item={item()} />);

    fireEvent.click(screen.getByRole('button', { name: '存为资料' }));
    const failed = await screen.findByRole('button', { name: '没存成' });
    expect(failed.getAttribute('title')).toContain('application/pdf');
    expect(failed.getAttribute('title')).toContain('重试');
    // 还能再点一次（失败不是终点）
    expect((failed as HTMLButtonElement).disabled).toBe(false);
  });

  it('抓取途中按钮禁用，连点不会发第二次请求', async () => {
    let release: (v: unknown) => void = () => undefined;
    setFromUrl.mockReturnValue(new Promise((r) => (release = r)));
    render(<SaveAsDocButton sessionId="s1" item={item()} />);

    fireEvent.click(screen.getByRole('button', { name: '存为资料' }));
    const busy = await screen.findByRole('button', { name: '抓取中…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(setFromUrl).toHaveBeenCalledTimes(1);

    release({ doc: { name: 'x', chars: 1, truncated: false }, source: { url: 'u', title: 'x', site: 's', sourceChars: 1, clipped: false } });
  });
});
