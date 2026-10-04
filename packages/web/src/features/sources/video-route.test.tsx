// @vitest-environment jsdom
/**
 * 视频线路面板（契约 docs/SOURCE-TRACE-SPEC.md §12.3，jsdom，`api-sources` 桩掉）：
 * ① 脚注「找视频」：种子词优先架上的搜索词，否则从正文推；打开即搜；面板换成视频视图、`[ ]` 键位不再切架子；
 * ② 命中卡：B站卡带封面（no-referrer）、时长与播放量、点了就地播（官方播放器 iframe、脚本沙箱）、头部出「原网页」；
 *    抖音卡无封面、右侧 ↗、点了开新标签页**不**播；说明条如实；站内搜索链接永远在；
 * ③ 切线路重搜、零命中只剩站内搜索出口、出错也给站内搜索；「资料 n」切回架子、× 全关。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import type { SourceItem, VideoRouteResult } from '@sb/shared';
import { applyLiveSources, getSources, resetSourcesStore } from '../../lib/sources-store';
import { closePreview } from '../../lib/preview-store';
import { getVideoRoute, resetVideoRouteStore } from '../../lib/video-route-store';
import { MessageFoot } from '../chat/MessageFoot';
import { SourcePanel } from './SourcePanel';

const api = vi.hoisted(() => ({ searchVideos: vi.fn(), probeReader: vi.fn() }));
vi.mock('../../lib/api-sources', () => ({
  readReaderPage: () => new Promise(() => undefined),
  followSource: () => Promise.resolve({ ok: true, url: '', site: '' }),
  searchVideos: (...a: unknown[]) => api.searchVideos(...a),
  probeReader: (...a: unknown[]) => api.probeReader(...a),
  shotUrl: () => '/api/sources/shot?x',
}));

const bili = (i: number) => ({ route: 'bilibili' as const, url: `https://www.bilibili.com/video/BV1nR4y1y75${i}`, title: `B站讲解 ${i}`, author: `UP${i}`, cover: `https://i0.hdslb.com/c${i}.jpg`, duration: '12:34', plays: 675_661 });
const dy = (i: number) => ({ route: 'douyin' as const, url: `https://www.douyin.com/video/731123456789012345${i}`, title: `抖音 ${i}`, snippet: '一分钟' });
const result = (route: VideoRouteResult['route'], query: string, hits: VideoRouteResult['hits'], extra: Partial<VideoRouteResult> = {}): VideoRouteResult => ({
  route,
  query,
  hits,
  siteSearchUrl: `https://site.example.com/${route}?q=${encodeURIComponent(query)}`,
  via: hits.length > 0 ? 'api' : 'none',
  ...extra,
});
const item = (n: number, extra: Partial<SourceItem> = {}): SourceItem => ({ n, url: `https://x.example.com/${n}`, title: `T${n}`, site: 'x.example.com', kind: 'page', origin: 'search', ...extra });
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

beforeEach(() => {
  resetSourcesStore();
  resetVideoRouteStore();
  closePreview();
  api.searchVideos.mockReset();
  api.probeReader.mockReset();
  api.probeReader.mockImplementation(() => new Promise(() => undefined));
});
afterEach(cleanup);

describe('① 入口', () => {
  it('「找视频」只挂回答行；种子词：架上搜索词 > 正文推导；打开即搜；面板成视频视图、键位不切架子', async () => {
    api.searchVideos.mockImplementation(async (route: VideoRouteResult['route'], q: string) => result(route, q, [bili(1)]));
    const ask = render(<MessageFoot content="牛顿第二定律是什么" sessionId="s1" />); // 提问行：canVideos 默认 false
    expect(ask.queryByText('找视频')).toBeNull();
    ask.unmount();
    const { getByText, unmount } = render(<MessageFoot content={'## 牛顿第二定律\n正文'} sessionId="s1" sources={[item(1, { query: '牛顿第二定律 高中 讲解' })]} canVideos />);
    fireEvent.click(getByText('找视频'));
    expect(getVideoRoute()).toMatchObject({ open: true, sessionId: 's1', query: '牛顿第二定律 高中 讲解', phase: 'loading' });
    unmount();
    resetVideoRouteStore();
    const foot = render(<MessageFoot content={'先看结论。\n\n## 光合作用\n\n分两个阶段'} sessionId="s1" canVideos />);
    fireEvent.click(foot.getByText('找视频'));
    expect(getVideoRoute().query).toBe('光合作用');
    await flush();
    expect(api.searchVideos).toHaveBeenLastCalledWith('bilibili', '光合作用', expect.anything());

    applyLiveSources({ kind: 'sources', sessionId: 's1', items: [item(1), item(2)] });
    const { container } = render(<SourcePanel />);
    expect(container.querySelector('.sb-video-route')).not.toBeNull();
    expect(container.querySelector('.src-tabs')).toBeNull();
    expect(container.querySelector('.sb-browser-badge')?.textContent).toBe('视频');
    fireEvent.keyDown(window, { key: ']' });
    expect(getSources().activeN).toBe(1);
  });
});

describe('② 命中卡', () => {
  it('B站卡封面 / 元信息 / 就地播 + 头部原网页；抖音卡 ↗ 开新标签页不播；站内搜索链接在', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    api.searchVideos.mockImplementation(async (route: VideoRouteResult['route'], q: string) =>
      route === 'bilibili' ? result(route, q, [bili(1), bili(2)]) : result(route, q, [dy(1)], { via: 'web', note: '抖音不开放接口、不许嵌播' }),
    );
    applyLiveSources({ kind: 'sources', sessionId: 's1', items: [item(1, { query: '牛顿' })] });
    const { container } = render(<SourcePanel />);
    fireEvent.click(Array.from(container.querySelectorAll('.sb-browser-btn')).find((b) => b.textContent === '找视频') as HTMLElement);
    await flush();
    const cards = container.querySelectorAll('.vr-card:not(.vr-site)'); // 站内搜索出口也长成卡，但不算命中
    expect(cards).toHaveLength(2);
    const cover = cards[0]!.querySelector('img.vr-cover') as HTMLImageElement;
    expect(cover.getAttribute('src')).toBe('https://i0.hdslb.com/c1.jpg');
    expect(cover.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(cards[0]!.querySelector('.vr-meta')?.textContent).toBe('UP1 · 12:34 · 68万播放');
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(cards[0] as HTMLElement);
    const player = container.querySelector('iframe.vr-player') as HTMLIFrameElement;
    expect(player.getAttribute('src')).toBe('https://player.bilibili.com/player.html?bvid=BV1nR4y1y751&autoplay=0&high_quality=1');
    expect(player.getAttribute('sandbox')).toContain('allow-scripts');
    expect(container.querySelector('.vr-card.active .vr-act')?.textContent).toBe('播放中');
    expect(container.querySelector('.sb-browser-title')?.textContent).toBe('B站讲解 1');
    fireEvent.click(Array.from(container.querySelectorAll('.sb-browser-btn')).find((b) => b.textContent === '原网页') as HTMLElement);
    expect(open).toHaveBeenLastCalledWith('https://www.bilibili.com/video/BV1nR4y1y751', '_blank', 'noopener,noreferrer');
    expect((container.querySelector('a.vr-site') as HTMLAnchorElement).getAttribute('href')).toBe('https://site.example.com/bilibili?q=%E7%89%9B%E9%A1%BF');

    fireEvent.click(Array.from(container.querySelectorAll('.vr-route')).find((b) => b.textContent === '抖音') as HTMLElement);
    await flush();
    expect(container.querySelector('iframe')).toBeNull(); // 切线路清播放位
    const card = container.querySelector('.vr-card.jump:not(.vr-site)') as HTMLElement;
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('.vr-cover-blank')?.textContent).toBe('抖音');
    expect(card.querySelector('.vr-act')?.textContent).toBe('↗');
    expect(container.querySelector('.vr-note')?.textContent).toContain('不许嵌播');
    fireEvent.click(card);
    expect(open).toHaveBeenLastCalledWith('https://www.douyin.com/video/7311234567890123451', '_blank', 'noopener,noreferrer');
    expect(getVideoRoute().playing).toBeNull();
    open.mockRestore();
  });
});

describe('③ 零命中 / 出错 / 切回', () => {
  it('零命中只剩站内搜索出口；出错也给站内搜索；「资料 n」切回架子；× 全关', async () => {
    api.searchVideos.mockResolvedValueOnce(result('bilibili', '冷门词', [], { note: 'B站站内没搜到这个词的视频' }));
    applyLiveSources({ kind: 'sources', sessionId: 's1', items: [item(1, { query: '冷门词' }), item(2)] });
    const { container } = render(<SourcePanel />);
    fireEvent.click(Array.from(container.querySelectorAll('.sb-browser-btn')).find((b) => b.textContent === '找视频') as HTMLElement);
    await flush();
    expect(container.querySelectorAll('.vr-card:not(.vr-site)')).toHaveLength(0);
    expect(container.querySelector('.vr-note.none')?.textContent).toContain('没搜到');
    expect(container.querySelector('a.vr-site')?.textContent).toContain('去B站站内搜「冷门词」');

    api.searchVideos.mockRejectedValueOnce(new Error('HTTP 502'));
    fireEvent.change(container.querySelector('.vr-input') as HTMLInputElement, { target: { value: '另一个词' } });
    fireEvent.submit(container.querySelector('.vr-bar') as HTMLFormElement);
    await flush();
    expect(container.querySelector('.vr-note.error')?.textContent).toContain('HTTP 502');
    expect((container.querySelector('a.vr-site') as HTMLAnchorElement).getAttribute('href')).toBe('https://search.bilibili.com/all?keyword=%E5%8F%A6%E4%B8%80%E4%B8%AA%E8%AF%8D');

    fireEvent.click(Array.from(container.querySelectorAll('.sb-browser-btn')).find((b) => b.textContent === '资料 2') as HTMLElement);
    expect(container.querySelector('.src-tabs')).not.toBeNull();
    expect(getVideoRoute().open).toBe(false);
    fireEvent.click(Array.from(container.querySelectorAll('.sb-browser-btn')).find((b) => b.textContent === '找视频') as HTMLElement);
    expect(getVideoRoute()).toMatchObject({ open: true, query: '另一个词' });
    fireEvent.click(container.querySelector('.sb-browser-close') as HTMLElement);
    expect(getVideoRoute().open).toBe(false);
    expect(getSources().open).toBe(false);
    expect(container.querySelector('aside')).toBeNull();
  });
});
