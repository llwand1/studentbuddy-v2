/**
 * 视频线路取数（契约 docs/SOURCE-TRACE-SPEC.md §12；接口与联网搜索都用注入的假件）：
 * ① B站接口 JSON → 命中：剥高亮、封面补协议、坏行跳过、最多 8 条；`code≠0` / 形状不对 ⇒ 抛；
 * ② B站主路：先领设备 cookie（`finger/spi`）再搜且搜索请求带 `Cookie`，成功 ⇒ `via:'api'`，**不碰**联网搜索；
 *    cookie 复用不重领；412 ⇒ 换新 cookie 重试一次；零命中如实 `note`；
 * ③ B站退路：接口抛 ⇒ `site:bilibili.com/video` 联网搜索抠 BV 号 ⇒ `via:'web'`；两条都空 ⇒ `via:'none'` + 站内搜索页；
 * ④ 抖音只走联网、只留视频页（主页 / 搜索页不算）、零命中 `via:'none'` 但 `siteSearchUrl` 永远在；
 * ⑤ 缓存：同线路同词（忽略大小写）10 分钟内不再打接口；`via:'none'` 不缓存（下次还能再试）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SearchResult } from '../search/types.js';
import { BILI_FINGER_API, hitsFromWeb, parseBilibiliSearch, resetVideoRouteCache, searchVideoRoute } from './video-route.js';

const biliRow = (i: number, extra: Record<string, unknown> = {}) => ({
  bvid: `BV1nR4y1y75${String.fromCharCode(97 + i)}`,
  title: `【物理】<em class="keyword">牛顿第二定律</em> 第${i}讲`,
  author: `UP${i}`,
  pic: '//i2.hdslb.com/bfs/archive/x.jpg',
  duration: '12:34',
  play: 675_661,
  description: '讲义下载 &amp; 资料',
  ...extra,
});
const okJson = (rows: unknown[]) => ({ code: 0, message: 'OK', data: { result: rows } });
const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const FINGER = { code: 0, data: { b_3: 'B3-X', b_4: 'B4-Y' } };
/** 假 B站：cookie 端点给设备号，搜索端点按 `onSearch` 回；记录搜索请求带的 Cookie */
const fakeBili = (onSearch: (n: number, cookie: string) => Response) => {
  const calls: { finger: number; search: string[] } = { finger: 0, search: [] };
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    if (url.startsWith(BILI_FINGER_API)) {
      calls.finger += 1;
      return jsonResponse(FINGER);
    }
    const cookie = String((init.headers as Record<string, string>).Cookie ?? '');
    calls.search.push(cookie);
    return onSearch(calls.search.length, cookie);
  });
  return { fetchImpl, calls };
};
const web = (url: string, title = 't', snippet = 's'): SearchResult => ({ title, url, snippet, source: 'bing' });

beforeEach(() => resetVideoRouteCache());

describe('① parseBilibiliSearch', () => {
  it('剥高亮、封面补 https:、描述截 120、坏行跳过、最多 8 条；code≠0 / 形状不对 ⇒ 抛', () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => biliRow(i)),
      biliRow(9, { bvid: 'av123' }),
      biliRow(10, { title: '' }),
      biliRow(11, { pic: 'javascript:alert(1)', description: 'x'.repeat(300), play: 'many' }),
    ];
    const hits = parseBilibiliSearch(okJson(rows));
    expect(hits).toHaveLength(8);
    expect(hits[0]).toMatchObject({ route: 'bilibili', url: 'https://www.bilibili.com/video/BV1nR4y1y75a', title: '【物理】牛顿第二定律 第0讲', author: 'UP0', cover: 'https://i2.hdslb.com/bfs/archive/x.jpg', duration: '12:34', plays: 675_661, snippet: '讲义下载 & 资料' });
    const odd = parseBilibiliSearch(okJson([biliRow(11, { pic: 'javascript:alert(1)', description: 'x'.repeat(300), play: 'many' })]))[0]!;
    expect(odd.cover).toBeUndefined();
    expect(odd.plays).toBeUndefined();
    expect(odd.snippet).toHaveLength(120);
    expect(() => parseBilibiliSearch({ code: -412, message: '请求被拦截' })).toThrow(/-412/);
    expect(() => parseBilibiliSearch({ code: 0, data: {} })).toThrow(/形状/);
    expect(() => parseBilibiliSearch(null)).toThrow();
  });
});

describe('②③ B站：接口主路 + 联网退路', () => {
  it('先领 cookie 再搜且带 Cookie；成功 ⇒ via:api 且不碰联网搜索；cookie 复用；412 换新重试；零命中如实 note', async () => {
    const search = vi.fn(async () => [] as SearchResult[]);
    const bili = fakeBili(() => jsonResponse(okJson([biliRow(0)])));
    const r = await searchVideoRoute('bilibili', '  牛顿第二定律 ', null, undefined, { search, fetchImpl: bili.fetchImpl });
    expect(r).toMatchObject({ route: 'bilibili', query: '牛顿第二定律', via: 'api', siteSearchUrl: 'https://search.bilibili.com/all?keyword=%E7%89%9B%E9%A1%BF%E7%AC%AC%E4%BA%8C%E5%AE%9A%E5%BE%8B' });
    expect(r.hits).toHaveLength(1);
    expect(search).not.toHaveBeenCalled();
    expect(bili.calls).toEqual({ finger: 1, search: ['buvid3=B3-X; buvid4=B4-Y'] });
    expect(String(bili.fetchImpl.mock.calls[1]?.[0])).toContain(`search_type=video&keyword=${encodeURIComponent('牛顿第二定律')}`);

    const again = fakeBili(() => jsonResponse(okJson([biliRow(1)])));
    await searchVideoRoute('bilibili', '另一个词', null, undefined, { search, fetchImpl: again.fetchImpl });
    expect(again.calls.finger).toBe(0); // 进程内复用，不重领

    const risky = fakeBili((n) => (n === 1 ? new Response('<html>412</html>', { status: 412 }) : jsonResponse(okJson([biliRow(2)]))));
    const retried = await searchVideoRoute('bilibili', '风控词', null, undefined, { search, fetchImpl: risky.fetchImpl });
    expect(retried.via).toBe('api');
    expect(risky.calls.finger).toBe(1);
    expect(risky.calls.search).toHaveLength(2);

    const empty = await searchVideoRoute('bilibili', '冷门词', null, undefined, { search, fetchImpl: fakeBili(() => jsonResponse(okJson([]))).fetchImpl });
    expect(empty.via).toBe('none');
    expect(empty.note).toContain('没搜到');
  });

  it('接口失败 ⇒ 联网 site:bilibili.com/video 抠 BV 号 via:web；两头都空 ⇒ via:none 带原因', async () => {
    const search = vi.fn(async (q: string) => {
      expect(q).toBe('site:bilibili.com/video 勾股定理');
      return [web('https://www.bilibili.com/video/BV1GJ411x7h7/?p=1', '勾股定理讲解_哔哩哔哩_bilibili', '摘要'), web('https://space.bilibili.com/1', '主页'), web('https://www.bilibili.com/video/BV1GJ411x7h7', '重复')];
    });
    const r = await searchVideoRoute('bilibili', '勾股定理', null, undefined, { search, fetchImpl: fakeBili(() => jsonResponse({ code: -412 })).fetchImpl });
    expect(r.via).toBe('web');
    expect(r.hits).toEqual([{ route: 'bilibili', url: 'https://www.bilibili.com/video/BV1GJ411x7h7', title: '勾股定理讲解', snippet: '摘要' }]);
    expect(r.note).toContain('接口没应答');

    const none = await searchVideoRoute('bilibili', '别的词', null, undefined, {
      search: async () => {
        throw new Error('bing down');
      },
      fetchImpl: fakeBili(() => jsonResponse({}, 503)).fetchImpl,
    });
    expect(none).toMatchObject({ via: 'none', hits: [] });
    expect(none.note).toMatch(/HTTP 503/);
    expect(none.note).toContain('失败了');
  });
});

describe('④ 抖音：只走联网、只留视频页', () => {
  it('hitsFromWeb 只认 /video/<id> 与 v.douyin 短链并去重；零命中 via:none 但站内搜索页永远在', async () => {
    const results = [
      web('https://www.douyin.com/video/7311234567890123456', '牛顿第二定律 - 抖音', '一分钟讲透'),
      web('https://www.douyin.com/user/MS4wLjABAAAA', '某老师的主页'),
      web('https://www.douyin.com/search/%E7%89%9B%E9%A1%BF', '搜索页'),
      web('https://v.douyin.com/iRNBho6u/', '短链'),
      web('https://www.douyin.com/video/7311234567890123456?x=1', '重复'),
    ];
    expect(hitsFromWeb('douyin', results).map((h) => h.url)).toEqual(['https://www.douyin.com/video/7311234567890123456', 'https://v.douyin.com/iRNBho6u/']);
    expect(hitsFromWeb('douyin', results)[0]).toMatchObject({ route: 'douyin', title: '牛顿第二定律', snippet: '一分钟讲透' });

    const fetchImpl = vi.fn();
    const r = await searchVideoRoute('douyin', '牛顿第二定律', null, undefined, { search: async () => results, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.via).toBe('web');
    expect(r.hits).toHaveLength(2);
    expect(r.note).toContain('不许嵌播');

    const none = await searchVideoRoute('douyin', '没人拍的词', null, undefined, { search: async () => [web('https://zh.wikipedia.org/x')] });
    expect(none).toMatchObject({ via: 'none', hits: [], siteSearchUrl: 'https://www.douyin.com/search/%E6%B2%A1%E4%BA%BA%E6%8B%8D%E7%9A%84%E8%AF%8D?type=video' });
    expect(none.note).toContain('站内搜');
  });
});

describe('⑤ 缓存', () => {
  it('同线路同词（忽略大小写）命中缓存不再打接口；via:none 不缓存', async () => {
    const bili = fakeBili(() => jsonResponse(okJson([biliRow(0)])));
    await searchVideoRoute('bilibili', 'Newton', null, undefined, { fetchImpl: bili.fetchImpl });
    await searchVideoRoute('bilibili', 'newton', null, undefined, { fetchImpl: bili.fetchImpl });
    expect(bili.calls.search).toHaveLength(1);
    await searchVideoRoute('douyin', 'newton', null, undefined, { search: async () => [], fetchImpl: bili.fetchImpl });
    expect(bili.calls.search).toHaveLength(1);

    const emptyApi = fakeBili(() => jsonResponse(okJson([])));
    await searchVideoRoute('bilibili', 'nobody', null, undefined, { fetchImpl: emptyApi.fetchImpl });
    await searchVideoRoute('bilibili', 'nobody', null, undefined, { fetchImpl: emptyApi.fetchImpl });
    expect(emptyApi.calls.search).toHaveLength(2);
  });
});
