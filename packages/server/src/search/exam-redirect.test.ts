/** 使用实际 fetchPageText/fetchSafe 链，验证重定向不会把白名单请求带出范围。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
const { fetchPageText } = await import('./page-text.js');
const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    if (String(url).endsWith('/outside')) return new Response('', { status: 302, headers: { location: 'https://outside.example/page' } });
    if (String(url).endsWith('/inside')) return new Response('', { status: 302, headers: { location: 'https://sub.study.example/page' } });
    return new Response('<html><main>Java 的线程池控制并发。</main></html>', { headers: { 'content-type': 'text/html' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('应试抓页的逐跳范围闸', () => {
  it('范围外重定向在发第二个请求之前拦住', async () => {
    const r = await fetchPageText('https://study.example/outside', { allowHosts: ['study.example'] });
    expect(r).toMatchObject({ ok: false, kind: 'fetch', reason: '该地址不在所选应试范围内' });
    expect(calls).toEqual(['https://study.example/outside']);
  });
  it('同范围子域重定向可以正常读取', async () => {
    const r = await fetchPageText('https://study.example/inside', { allowHosts: ['study.example'] });
    expect(r).toMatchObject({ ok: true, text: 'Java 的线程池控制并发。' });
    expect(calls).toHaveLength(2);
  });
  it('首个 URL 在范围外或范围空时零 HTTP 请求', async () => {
    expect((await fetchPageText('https://outside.example/page', { allowHosts: ['study.example'] })).ok).toBe(false);
    expect((await fetchPageText('https://study.example/page', { allowHosts: [] })).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
