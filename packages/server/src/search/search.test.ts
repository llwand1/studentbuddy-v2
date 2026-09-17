/**
 * search 聚合回归：免 key 兜底、有 key 走托管、失败跳过、URL 去重、24h 缓存、key 密文存储。
 * 全程 mock DNS/fetch，不碰真实网络（真机连通性由设置页自检与 M1 真模型验证覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-search-test-'));

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

const { getDb } = await import('../storage/db.js');
const { searchWeb, resultsToContext, saveProviderKey, getProviderKey, listKeyStatus } = await import('./index.js');

type Fake = { json?: unknown; text?: string; status?: number };
const calls: string[] = [];
function mockFetch(handler: (url: string) => Fake) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const r = handler(url);
      const status = r.status ?? 200;
      return {
        ok: status < 400,
        status,
        headers: { get: () => null },
        json: async () => r.json ?? {},
        text: async () => r.text ?? '',
      } as unknown as Response;
    }),
  );
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
  calls.length = 0;
  getDb().prepare('DELETE FROM search_cache').run();
  getDb().prepare('DELETE FROM app_settings').run();
  for (const k of ['EXA_API_KEY', 'TAVILY_API_KEY', 'ZHIPU_API_KEY']) delete process.env[k];
});

afterEach(() => vi.unstubAllGlobals());

describe('search 聚合', () => {
  it('三家都没 key → 走 Bing 免费通道兜底（RSS 主通道）', async () => {
    mockFetch((url) => (url.includes('format=rss') ? { text: BING_RSS } : { text: BING_HTML }));
    const r = await searchWeb('bing-nokey');
    expect(r.providers).toEqual(['bing']);
    expect(r.results.map((x) => x.title)).toEqual(['牛顿第二定律_百度百科', '动量守恒定律']);
    expect(r.results[1]?.url).toBe('https://other.example?a=1&b=2'); // &amp; 实体还原
  });

  it('RSS 挂了 → HTML 兜底，结果按 source 标注实际路由', async () => {
    mockFetch((url) => (url.includes('format=rss') ? { status: 599 } : { text: BING_HTML }));
    const r = await searchWeb('bing-fallback');
    expect(r.results[0]?.title).toBe('牛顿第二运动定律_百度百科');
    expect(r.results[0]?.source).toBe('bing-html'); // HTML 兜底路由
    expect(calls.some((u) => u.includes('format=rss'))).toBe(true);
    expect(r.failed).toEqual([]); // 单路软降级不算失败，双路全挂才报
  });

  it('RSS 与 HTML 双路都挂 → 失败原因不静默，逐路冒泡', async () => {
    mockFetch((url) => (url.includes('format=rss') ? { status: 599 } : { status: 500 }));
    const r = await searchWeb('bing-dead');
    expect(r.results).toEqual([]);
    expect(r.failed.join()).toContain('rss: Bing RSS 599');
    expect(r.failed.join()).toContain('html: Bing HTML 500');
  });

  it('配了 Exa key → 只发 Exa 请求并解析结果', async () => {
    process.env.EXA_API_KEY = 'env-exa';
    mockFetch(() => ({ json: { results: [{ title: 'T', url: 'https://exa.example/1', text: '正文' }] } }));
    const r = await searchWeb('exa-only');
    expect(calls).toEqual(['https://api.exa.ai/search']);
    expect(r.results[0]?.snippet).toBe('正文');
    expect(r.providers).toEqual(['exa']);
  });

  it('一家失败只跳过，成功结果照常返回；跨家 URL 去重', async () => {
    process.env.EXA_API_KEY = 'env-exa';
    process.env.TAVILY_API_KEY = 'env-tavily';
    mockFetch((url) =>
      url.includes('tavily')
        ? { status: 432 }
        : { json: { results: [{ title: 'A', url: 'https://same.example/x', text: 'a' }, { title: 'B', url: 'https://same.example/x', text: 'b' }] } },
    );
    const r = await searchWeb('dedupe');
    expect(r.results).toHaveLength(1); // 同 URL 去重
    expect(r.results[0]?.url).toBe('https://same.example/x');
    expect(r.failed.join()).toContain('tavily');
    expect(r.providers).toEqual(['exa']); // 失败的那家不许冒充来源
  });

  it('同查询 24h 内命中缓存，不再发起外部请求', async () => {
    mockFetch(() => ({ text: BING_RSS }));
    const first = await searchWeb('cached-q');
    const n = calls.length;
    const second = await searchWeb('cached-q');
    expect(n).toBeGreaterThan(0);
    expect(calls.length).toBe(n);
    expect(second.providers).toEqual(['cache']);
    expect(second.results).toHaveLength(first.results.length);
  });

  it('缓存按 provider 组合隔离：配了 key 不再吃免 key 时期的旧缓存', async () => {
    mockFetch(() => ({ text: BING_RSS }));
    expect((await searchWeb('sig-q')).providers).toEqual(['bing']);

    process.env.EXA_API_KEY = 'env-exa';
    mockFetch(() => ({ json: { results: [{ title: 'E', url: 'https://exa.example/e', text: 'ee' }] } }));
    const after = await searchWeb('sig-q');
    expect(after.providers).toEqual(['exa']);
    expect(after.results[0]?.url).toBe('https://exa.example/e');
  });

  it('skipCache 强制真发（连通自检不能被缓存冒充）', async () => {
    mockFetch(() => ({ text: BING_RSS }));
    await searchWeb('live-q');
    const n = calls.length;
    await searchWeb('live-q', { skipCache: true });
    expect(calls.length).toBeGreaterThan(n);
  });

  it('settings 存的 key 密文落库，读取时解密；空串即删除', async () => {
    saveProviderKey('zhipu', 'secret-zp');
    const row = getDb().prepare("SELECT value FROM app_settings WHERE key = 'search_key_zhipu'").get() as { value: string };
    expect(row.value.startsWith('enc:v1:')).toBe(true);
    expect(row.value).not.toContain('secret-zp');
    expect(getProviderKey('zhipu')).toBe('secret-zp');
    expect(listKeyStatus().zhipu).toBe(true);

    saveProviderKey('zhipu', '');
    expect(listKeyStatus().zhipu).toBe(false);
  });

  it('resultsToContext 带来源编号与 URL（供模型引用溯源）', () => {
    const text = resultsToContext([
      { title: 'A', url: 'https://a.example', snippet: 'sa', source: 'exa' },
      { title: 'B', url: 'https://b.example', snippet: '', source: 'exa' },
    ]);
    expect(text).toContain('[1] A\nhttps://a.example\nsa');
    expect(text).toContain('[2] B');
  });
});
