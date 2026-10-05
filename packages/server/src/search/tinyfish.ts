/** 免费 Search / Fetch 适配：有界超时、限流冷却、上游形状校验；不调用付费自动化。 */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { examUrlAllowed } from '@sb/shared';
import { combineSignals } from './combine.js';
import { assertSafeUrl, fetchSafe } from './ssrf-guard.js';
import { htmlToText } from './bing-channel.js';
import type { SearchResult } from './types.js';
import type { PageText } from './page-text.js';

type Bucket = { calls: number[]; until: number };
const buckets = new Map<string, Bucket>();
type Service = 'search' | 'fetch';

function budget(service: Service, key: string): Bucket {
  const id = `${service}:${createHash('sha256').update(key).digest('hex')}`;
  let b = buckets.get(id);
  if (!b) {
    if (buckets.size >= 256) buckets.delete(buckets.keys().next().value!);
    b = { calls: [], until: 0 };
    buckets.set(id, b);
  }
  const now = Date.now();
  b.calls = b.calls.filter((at) => now - at < 60_000);
  if (now < b.until || b.calls.length >= (service === 'search' ? 30 : 150)) {
    throw new Error('TinyFish 限流，稍后重试');
  }
  b.calls.push(now);
  return b;
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
const str = (v: unknown): string => typeof v === 'string' ? v : '';

async function request(service: Service, key: string, url: string, init: RequestInit): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    init.signal?.throwIfAborted();
    const b = budget(service, key);
    const res = await fetchSafe(url, { ...init, headers: { 'Content-Type': 'application/json', 'X-API-Key': key } }, 0);
    if (res.status === 429) {
      const raw = res.headers.get('retry-after') ?? '';
      const seconds = raw.trim() ? Number(raw) : NaN;
      const until = Number.isFinite(seconds) ? Date.now() + Math.max(1, seconds) * 1000 : Date.parse(raw);
      b.until = Number.isFinite(until) ? Math.max(Date.now() + 1000, until) : Date.now() + 60_000;
    }
    if (res.status === 503 && attempt === 0) {
      await delay(250, undefined, { signal: init.signal ?? undefined });
      continue;
    }
    if (!res.ok) throw new Error(`TinyFish ${service} HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('TinyFish 暂时不可用');
}

export async function tinyfishSearch(
  query: string, apiKey: string, signal?: AbortSignal, want = 6, allowHosts?: readonly string[],
): Promise<SearchResult[]> {
  if (allowHosts?.length === 0) return [];
  const url = new URL('https://api.search.tinyfish.ai');
  url.searchParams.set('query', query);
  if (/[\u3400-\u9fff]/u.test(query)) {
    url.searchParams.set('language', 'zh');
    url.searchParams.set('location', 'CN');
  }
  if (allowHosts?.length) {
    url.searchParams.set('include_domains', allowHosts.join(','));
    url.searchParams.set('purpose', '寻找与主题直接相关的学习资料与完整题目，优先可读取的正文页面');
  }
  const data = record(await request('search', apiKey, url.href, { signal: combineSignals(signal, 12_000) }));
  if (!Array.isArray(data?.results)) throw new Error('TinyFish search 返回格式异常');
  return data.results.flatMap((v) => {
    const r = record(v);
    const target = str(r?.url);
    try {
      const parsed = new URL(target);
      if (!examUrlAllowed(target, [parsed.hostname])) return [];
    } catch { return []; }
    return [{ title: str(r?.title), url: target, snippet: str(r?.snippet).slice(0, 500), source: 'tinyfish' }];
  }).slice(0, want);
}

export async function tinyfishPage(
  url: string, key: string, opts: { signal?: AbortSignal; timeoutMs?: number; allowHosts?: readonly string[] },
): Promise<PageText> {
  const target = await assertSafeUrl(url);
  if (opts.allowHosts !== undefined && !examUrlAllowed(target.href, opts.allowHosts)) throw new Error('该地址不在所选应试范围内');
  const signal = combineSignals(opts.signal, opts.timeoutMs ?? 6000);
  const data = record(await request('fetch', key, 'https://api.fetch.tinyfish.ai', {
    method: 'POST', signal,
    body: JSON.stringify({ urls: [url], format: 'html', links: true, image_links: true, ttl: 0,
      per_url_timeout_ms: Math.min(110_000, Math.max(1, opts.timeoutMs ?? 6000)) }),
  }));
  if (!Array.isArray(data?.results)) throw new Error('TinyFish fetch 返回格式异常');
  const r = data.results.map(record).find((v) => v?.url === url);
  const final = str(r?.final_url);
  if (!final) throw new Error('TinyFish fetch 缺少最终地址');
  if (opts.allowHosts !== undefined && !examUrlAllowed(final, opts.allowHosts)) throw new Error('该地址不在所选应试范围内');
  await assertSafeUrl(final);
  const html = str(r?.text).slice(0, 1_000_000);
  const text = htmlToText(html);
  if (!text) throw new Error('TinyFish fetch 无正文');
  return { ok: true, html, text, title: str(r?.title).slice(0, 120) };
}
