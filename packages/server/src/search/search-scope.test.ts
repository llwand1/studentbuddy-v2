/**
 * 白名单在聚合入口的强制效果（EXAM-1004 的 P0 锁）。全程 mock DNS/fetch，零真实网络。
 *
 * 这一组用例守的是两件事，漏一件整个「应试模式」就是假承诺：
 *  ① 范围外的命中**一条都不许返回**；
 *  ② `search_cache` 键必须带范围签名——窄范围的结果不能被宽范围复用，
 *     反过来更危险：开着模式却端出上一次关着时的全站结果。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-scope-test-'));

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

const { getDb } = await import('../storage/db.js');
const { searchWeb, saveProviderKey } = await import('./index.js');

const RSS = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0"><channel><title>必应</title>
<item><title>2024 高考数学真题及答案解析</title><link>https://baike.example/zhenti</link><description>真题</description></item>
<item><title>某公司年报</title><link>https://news.example/a</link><description>新闻</description></item>
<item><title>教习网中考物理真题</title><link>https://www.51jiaoxi.com/zhongkao/zhenti/wl/</link><description>卷</description></item>
</channel></rss>`;

const calls: string[] = [];
const bodies: string[] = [];
function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: { body?: string }) => {
      const url = String(input);
      calls.push(url);
      if (init?.body) bodies.push(String(init.body));
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => 'application/xml' },
        json: async () => ({ results: [] }),
        text: async () => RSS,
      } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  bodies.length = 0;
  getDb().prepare('DELETE FROM search_cache').run();
  getDb().prepare('DELETE FROM app_settings').run();
  for (const k of ['EXA_API_KEY', 'TAVILY_API_KEY', 'ZHIPU_API_KEY']) delete process.env[k];
  mockFetch();
});

afterEach(() => vi.unstubAllGlobals());

const HOSTS = ['baike.example', '51jiaoxi.com'];

describe('searchWeb 的白名单后置过滤', () => {
  it('带范围 ⇒ 只回范围内的条目，dropped 报出被滤掉的条数', async () => {
    const r = await searchWeb('q-scope', null, { allowHosts: HOSTS });
    expect(r.results.map((x) => x.url)).toEqual(['https://baike.example/zhenti', 'https://www.51jiaoxi.com/zhongkao/zhenti/wl/']);
    expect(r.dropped).toBe(1);
  });

  it('★ 不传 allowHosts ⇒ 一条不滤、dropped=0（关闭模式时行为与今天逐字一致）', async () => {
    const r = await searchWeb('q-off', null);
    expect(r.results).toHaveLength(3);
    expect(r.dropped).toBe(0);
  });

  it('★ 空白名单＝全拦（不是「不设界」）', async () => {
    const r = await searchWeb('q-none', null, { allowHosts: [] });
    expect(r.results).toEqual([]);
    expect(r.dropped).toBe(3);
  });

  it('范围只放一个域 ⇒ 其余全滤，dropped 如实计数', async () => {
    const r = await searchWeb('q-one', null, { allowHosts: ['51jiaoxi.com'] });
    expect(r.results.map((x) => x.url)).toEqual(['https://www.51jiaoxi.com/zhongkao/zhenti/wl/']);
    expect(r.dropped).toBe(2);
  });

  it('子域算范围内；单段名的登记项直接作废（不许误当通配）', async () => {
    const sub = await searchWeb('q-sub', null, { allowHosts: ['baike.example', 'news.example'] });
    expect(sub.results.map((x) => x.title)).toEqual(['2024 高考数学真题及答案解析', '某公司年报']);
    expect(sub.dropped).toBe(1); // 51jiaoxi.com 不在范围内
    // 'example' 这种没有点分尾缀的写法不是合法登记域 ⇒ 归一化判 null ⇒ 整条丢弃，绝不退化成「匹配所有 *.example」
    const bogus = await searchWeb('q-bogus', null, { allowHosts: ['example'], skipCache: true });
    expect(bogus.results).toEqual([]);
    expect(bogus.dropped).toBe(3);
  });
});

describe('缓存键必须含范围签名', () => {
  it('同一查询换范围 ⇒ 必须重新发请求，不许复用上一次的结果集', async () => {
    await searchWeb('q-cache', null, { allowHosts: HOSTS });
    expect(calls.length).toBe(1);
    await searchWeb('q-cache', null, { allowHosts: ['baike.example'] });
    expect(calls.length).toBe(2); // 范围变了 ⇒ 缓存没命中
    const again = await searchWeb('q-cache', null, { allowHosts: ['baike.example'] });
    expect(again.providers).toEqual(['cache']);
    expect(again.results).toHaveLength(1);
  });

  it('★ 先宽后窄不许把宽范围的结果集端给窄范围（最容易「看起来没事」的一条）', async () => {
    const wide = await searchWeb('q-wide', null, { allowHosts: HOSTS }); // baike.example + 51jiaoxi.com
    expect(wide.results).toHaveLength(2); // 已按这份范围落缓存
    const narrow = await searchWeb('q-wide', null, { allowHosts: ['baike.example'] });
    expect(narrow.providers).not.toEqual(['cache']); // 范围变了 ⇒ 必须重发请求，不能吃宽范围那份
    expect(narrow.results.map((x) => x.url)).toEqual(['https://baike.example/zhenti']);
  });

  it('缓存里存的是过滤后的条目：命中缓存时不再重复计数 dropped', async () => {
    await searchWeb('q-c', null, { allowHosts: HOSTS });
    const hit = await searchWeb('q-c', null, { allowHosts: HOSTS });
    expect(hit.providers).toEqual(['cache']);
    expect(hit.dropped).toBe(0);
    expect(hit.results).toHaveLength(2);
  });
});

describe('带范围时放宽每家的取回量', () => {
  it('Exa：allowHosts 在场 → numResults 10；不在场 → 6（前 10 条带 contents 不计费的口径上限）', async () => {
    saveProviderKey('exa', 'k-exa', null);
    await searchWeb('q-exa-off', null);
    await searchWeb('q-exa-on', null, { allowHosts: HOSTS });
    const json = bodies.map((b) => JSON.parse(b) as { numResults?: number });
    expect(json[0]?.numResults).toBe(6);
    expect(json[1]?.numResults).toBe(10);
  });
});
