// @vitest-environment jsdom
/**
 * 截图保底前端（契约 docs/SOURCE-TRACE-SPEC.md §13.1，jsdom，`api-sources` 桩掉）：
 * ① 探测 ok 且不薄 ⇒ 只有阅读页 iframe，没有出口条；探测失败（网络）也只是阅读页；图片类**不探测**；
 * ② 太薄且能截图 ⇒ iframe 之上出「用服务器截图看全」，点了换成截图视图（顶层 `<img>` 指向 `/shot`），「阅读模式」能切回；
 * ③ 打不开且能截图 ⇒ **自动**换成截图视图；图加载成功 / 失败的文案各异，失败态不再挂 img；
 * ④ 打不开但不能截图 ⇒ 什么都不加（失败页自己说）；换资料重新探测且回到阅读模式（旧探测 abort）。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import type { SourceItem } from '@sb/shared';
import type { ReaderProbe } from '../../lib/api-sources';
import { ReaderFrame } from './ReaderFrame';

const api = vi.hoisted(() => ({ probeReader: vi.fn() }));
vi.mock('../../lib/api-sources', () => ({
  probeReader: (...a: unknown[]) => api.probeReader(...a),
  shotUrl: (sessionId: string, url: string) => `/api/sources/shot?session=${sessionId}&url=${encodeURIComponent(url)}`,
  searchVideos: () => new Promise(() => undefined),
}));

const item = (n: number, kind: SourceItem['kind'] = 'page'): SourceItem => ({ n, url: `https://x.example.com/${n}${kind === 'image' ? '.png' : ''}`, title: `T${n}`, site: 'x.example.com', kind, origin: 'search' });
const probe = (p: Partial<ReaderProbe>): ReaderProbe => ({ ok: true, thin: false, shot: false, ...p });
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

// 块体而不是表达式体：`mockReset()` 返回 mock 本身，vitest 会把 beforeEach 的返回值当清理钩子去调
beforeEach(() => {
  api.probeReader.mockReset();
});
afterEach(cleanup);

describe('①', () => {
  it('ok 不薄 ⇒ 只有 iframe；探测自己失败也只有 iframe；图片不探测', async () => {
    api.probeReader.mockResolvedValueOnce(probe({}));
    const { container, rerender } = render(<ReaderFrame sessionId="s1" item={item(1)} />);
    expect(api.probeReader).toHaveBeenCalledWith('s1', 'https://x.example.com/1', 'T1', expect.any(AbortSignal));
    await flush();
    expect(container.querySelector('iframe')?.getAttribute('src')).toMatch(/^\/api\/sources\/view\?session=s1/);
    expect(container.querySelector('.src-thin')).toBeNull();
    api.probeReader.mockRejectedValueOnce(new Error('offline'));
    rerender(<ReaderFrame sessionId="s1" item={item(2)} />);
    await flush();
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(container.querySelector('.src-thin')).toBeNull();
    rerender(<ReaderFrame sessionId="s1" item={item(3, 'image')} />);
    expect(api.probeReader).toHaveBeenCalledTimes(2);
    expect(container.querySelector('iframe')?.getAttribute('src')).toContain('3.png');
  });
});

describe('②', () => {
  it('太薄 + 能截图 ⇒ 出口条，点了换截图视图，「阅读模式」切回', async () => {
    api.probeReader.mockResolvedValueOnce(probe({ thin: true, shot: true }));
    const { container, getByText } = render(<ReaderFrame sessionId="s1" item={item(1)} />);
    await flush();
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(container.querySelector('.src-thin')?.textContent).toContain('只拿到一小部分');
    fireEvent.click(getByText('用服务器截图看全'));
    expect(container.querySelector('iframe')).toBeNull();
    const img = container.querySelector('img.src-shot-img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/sources/shot?session=s1&url=https%3A%2F%2Fx.example.com%2F1');
    expect(container.querySelector('.src-shot')?.className).toContain('loading');
    fireEvent.click(getByText('阅读模式'));
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(container.querySelector('.src-shot')).toBeNull();
  });
});

describe('③', () => {
  it('打不开 + 能截图 ⇒ 自动截图视图；onLoad / onError 文案；失败态不挂 img', async () => {
    api.probeReader.mockResolvedValueOnce(probe({ ok: false, status: 502, reason: '对方返回 HTTP 403', shot: true }));
    const { container } = render(<ReaderFrame sessionId="s1" item={item(1)} />);
    expect(container.querySelector('iframe')).not.toBeNull(); // 探测回来之前先挂 iframe
    await flush();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.src-thin')?.textContent).toContain('正在用浏览器截图');
    fireEvent.load(container.querySelector('img.src-shot-img') as HTMLImageElement);
    expect(container.querySelector('.src-shot')?.className).toContain('ok');
    expect(container.querySelector('.src-thin')?.textContent).toContain('是一张图');
    expect(container.querySelector('.src-shot-wait')).toBeNull();
    fireEvent.error(container.querySelector('img.src-shot-img') as HTMLImageElement);
    expect(container.querySelector('.src-shot')?.className).toContain('error');
    expect(container.querySelector('img.src-shot-img')).toBeNull();
    expect(container.querySelector('.src-thin')?.textContent).toContain('截图也没成');
  });
});

describe('④', () => {
  it('打不开但不能截图 ⇒ 只有 iframe；换资料重新探测、回到阅读模式、旧探测 abort', async () => {
    const signals: AbortSignal[] = [];
    api.probeReader.mockImplementation((_s: string, url: string, _t: string, signal: AbortSignal) => {
      signals.push(signal);
      return url.endsWith('/1') ? Promise.resolve(probe({ ok: false, status: 415, reason: '不是网页', shot: false })) : new Promise(() => undefined);
    });
    const { container, rerender } = render(<ReaderFrame sessionId="s1" item={item(1)} />);
    await flush();
    expect(container.querySelector('iframe')).not.toBeNull();
    expect(container.querySelector('.src-thin')).toBeNull();
    api.probeReader.mockImplementationOnce((_s: string, _u: string, _t: string, signal: AbortSignal) => {
      signals.push(signal);
      return Promise.resolve(probe({ ok: false, status: 502, reason: 'x', shot: true }));
    });
    rerender(<ReaderFrame sessionId="s1" item={item(2)} />);
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(container.querySelector('.src-shot')).not.toBeNull();
    rerender(<ReaderFrame sessionId="s1" item={item(3)} />);
    expect(container.querySelector('.src-shot')).toBeNull();
    expect(container.querySelector('iframe')?.getAttribute('src')).toContain('x.example.com%2F3');
    expect(signals[1]?.aborted).toBe(true);
  });
});
