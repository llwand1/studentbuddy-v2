/**
 * search/bing-channel 回归：免 key 兜底通道的**形状契约**。
 *
 * 2026-09-25 随 B-019（issue #11）立档：通道从 `index.ts` 拆到本文件后，主机名与
 * 「形状不符要说话」这两条锁跟着实现搬过来，`search.test.ts` 继续锁聚合面
 * （provider 选择、缓存键、去重）——两层互不替对方作证。
 * 全程 mock `fetchSafe`，不碰真实网络；真机连通性归 `tools/probes/bing-channel-live.mjs`。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Fake = { text?: string; status?: number; url?: string };

// ★ 必须经 `vi.hoisted`：mock 工厂会被提到 import 之前求值，直接引用后声明的 `let`
//   会踩 TDZ（`Cannot access 'st' before initialization`）。
const st = vi.hoisted(() => ({
  calls: [] as string[],
  handler: ((_: string): Fake => ({ text: '' })) as (url: string, signal?: AbortSignal | null) => Fake,
}));

vi.mock('./ssrf-guard.js', () => ({
  fetchSafe: async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    st.calls.push(url);
    const r = st.handler(url, init?.signal);
    const status = r.status ?? 200;
    return {
      ok: status < 400,
      status,
      url: r.url ?? url, // 真实 fetch 把最终地址挂在 Response.url 上（形状异常时靠它报「落在哪」）
      headers: { get: () => null },
      text: async () => r.text ?? '',
    } as unknown as Response;
  },
}));

const { bingSearch } = await import('./bing-channel.js');

function mockChannel(h: (url: string, signal?: AbortSignal | null) => Fake): void {
  st.handler = h;
}

const BING_RSS = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0"><channel><title>必应：牛顿第二定律</title>
<item><title>牛顿第二定律_百度百科</title><link>https://baike.example/newton</link><description>F 等于 ma，动量 p=mv</description></item>
<item><title>动量守恒定律</title><link>https://other.example?a=1&amp;b=2</link><description>p=mv</description></item>
</channel></rss>`;

const BING_HTML = `<ol id="b_results">
<li class="b_algo" data-id iid=SERP.5336><h2 class=""><a target="_blank" href="https://baike.example/newton" h="ID=SERP,5128.2"><strong>牛顿第二</strong>运动<strong>定律</strong>_百度百科</a></h2><div class="b_caption"><p class="b_lineclamp2" data-rslinkclamp-iid="">F 等于 ma</p></div></li>
<li class="b_algo" data-id iid=SERP.5337><h2 class=""><a target="_blank" href="https://other.example/q" h="ID=SERP,5144.2">动量守恒</a></h2><div class="b_caption"><p class="b_lineclamp2">p=mv</p></div></li>
<li class="b_pag"></li></ol>`;

beforeEach(() => {
  st.calls.length = 0;
});

describe('bing 免 key 通道', () => {
  it('打的是 www.bing.com/search，不再经 cn.bing.com', async () => {
    // ★ 这条锁的是**主机名**这个事实。cn.bing.com/search 的 301 现丢掉 /search 路径
    //   （生产机实测：跟随后落到 `www.bing.com/?q=…` 首页）⇒ 两通道恒 0 条。
    //   mock 层证不了真机连通性，两侧各管一段：本文件锁常量，探针锁出口 IP 上的实际形状。
    mockChannel((url) => (url.includes('format=rss') ? { text: BING_RSS } : { text: BING_HTML }));
    const r = await bingSearch('今天新闻');
    expect(st.calls).toHaveLength(1); // RSS 主通道一次成功，不该有多余请求
    expect(st.calls[0]).toMatch(/^https:\/\/www\.bing\.com\/search\?q=%E4%BB%8A%E5%A4%A9%E6%96%B0%E9%97%BB&format=rss$/);
    expect(r.map((x) => x.title)).toEqual(['牛顿第二定律_百度百科', '动量守恒定律']);
    expect(r[1]?.url).toBe('https://other.example?a=1&b=2'); // &amp; 实体还原
  });

  it('RSS 端点返回 HTML 页面 → 报「不是 RSS」并写明落在哪，不许冒「空结果」', async () => {
    // 现场形状＝线上拿到的那种 200 + 15KB 首页（`<!doctype html>` 开头、零 <item>）。
    mockChannel(() => ({
      text: '<!doctype html><html lang="zh"><head><title>必应</title></head><body>热点榜单</body></html>',
      url: 'https://www.bing.com/?q=shape-rss&format=rss&mkt=zh-CN',
    }));
    await expect(bingSearch('shape-rss')).rejects.toThrow(/rss: Bing RSS 返回的不是 RSS/);
    await expect(bingSearch('shape-rss')).rejects.toThrow(/最终落在 www\.bing\.com\//);
    await expect(bingSearch('shape-rss')).rejects.not.toThrow(/rss: 空结果/);
  });

  it('HTML 通道拿到无结果区的页面 → 报「无结果区」，形状异常不被降级吞掉', async () => {
    mockChannel((url) =>
      url.includes('format=rss')
        ? { status: 599 }
        : {
            text: '<!doctype html><html><body><div id="sb_form">搜索框</div></body></html>',
            url: 'https://www.bing.com/?q=shape-html',
          },
    );
    const msg = await bingSearch('shape-html').catch((e: unknown) => String(e));
    expect(msg).toContain('html: Bing HTML 页面无结果区');
    expect(msg).toContain('最终落在 www.bing.com/');
    expect(msg).toContain('rss: Bing RSS 599'); // 逐路冒泡的既有口径不丢
  });

  it('RSS 形状正常但零条目＝真·查无结果 → 静默降级到 HTML，不报失败', async () => {
    const emptyRss = '<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>Bing: 无此词</title></channel></rss>';
    mockChannel((url) => (url.includes('format=rss') ? { text: emptyRss } : { text: BING_HTML }));
    const r = await bingSearch('true-empty');
    expect(r).toHaveLength(2);
    expect(new Set(r.map((x) => x.source))).toEqual(new Set(['bing-html']));
  });

  it('RSS 有 <item> 但缺 <link> → 按真·空处理，不谎报形状异常', async () => {
    const noLink = '<?xml version="1.0"?><rss version="2.0"><channel><item><title>只有标题</title></item></channel></rss>';
    mockChannel((url) => (url.includes('format=rss') ? { text: noLink } : { text: BING_HTML }));
    const r = await bingSearch('no-link');
    expect(r[0]?.source).toBe('bing-html');
  });

  it('RSS 挂了 → HTML 兜底接管（拆文件前后同口径）', async () => {
    mockChannel((url) => (url.includes('format=rss') ? { status: 599 } : { text: BING_HTML }));
    const r = await bingSearch('html-fallback');
    expect(r[0]?.title).toBe('牛顿第二运动定律_百度百科');
    expect(r[0]?.source).toBe('bing-html');
  });
});
