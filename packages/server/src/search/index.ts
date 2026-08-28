/**
 * search/index — 联网搜索聚合（学环核心件）。
 * Provider 矩阵（规划 §1.5.6 实测换血）：Exa 主 + Tavily 备 + 智谱国产兜底，
 * 三家全无 key 时退回 DuckDuckGo 免费通道（port from v1：instant + lite 双通道）；
 * 并行聚合、单家失败跳过、URL 去重；search_cache 单表 TTL（强化包 S2）。
 * key 优先取环境变量，其次 app_settings（密文，见 storage/crypto）。
 */
import { getDb } from '../storage/db.js';
import { encryptSecret, decryptSecret } from '../storage/crypto.js';
import { fetchSafe } from './ssrf-guard.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 提供方标识（结果呈现溯源） */
  source: string;
}

/** 需要 key 的托管服务商（ddg 免 key，故不在此列） */
export const KEYED_PROVIDERS = ['exa', 'tavily', 'zhipu'] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

export interface SearchProviderConfig {
  type: KeyedProvider | 'duckduckgo';
  apiKey?: string;
  priority: number;
}

function keyFromEnv(type: string): string {
  const env: Record<string, string | undefined> = {
    exa: process.env.EXA_API_KEY,
    tavily: process.env.TAVILY_API_KEY,
    zhipu: process.env.ZHIPU_API_KEY,
  };
  return env[type] ?? '';
}

function keyFromSettings(type: string): string {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(`search_key_${type}`) as
    | { value: string }
    | undefined;
  return row?.value ? decryptSecret(row.value) : '';
}

export function getProviderKey(type: string): string {
  return keyFromEnv(type) || keyFromSettings(type);
}

/** 三家 key 的配置状态（只回布尔，明文/密文都不出响应）。 */
export function listKeyStatus(): Record<KeyedProvider, boolean> {
  const out = {} as Record<KeyedProvider, boolean>;
  for (const p of KEYED_PROVIDERS) out[p] = getProviderKey(p).length > 0;
  return out;
}

/** 存 key：非空加密落库；空串=删除该 key（环境变量仍可用）。 */
export function saveProviderKey(type: KeyedProvider, plain: string): void {
  const db = getDb();
  if (!plain) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(`search_key_${type}`);
    return;
  }
  db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(`search_key_${type}`, encryptSecret(plain));
}

// ── 三家实现（各 ~20 行独立函数，简单组合原则）──

async function exaSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetchSafe('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query, numResults: 6, type: 'auto' }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
  return (data.results ?? []).slice(0, 6).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.text ?? '').slice(0, 500),
    source: 'exa',
  }));
}

async function tavilySearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetchSafe('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 6, search_depth: 'basic' }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).slice(0, 6).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: (r.content ?? '').slice(0, 500),
    source: 'tavily',
  }));
}

/** 智谱 web-search-pro（国产兜底：字段名接入前以实测为准，失败自动跳过不阻塞降级链） */
async function zhipuSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetchSafe('https://open.bigmodel.cn/api/paas/v4/web_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count: 6 }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Zhipu ${res.status}`);
  const data = (await res.json()) as {
    search_result?: Array<{ title?: string; link?: string; content?: string; url?: string }>;
  };
  const list = data.search_result ?? [];
  return list.slice(0, 6).map((r) => ({
    title: r.title ?? '',
    url: r.link ?? r.url ?? '',
    snippet: (r.content ?? '').slice(0, 500),
    source: 'zhipu',
  }));
}

const IMPL: Record<string, (q: string, key: string) => Promise<SearchResult[]>> = {
  exa: exaSearch,
  tavily: tavilySearch,
  zhipu: zhipuSearch,
  duckduckgo: (q) => duckduckgoSearch(q),
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── DuckDuckGo 免费通道（无 key 兜底；port from v1 core/search 双通道）──
const DDG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) studentbuddy/2.0';

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeUrl(raw: string): string {
  return raw.replace(/&amp;/g, '&');
}

/** lite 版 HTML 抓真实网页结果（结果面比 instant API 宽）。 */
async function ddgLite(query: string): Promise<SearchResult[]> {
  const res = await fetchSafe(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': DDG_UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo Lite ${res.status}`);
  const html = await res.text();
  const links = [...html.matchAll(/<a[^>]+href="([^"]*)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi)];
  return links
    .slice(0, 6)
    .map((m, i) => ({
      title: htmlToText(m[2] ?? ''),
      url: decodeUrl(m[1] ?? ''),
      snippet: htmlToText(snippets[i]?.[1] ?? '').slice(0, 500),
      source: 'duckduckgo-lite',
    }))
    .filter((r) => r.url.startsWith('http'));
}

/** instant API：结构化摘要，lite 挂了时的兜底（百科类词条命中率高）。 */
async function ddgInstant(query: string): Promise<SearchResult[]> {
  const res = await fetchSafe(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
    { headers: { 'User-Agent': DDG_UA }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const data = (await res.json()) as {
    Headline?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };
  const out: SearchResult[] = [];
  if (data.AbstractText) {
    out.push({ title: data.Headline || 'Abstract', url: data.AbstractURL ?? '', snippet: data.AbstractText, source: 'duckduckgo' });
  }
  for (const t of data.RelatedTopics ?? []) {
    if (t.Text && t.FirstURL) out.push({ title: t.FirstURL, url: t.FirstURL, snippet: t.Text, source: 'duckduckgo' });
    for (const s of t.Topics ?? []) {
      if (s.Text && s.FirstURL) out.push({ title: s.FirstURL, url: s.FirstURL, snippet: s.Text, source: 'duckduckgo' });
    }
  }
  return out.filter((r) => r.url.startsWith('http')).slice(0, 6);
}

async function duckduckgoSearch(query: string): Promise<SearchResult[]> {
  const failed: string[] = [];
  for (const [name, run] of [
    ['lite', ddgLite],
    ['instant', ddgInstant],
  ] as const) {
    try {
      const results = await run(query);
      if (results.length > 0) return results;
      failed.push(`${name}: 空结果`);
    } catch (err) {
      failed.push(`${name}: ${errText(err)}`);
    }
  }
  throw new Error(failed.join('; ') || '无结果');
}

// ── 缓存（强化包 S2：24h TTL 懒删除）──
function cacheGet(key: string): SearchResult[] | null {
  const row = getDb().prepare('SELECT payload, expires_at FROM search_cache WHERE key = ?').get(key) as
    | { payload: string; expires_at: number }
    | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    getDb().prepare('DELETE FROM search_cache WHERE key = ?').run(key);
    return null;
  }
  return JSON.parse(row.payload) as SearchResult[];
}

function cacheSet(key: string, results: SearchResult[]): void {
  getDb()
    .prepare(
      'INSERT INTO search_cache (key, payload, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at',
    )
    .run(key, JSON.stringify(results), Date.now() + 24 * 3600_000);
}

/** 聚合入口：并行发起有 key 的 provider，失败跳过，URL 去重合并。 */
export async function searchWeb(
  query: string,
  opts: { skipCache?: boolean } = {},
): Promise<{ results: SearchResult[]; providers: string[]; failed: string[] }> {
  const keyed = (
    [
      { type: 'exa', priority: 1 },
      { type: 'tavily', priority: 2 },
      { type: 'zhipu', priority: 3 },
    ] as SearchProviderConfig[]
  ).filter((p) => getProviderKey(p.type));

  // 三家全无 key → 免费通道兜底（v1 兼容语义：绝不让搜索整条路走死）
  const active: SearchProviderConfig[] = keyed.length > 0 ? keyed : [{ type: 'duckduckgo', priority: 4 }];

  // 缓存键含 provider 组合签名：配 key 前拿到的兜底结果，不能在建 key 后继续被端出 24h
  const cacheKey = `q:${active.map((p) => p.type).join('+')}|${query}`;
  const cached = opts.skipCache ? null : cacheGet(cacheKey);
  if (cached) return { results: cached, providers: ['cache'], failed: [] };

  const settled = await Promise.allSettled(active.map((p) => IMPL[p.type]!(query, getProviderKey(p.type))));
  const failed: string[] = [];
  const byUrl = new Map<string, SearchResult>();
  const used: string[] = [];
  settled.forEach((r, i) => {
    const p = active[i]!;
    if (r.status === 'fulfilled') {
      if (r.value.length > 0) used.push(p.type); // 只报真正产出结果的来源
      for (const item of r.value) {
        if (item.url && !byUrl.has(item.url)) byUrl.set(item.url, item);
      }
    } else {
      failed.push(`${p.type}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
  const results = [...byUrl.values()];
  if (results.length > 0) cacheSet(cacheKey, results);
  return { results, providers: used, failed };
}

/** 搜索结果 → LLM 工具结果文本（带来源标注，Perplexity 式可信感） */
export function resultsToContext(results: SearchResult[]): string {
  if (results.length === 0) return '（搜索无结果）';
  return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
}
