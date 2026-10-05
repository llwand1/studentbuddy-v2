import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
const { tinyfishSearch, tinyfishPage } = await import('./tinyfish.js');
let serial = 0;
const key = () => `test-key-${++serial}`;
const hit = { title: 'Java 线程池', url: 'https://javaguide.cn/java/thread-pool', snippet: '线程池拒绝策略' };
function respond(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers });
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('TinyFish 免费通道', () => {
  it('真实 Search 契约：GET、中文地区、原生域过滤；密钥只在 header', async () => {
    const token = key();
    const fetch = vi.fn(async () => respond({ results: [hit] }));
    vi.stubGlobal('fetch', fetch);
    const results = await tinyfishSearch('Java 线程池', token, undefined, 10, ['javaguide.cn', 'nowcoder.com']);
    const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(target.origin).toBe('https://api.search.tinyfish.ai');
    expect(target.searchParams.get('query')).toBe('Java 线程池');
    expect(target.searchParams.get('include_domains')).toBe('javaguide.cn,nowcoder.com');
    expect(target.searchParams.get('language')).toBe('zh');
    expect(target.searchParams.get('location')).toBe('CN');
    expect(target.href).not.toContain(token);
    expect(init.headers).toHaveProperty('X-API-Key', token);
    expect(results).toEqual([{ ...hit, source: 'tinyfish' }]);
  });

  it('空范围不出网；坏 URL 与非 HTTP 结果不进入模型上下文', async () => {
    const fetch = vi.fn(async () => respond({ results: [null, { url: '坏网址' }, { url: 'javascript:alert(1)' }, hit] }));
    vi.stubGlobal('fetch', fetch);
    expect(await tinyfishSearch('x', key(), undefined, 10, [])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await tinyfishSearch('x', key())).toHaveLength(1);
  });

  it('上游格式异常和权限错误显式失败，不泄露响应体', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ error: 'sensitive-upstream-body' }, 402)));
    await expect(tinyfishSearch('x', key())).rejects.toThrow('TinyFish search HTTP 402');
    vi.stubGlobal('fetch', vi.fn(async () => respond({ results: {} })));
    await expect(tinyfishSearch('x', key())).rejects.toThrow('返回格式异常');
  });

  it('429 按 Retry-After 冷却，同 key 不继续发请求，其它 key 可用', async () => {
    const token = key();
    const fetch = vi.fn(async () => respond({}, 429, { 'Retry-After': '60' }));
    vi.stubGlobal('fetch', fetch);
    await expect(tinyfishSearch('x', token)).rejects.toThrow('429');
    await expect(tinyfishSearch('x2', token)).rejects.toThrow('限流');
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(respond({ results: [hit] }));
    expect(await tinyfishSearch('x', key())).toHaveLength(1);
  });

  it('单 key 每分钟搜索上限 30；新窗口恢复', async () => {
    const token = key();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi.fn(async () => respond({ results: [] }));
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 30; i++) await tinyfishSearch('x', token);
    await expect(tinyfishSearch('x', token)).rejects.toThrow('限流');
    expect(fetch).toHaveBeenCalledTimes(30);
    now += 60_001;
    await tinyfishSearch('x', token);
    expect(fetch).toHaveBeenCalledTimes(31);
  });

  it('503 至多重试一次，重试成功才返回；已取消不出网', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(respond({}, 503)).mockResolvedValue(respond({ results: [hit] }));
    vi.stubGlobal('fetch', fetch);
    expect(await tinyfishSearch('x', key())).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    const cancelled = AbortSignal.abort();
    await expect(tinyfishSearch('x', key(), cancelled)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('Fetch 使用现场 HTML；最终 URL 在范围内且正文保持原文', async () => {
    const fetch = vi.fn(async () => respond({ results: [{ url: hit.url, final_url: hit.url, title: hit.title,
      text: '<main><p>Java 线程池拒绝策略有哪些？</p><p>答案：AbortPolicy。</p></main>' }] }));
    vi.stubGlobal('fetch', fetch);
    const page = await tinyfishPage(hit.url, key(), { allowHosts: ['javaguide.cn'], timeoutMs: 3000 });
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ urls: [hit.url], ttl: 0, format: 'html', per_url_timeout_ms: 3000 });
    expect(page.text).toContain('答案：AbortPolicy');
    expect(page.html).toContain('<p>');
  });

  it('范围外输入不发送；缺 final_url、范围外重定向或内网最终地址不采信', async () => {
    const fetch = vi.fn(async () => respond({ results: [{ url: hit.url, final_url: 'https://outside.example', text: '题干' }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(tinyfishPage('https://outside.example', key(), { allowHosts: ['javaguide.cn'] })).rejects.toThrow('范围');
    expect(fetch).not.toHaveBeenCalled();
    await expect(tinyfishPage(hit.url, key(), { allowHosts: ['javaguide.cn'] })).rejects.toThrow('范围');
    fetch.mockResolvedValue(respond({ results: [{ url: hit.url, text: '题干' }] }));
    await expect(tinyfishPage(hit.url, key(), {})).rejects.toThrow('最终地址');
    fetch.mockResolvedValue(respond({ results: [{ url: hit.url, final_url: 'http://127.0.0.1', text: '题干' }] }));
    await expect(tinyfishPage(hit.url, key(), {})).rejects.toThrow('SSRF');
  });
});
