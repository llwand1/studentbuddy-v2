/**
 * 视频线路前端状态（契约 docs/SOURCE-TRACE-SPEC.md §12.3，node 环境，`api-sources` 桩掉）：
 * ① 带种子词打开 ⇒ 立即搜一次（线路 + 词）；同词再开不重搜；换会话重置并重搜；
 * ② 改词不自动搜、`runVideoSearch` 才搜且用清洗后的词；空词不搜；
 * ③ 切线路：没结果就搜，来回切回**同词**结果直接换上不重搜、播放位清空；
 * ④ 旧请求作废：连搜两次只认最后一次（先回来的旧结果丢、前一个 signal 已 abort）；出错进 error 且 result 清空；
 * ⑤ `playVideo` 只认 B站命中；关闭清播放位但留结果。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { VideoRouteResult } from '@sb/shared';

const api = vi.hoisted(() => ({ searchVideos: vi.fn() }));
vi.mock('./api-sources', () => ({ searchVideos: (...a: unknown[]) => api.searchVideos(...a) }));

const { closeVideoRoute, getVideoRoute, openVideoRoute, playVideo, resetVideoRouteStore, runVideoSearch, setVideoQuery, setVideoRoute } = await import('./video-route-store');

const res = (route: VideoRouteResult['route'], query: string, n = 1): VideoRouteResult => ({
  route,
  query,
  hits: Array.from({ length: n }, (_, i) => ({ route, url: route === 'bilibili' ? `https://www.bilibili.com/video/BV1nR4y1y75${i}` : `https://www.douyin.com/video/731123456789012345${i}`, title: `v${i}` })),
  siteSearchUrl: 'https://search.example.com/',
  via: 'api',
});
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetVideoRouteStore();
  api.searchVideos.mockReset();
  api.searchVideos.mockImplementation(async (route: VideoRouteResult['route'], q: string) => res(route, q));
});

describe('①② 打开与搜索', () => {
  it('带种子词打开立即搜；同词再开不重搜；换会话重置并重搜；改词要按搜；空词不搜', async () => {
    openVideoRoute('s1', '  牛顿第二定律 ');
    expect(getVideoRoute()).toMatchObject({ open: true, sessionId: 's1', route: 'bilibili', query: '牛顿第二定律', phase: 'loading' });
    await flush();
    expect(getVideoRoute().phase).toBe('done');
    expect(getVideoRoute().result?.hits).toHaveLength(1);
    expect(api.searchVideos).toHaveBeenCalledTimes(1);
    expect(api.searchVideos.mock.calls[0]?.slice(0, 2)).toEqual(['bilibili', '牛顿第二定律']);

    closeVideoRoute();
    openVideoRoute('s1', '别的种子');
    expect(getVideoRoute().query).toBe('牛顿第二定律'); // 已有词 ⇒ 种子不覆盖
    expect(api.searchVideos).toHaveBeenCalledTimes(1);

    openVideoRoute('s2', '勾股定理');
    expect(getVideoRoute()).toMatchObject({ sessionId: 's2', query: '勾股定理', phase: 'loading', result: null });
    await flush();
    expect(api.searchVideos).toHaveBeenCalledTimes(2);

    setVideoQuery('欧拉公式');
    expect(getVideoRoute().phase).toBe('done'); // 改词不自动搜
    expect(api.searchVideos).toHaveBeenCalledTimes(2);
    await runVideoSearch();
    expect(api.searchVideos.mock.calls[2]?.[1]).toBe('欧拉公式');
    setVideoQuery('   ');
    await runVideoSearch();
    expect(api.searchVideos).toHaveBeenCalledTimes(3);
  });
});

describe('③ 切线路', () => {
  it('没结果就搜；切回同词结果直接换上不重搜；播放位清空', async () => {
    openVideoRoute('s1', '牛顿');
    await flush();
    playVideo(getVideoRoute().result!.hits[0]!);
    expect(getVideoRoute().playing).not.toBeNull();
    setVideoRoute('douyin');
    expect(getVideoRoute()).toMatchObject({ route: 'douyin', phase: 'loading', playing: null });
    await flush();
    expect(getVideoRoute().result?.route).toBe('douyin');
    expect(api.searchVideos).toHaveBeenCalledTimes(2);
    setVideoRoute('bilibili');
    expect(getVideoRoute()).toMatchObject({ route: 'bilibili', phase: 'done' });
    expect(getVideoRoute().result?.route).toBe('bilibili');
    expect(api.searchVideos).toHaveBeenCalledTimes(2);
    setVideoRoute('bilibili');
    expect(api.searchVideos).toHaveBeenCalledTimes(2);
  });
});

describe('④ 旧请求作废 / 出错', () => {
  it('连搜两次只认最后一次；前一个 signal 被 abort；出错进 error 且 result 清空', async () => {
    let first: ((v: VideoRouteResult) => void) | null = null;
    const signals: AbortSignal[] = [];
    api.searchVideos.mockImplementationOnce((_r: unknown, _q: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<VideoRouteResult>((ok) => {
        first = ok;
      });
    });
    openVideoRoute('s1', '第一次');
    setVideoQuery('第二次');
    const p2 = runVideoSearch();
    expect(signals[0]?.aborted).toBe(true);
    first!(res('bilibili', '第一次', 5));
    await p2;
    await flush();
    expect(getVideoRoute().result?.query).toBe('第二次');
    expect(getVideoRoute().result?.hits).toHaveLength(1);

    api.searchVideos.mockRejectedValueOnce(new Error('HTTP 500'));
    setVideoQuery('第三次');
    await runVideoSearch();
    expect(getVideoRoute()).toMatchObject({ phase: 'error', error: 'HTTP 500', result: null });
  });
});

describe('⑤ 播放位', () => {
  it('playVideo 只认 B站；关闭清播放位留结果', async () => {
    openVideoRoute('s1', '牛顿');
    await flush();
    playVideo({ route: 'douyin', url: 'https://www.douyin.com/video/7311234567890123456', title: 'd' });
    expect(getVideoRoute().playing).toBeNull();
    const hit = getVideoRoute().result!.hits[0]!;
    playVideo(hit);
    expect(getVideoRoute().playing).toBe(hit);
    closeVideoRoute();
    expect(getVideoRoute()).toMatchObject({ open: false, playing: null, phase: 'done' });
    expect(getVideoRoute().result).not.toBeNull();
  });
});
