/**
 * search/index — 联网搜索聚合（学环核心件）。
 * Provider 矩阵（规划 §1.5.6 实测换血）：Exa 主 + Tavily 备 + 智谱国产兜底，
 * 三家全无 key 时退回 Bing 免费通道（2026-09-17 换血：DDG 在本机网络完全不可用，
 * 改用 cn.bing.com，RSS 主 + HTML 兜底双通道）；
 * 并行聚合、单家失败跳过、URL 去重；search_cache 单表 TTL（强化包 S2）。
 * key 优先取环境变量，其次 app_settings（密文，见 storage/crypto）。
 */
import { getDb } from '../storage/db.js';
import { encryptSecret, decryptSecret } from '../storage/crypto.js';
import { fetchSafe } from './ssrf-guard.js';
import { publishEvent } from '../events/bus.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** 提供方标识（结果呈现溯源） */
  source: string;
}

/** 需要 key 的托管服务商（bing 免 key，故不在此列） */
export const KEYED_PROVIDERS = ['exa', 'tavily', 'zhipu'] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

export interface SearchProviderConfig {
  type: KeyedProvider | 'bing';
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

async function exaSearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetchSafe('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query, numResults: 6, type: 'auto' }),
    signal: combineSignals(signal, 12_000),
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

async function tavilySearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetchSafe('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: 6, search_depth: 'basic' }),
    signal: combineSignals(signal, 12_000),
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
async function zhipuSearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetchSafe('https://open.bigmodel.cn/api/paas/v4/web_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, count: 6 }),
    signal: combineSignals(signal, 12_000),
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

const IMPL: Record<string, (q: string, key: string, signal?: AbortSignal) => Promise<SearchResult[]>> = {
  exa: exaSearch,
  tavily: tavilySearch,
  zhipu: zhipuSearch,
  bing: (q, _key, signal) => bingSearch(q, signal),
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 外部取消信号与单请求超时合并：用户「停止生成」要能真正掐断搜索的 HTTP 请求，
 * 而不只是让结果被上层丢弃（v13 体验升级：signal 透传进工具内部）。
 * AbortSignal.any 不可用时退化为仅超时（老 Node 仍然能跑，只是少了取消）。
 */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any !== 'function') return timeout;
  return AbortSignal.any([signal, timeout]);
}

// ── Bing 免费通道（无 key 兜底）：RSS 主 + HTML 兜底双通道 ──
// 2026-09-17 换血（原 DDG 通道在本机网络直连超时、彻底不可用）：cn.bing.com/search
// 实测直连 200 无重定向；带 &format=rss 返回标准 RSS2.0，<item> 内 title/link/description
// 齐全且 <link> 已是干净真实 URL（无需处理 bing.com/ck/a 跳转链）；
// HTML 通道作降级备份（b_algo 块；标题在 h2>a、摘要在 .b_caption>p，链接同为真实直链）。
const BING_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BING_SEARCH = 'https://cn.bing.com/search';

/** 码点还原：空白类实体（&#160; 等）归一为空格，非法码点丢弃。 */
function fromCodePoint(raw: string, radix: number): string {
  const n = Number.parseInt(raw, radix);
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  return n === 160 ? ' ' : String.fromCodePoint(n);
}

/** XML/HTML 实体还原（RSS 与 HTML 片段共用）。`&` 必须最后解，避免二次转义。 */
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => fromCodePoint(h, 16))
    .replace(/&#(\d+);/g, (_, d: string) => fromCodePoint(d, 10))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 剥标签 + 实体还原 → 纯文本（标题含 <strong> 高亮标签，必须走这一步）。 */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // 块级/换行标签留一个空格做分隔；行内标签（<strong> 高亮）直接删，避免把标题切碎
      .replace(/<\/?(?:br|p|div|li|ol|ul|h[1-6])\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** RSS 通道（主）：结构化、体积小（~8KB）、字段稳定，实测中文查询稳定出 10 条。 */
async function bingRss(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetchSafe(`${BING_SEARCH}?q=${encodeURIComponent(query)}&format=rss`, {
    headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: combineSignals(signal, 6_000),
  });
  if (!res.ok) throw new Error(`Bing RSS ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, 8)
    .map((m) => {
      const block = m[1] ?? '';
      const field = (tag: string): string => {
        const hit = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
        return decodeEntities(hit?.[1] ?? '').trim();
      };
      return {
        title: field('title'),
        url: field('link'),
        snippet: field('description').replace(/\s+/g, ' ').slice(0, 500),
        source: 'bing',
      };
    })
    .filter((r) => r.url.startsWith('http'));
}

/** HTML 通道（兜底）：RSS 端点若被关闭/改版时接管；按 b_algo 块切分后逐块取标题与摘要。 */
async function bingHtml(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetchSafe(`${BING_SEARCH}?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': BING_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: combineSignals(signal, 6_000),
  });
  if (!res.ok) throw new Error(`Bing HTML ${res.status}`);
  const html = await res.text();
  const blocks = html.match(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<li class="b_pag"|<\/ol>)/gi) ?? [];
  return blocks
    .slice(0, 8)
    .map((block) => {
      const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const para =
        block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ??
        block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
      return {
        title: htmlToText(link?.[2] ?? ''),
        url: decodeEntities(link?.[1] ?? ''),
        snippet: htmlToText(para?.[1] ?? '').slice(0, 500),
        source: 'bing-html',
      };
    })
    .filter((r) => r.url.startsWith('http'));
}

/** RSS 优先、HTML 兜底；单路软降级不报失败，双路全挂才逐路冒泡原因。 */
async function bingSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const failed: string[] = [];
  for (const [name, run] of [
    ['rss', bingRss],
    ['html', bingHtml],
  ] as const) {
    try {
      const results = await run(query, signal);
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
  opts: { skipCache?: boolean; signal?: AbortSignal } = {},
): Promise<{ results: SearchResult[]; providers: string[]; failed: string[] }> {
  const keyed = (
    [
      { type: 'exa', priority: 1 },
      { type: 'tavily', priority: 2 },
      { type: 'zhipu', priority: 3 },
    ] as SearchProviderConfig[]
  ).filter((p) => getProviderKey(p.type));

  // 三家全无 key → Bing 免费通道兜底（绝不让搜索整条路走死）
  const active: SearchProviderConfig[] = keyed.length > 0 ? keyed : [{ type: 'bing', priority: 4 }];

  // 缓存键含 provider 组合签名：配 key 前拿到的兜底结果，不能在建 key 后继续被端出 24h
  const cacheKey = `q:${active.map((p) => p.type).join('+')}|${query}`;
  const cached = opts.skipCache ? null : cacheGet(cacheKey);
  if (cached) return { results: cached, providers: ['cache'], failed: [] };

  const settled = await Promise.allSettled(
    active.map((p) => IMPL[p.type]!(query, getProviderKey(p.type), opts.signal)),
  );
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
  if (results.length === 0) {
    // 观测接线（可观测地基 M-A）：零结果也是信号。payload 只存截断查询词与失败摘要（隐私口径见 shared/obs.ts）。
    publishEvent({
      type: 'obs',
      kind: 'search_empty',
      payload: { query: query.slice(0, 200), failed: failed.join('; ').slice(0, 500) },
    });
  }
  if (results.length > 0) cacheSet(cacheKey, results);
  return { results, providers: used, failed };
}

/** 搜索结果 → LLM 工具结果文本（带来源标注，Perplexity 式可信感） */
export function resultsToContext(results: SearchResult[]): string {
  if (results.length === 0) return '（搜索无结果）';
  return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
}
