/**
 * search/index — 联网搜索聚合（学环核心件）。
 * Provider 矩阵（规划 §1.5.6 实测换血）：Exa 主 + Tavily 备 + 智谱国产兜底，
 * 三家全无 key 时退回 Bing 免费通道（免 key 兜底，端点现指 www.bing.com；
 * 2026-09-17 由 DDG 换入、2026-09-25 由 cn 子域换到 www，RSS 主 + HTML 兜底双通道不变）；
 * 并行聚合、单家失败跳过、URL 去重；search_cache 单表 TTL（强化包 S2）。
 * key 优先取该用户自己在设置里存的（密文，见 storage/crypto），其次环境变量（B-020 倒正）。
 */
import { getDb } from '../storage/db.js';
import { encryptSecret, decryptSecret } from '../storage/crypto.js';
import { bingSearch } from './bing-channel.js';
import { combineSignals } from './combine.js';
import { fetchSafe } from './ssrf-guard.js';
import type { SearchResult } from './types.js';
import { publishEvent } from '../events/bus.js';
import { ownerForWrite } from '../auth/ownership.js';

// 公开面 re-export：消费者（`chat/tools/*`、`learning/collect.ts`）与测试都从这里进，
// 拆分（bing-channel / combine / types）只是内部换格子，不改对外接线。
export { htmlToText, bingSearch } from './bing-channel.js';
export { combineSignals } from './combine.js';
export type { SearchResult } from './types.js';

/** 需要 key 的托管服务商（bing 免 key，故不在此列） */
export const KEYED_PROVIDERS = ['exa', 'tavily', 'zhipu'] as const;
export type KeyedProvider = (typeof KEYED_PROVIDERS)[number];

export interface SearchProviderConfig {
  type: KeyedProvider | 'bing';
  apiKey?: string;
  priority: number;
}

/**
 * 取某家的 key：**该用户自己的设置优先，其次环境变量**。
 *
 * ★ M2d（2026-09-18，契约 TENANCY-SPEC §8.2）：`app_settings` 归主后，`search_key_*`
 *   是**每个用户自己的 key**（BYOK 语义），而环境变量是**平台兜底**
 *   （与 §8.1.1 的双通道一致：平台免费额度来自 env 里配的 key，不需要也不应该有"平台行"）。
 *   ⚠️ 老库里的 `search_key_*` 行在 v30 之后变成无主行（`owner_id = ''`）⇒ 登录用户读不到，
 *   需用 `_probe/claim-legacy.mjs` 认领（或直接重新填一次）。
 * ★★ **B-020（2026-09-25）：上面那句「env 是兜底」以前只写在注释里，实现是反的**
 *   （旧写法 `keyFromEnv() || keyFromSettings()`）⇒ `.env` 一旦配上平台 key，
 *   **所有人自己填的 key 会被静默绕过**（他自己的额度不被使用，他在设置里删掉 key
 *   也删不掉那盏「已配置」的灯）。修法＝把顺序倒回来，让 env 真的只在「这个用户没配」时出现。
 *   ★ **倒完之后两侧口径是一致的，不是各说各话**：聊天侧 `llm/platform-channel.ts` 的
 *   `resolveProviderCredentials()` 早就是「env **只对平台行**注入，BYOK 行绝不覆盖」，
 *   它原话写着「那会把用户自己的 key 换成一笔平台开销，等于"你配了 key，但花的还是平台的钱"」——
 *   搜索侧以前做的正是那句话禁的事。（两处语义仍不完全同形：聊天侧有"平台行"这个数据概念，
 *   搜索侧没有，所以搜索侧的 env 只能靠「这个用户没填」这个条件登场。）
 *   ⚠️ **对现网零影响**：生产 `.env` 现读**零条**搜索 key（09-25 只读数 `grep -cE "^(EXA|TAVILY|ZHIPU)_API_KEY=" = 0`；
 *   ★ 探针那句 `providers:["bing"]` **不算证据**——它自己会先把这三个变量删掉），
 *   故本批是**把一条还没踩的坑填了**，不是止血；它真正的价值在下一批——一旦给 `.env` 配了平台 key，
 *   顺序不倒就会立刻咬到自带 key 的用户。
 */
function keyFromEnv(type: string): string {
  const env: Record<string, string | undefined> = {
    exa: process.env.EXA_API_KEY,
    tavily: process.env.TAVILY_API_KEY,
    zhipu: process.env.ZHIPU_API_KEY,
  };
  return env[type] ?? '';
}

function keyFromSettings(type: string, ownerId: string | null): string {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), `search_key_${type}`) as { value: string } | undefined;
  return row?.value ? decryptSecret(row.value) : '';
}

export function getProviderKey(type: string, ownerId: string | null): string {
  // ★ 顺序即语义（B-020）：**用户自己的 key 在前**，env 只在用户没配时兜底。
  return keyFromSettings(type, ownerId) || keyFromEnv(type);
}

/**
 * 三家 key 的配置状态（只回布尔，明文/密文都不出响应）。
 *
 * ⚠️ **B-020 的口径（刻意不改，但要说清）**：这里答的是「**这一家现在有没有 key 可用**」，
 *   不是「**你自己**填过没有」——所以 `.env` 里配了平台 key 时，未登录/没填的用户看到的灯也是亮的，
 *   而他在设置里删掉自己那把之后灯**仍然亮**（此刻用的是平台那把，灯说的还是实话）。
 *   要把两件事分开得给响应加字段（`configured: 'byok' | 'platform'`），那是 UI 语义变更、
 *   由老板点单再做；本批只倒顺序、不动对外形状（动了会把设置页的 `Record<p, boolean>` 消费方一起卷进来）。
 */
export function listKeyStatus(ownerId: string | null): Record<KeyedProvider, boolean> {
  const out = {} as Record<KeyedProvider, boolean>;
  for (const p of KEYED_PROVIDERS) out[p] = getProviderKey(p, ownerId).length > 0;
  return out;
}

/** 存 key：非空加密落库；空串=删除该 key（环境变量仍可用）。 */
export function saveProviderKey(type: KeyedProvider, plain: string, ownerId: string | null): void {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  if (!plain) {
    db.prepare('DELETE FROM app_settings WHERE owner_id = ? AND key = ?').run(owner, `search_key_${type}`);
    return;
  }
  db.prepare(
    // ★ 冲突目标跟着主键改（v30）：仍写 `ON CONFLICT(key)` 会运行时 500。
    `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
  ).run(ownerForWrite(ownerId), `search_key_${type}`, encryptSecret(plain));
}

// ── 三家实现（各 ~20 行独立函数，简单组合原则）──

async function exaSearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetchSafe('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    // ★ contents.highlights（2026-09-20）：Exa 官方对「搜索结果喂给 AI 上下文」的推荐口径是
    //   在 /search 上带 `contents:{highlights:true}` —— 返回的是**按查询相关度选出的片段**，
    //   而不是整页正文。原先取 `text` 再硬截 500 字，截到的是**页面开头**（与查询词无关）；
    //   highlights 截的是**跟问题最相关的段落**，这正是契约 B-006 关心的回灌质量。
    //   计费口径：搜索结果**前 10 条**带 contents 不额外计费（本处 numResults=6 在额度内）⇒ 零新增成本。
    body: JSON.stringify({ query, numResults: 6, type: 'auto', contents: { highlights: true } }),
    signal: combineSignals(signal, 12_000),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; text?: string; highlights?: string[] }>;
  };
  return (data.results ?? []).slice(0, 6).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    // highlights 优先、text 兜底。★ 判空用 `length` 不用真值：`[]` 是**真值**，
    // 写成 `r.highlights ? … : …` 会让「返回了空高亮数组」静默产出空 snippet
    // ——有结果条目、没有内容，而且不报错。两条路都没有就空串，不编造。
    snippet: (r.highlights?.length ? r.highlights.join(' ') : (r.text ?? '')).slice(0, 500),
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

/**
 * 智谱 web-search-pro（国产兜底：字段名接入前以实测为准，失败自动跳过不阻塞降级链）
 *
 * ⚠️ **2026-09-25 对照官方文档发现一处可能对不上，刻意未改**：`docs.bigmodel.cn` 的「网络搜索」
 *   参考页写的请求字段是 `search_query`（另有可选 `search_engine`），而这里发的是 `query`。
 *   ★ **不改的理由不是"相信现在的对"，是"没资格判"**：三家托管 provider 在本仓**一次真调用都没有过**
 *   （生产 `.env` 零条搜索 key，见 `docs/SEARCH-PROVIDER-SELECTION.md` §2），
 *   把 `query` 改成 `search_query` 会同时改掉唯一那条能证伪它的线索——真要修，
 *   得连着「拿一把 key 实跑一次」一起做，那是选型批的事，不是注释批的事。
 *   响应侧解析（`search_result[].title/link/content`）与文档一致，故若坏也只坏一个字段。
 */
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

/**
 * 聚合入口：并行发起有 key 的 provider，失败跳过，URL 去重合并。
 *
 * ★ M2d：`ownerId` **必填**（`string | null`）——`search_key_*` 现在是**每个用户自己的 key**
 *   （v30 归主），漏传的后果是「读不到自己配的 key ⇒ 静默退回 Bing 免费通道」：
 *   功能看着还在、质量悄悄降级，任何测试都不会红。
 */
export async function searchWeb(
  query: string,
  ownerId: string | null,
  opts: { skipCache?: boolean; signal?: AbortSignal } = {},
): Promise<{ results: SearchResult[]; providers: string[]; failed: string[] }> {
  const keyed = (
    [
      { type: 'exa', priority: 1 },
      { type: 'tavily', priority: 2 },
      { type: 'zhipu', priority: 3 },
    ] as SearchProviderConfig[]
  ).filter((p) => getProviderKey(p.type, ownerId));

  // 三家全无 key → Bing 免费通道兜底（绝不让搜索整条路走死）
  const active: SearchProviderConfig[] = keyed.length > 0 ? keyed : [{ type: 'bing', priority: 4 }];

  // 缓存键含 provider 组合签名：配 key 前拿到的兜底结果，不能在建 key 后继续被端出 24h
  const cacheKey = `q:${active.map((p) => p.type).join('+')}|${query}`;
  const cached = opts.skipCache ? null : cacheGet(cacheKey);
  if (cached) return { results: cached, providers: ['cache'], failed: [] };

  const settled = await Promise.allSettled(
    active.map((p) => IMPL[p.type]!(query, getProviderKey(p.type, ownerId), opts.signal)),
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
      failed.push(`${p.type}: ${errText(r.reason)}`);
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
