/**
 * sources/video-route —— 「视频线路」取数（契约 docs/SOURCE-TRACE-SPEC.md §12）。
 *
 * 两家两套办法，差别如实写进结果的 `via` / `note`：
 *  - **B站**：先打站内搜索接口（`api.bilibili.com/x/web-interface/search/type`，公开、免登录）——有标题 / 封面 /
 *    时长 / 播放量 / UP 主，都是学习者挑视频要看的。★ 接口要带设备 cookie `buvid3`（2026-09-30 实测：不带时风控
 *    间歇性回 412），cookie 从 `x/frontend/finger/spi` 免登录领一枚、进程内缓存 6 小时，遇 412 换新的再试一次。
 *    接口仍没应答（风控、超时、形状变了）就**退回联网搜索** `site:bilibili.com/video`，从结果网址里抠 BV 号
 *    （没有封面时长，但一样能就地播）。两条都空 ⇒ `via:'none'`，只剩站内搜索页出口。
 *  - **抖音**：没有公开接口，搜索页靠脚本渲染、封面链接带签名会过期 ⇒ 只走联网搜索 `site:douyin.com`，
 *    命中里只留**视频页**（`/video/<id>` 或 `v.douyin.com` 短链），给标题 + 跳转；零命中也照样给站内搜索页。
 *
 * 取 B站接口走 `fetchSafe`（与其它出站一致，测试里同一处桩掉）；联网搜索走 `searchWeb`（吃用户自己配的 key，
 * 没 key 时是 Bing 免费通道——它对两家的收录都很薄，这正是要有站内接口这条腿的原因）。
 * 结果进程内按「线路 + 查询词」缓存 10 分钟（学习者在两条线路间来回切不该反复打接口）。
 */
import {
  VIDEO_HITS_MAX,
  bilibiliVideoUrl,
  bvidFromUrl,
  cleanVideoQuery,
  douyinVideoIdFromUrl,
  stripSearchEm,
  videoSiteSearchUrl,
  type VideoHit,
  type VideoRoute,
  type VideoRouteResult,
} from '@sb/shared';
import { fetchSafe } from '../search/ssrf-guard.js';
import { combineSignals } from '../search/combine.js';
import { searchWeb, type SearchResult } from '../search/index.js';
import { examAllowed, loadExamContext } from '../learning/exam-mode.js';
import { FETCH_UA } from '../media/image-download.js';

export const BILI_SEARCH_API = 'https://api.bilibili.com/x/web-interface/search/type';
/** 免登录领设备 cookie（`b_3` = buvid3，`b_4` = buvid4） */
export const BILI_FINGER_API = 'https://api.bilibili.com/x/frontend/finger/spi';
const BILI_TIMEOUT_MS = 8_000;
const BILI_COOKIE_TTL_MS = 6 * 60 * 60_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 40;
const SNIPPET_MAX = 120;

export interface VideoRouteDeps {
  /** 联网搜索（默认 `searchWeb`，按 ownerId 吃用户自己的 key） */
  search?: (query: string, signal?: AbortSignal) => Promise<SearchResult[]>;
  /** B站接口取数（默认 `fetchSafe`） */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** B站接口 JSON → 命中列表（纯函数）：形状不对 ⇒ 抛，交给上层退回联网 */
export function parseBilibiliSearch(json: unknown): VideoHit[] {
  const root = (json ?? {}) as { code?: unknown; message?: unknown; data?: { result?: unknown } };
  if (root.code !== 0) throw new Error(`B站接口 code ${String(root.code ?? '?')}${root.message ? `（${asStr(root.message)}）` : ''}`);
  const list = Array.isArray(root.data?.result) ? (root.data.result as Record<string, unknown>[]) : null;
  if (!list) throw new Error('B站接口返回的形状不对');
  const hits: VideoHit[] = [];
  for (const r of list) {
    const bvid = asStr(r.bvid);
    const title = stripSearchEm(asStr(r.title));
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || !title) continue;
    const pic = asStr(r.pic);
    const cover = /^\/\//.test(pic) ? `https:${pic}` : /^https?:\/\//.test(pic) ? pic : '';
    const desc = stripSearchEm(asStr(r.description));
    hits.push({
      route: 'bilibili',
      url: bilibiliVideoUrl(bvid),
      title,
      ...(asStr(r.author) ? { author: asStr(r.author) } : {}),
      ...(cover ? { cover } : {}),
      ...(asStr(r.duration) ? { duration: asStr(r.duration) } : {}),
      ...(asNum(r.play) !== undefined ? { plays: asNum(r.play) } : {}),
      ...(desc ? { snippet: clip(desc, SNIPPET_MAX) } : {}),
    });
    if (hits.length >= VIDEO_HITS_MAX) break;
  }
  return hits;
}

type FetchImpl = NonNullable<VideoRouteDeps['fetchImpl']>;
const BILI_HEADERS = { 'User-Agent': FETCH_UA, Accept: 'application/json', Referer: 'https://www.bilibili.com/', 'Accept-Language': 'zh-CN,zh;q=0.9' };

let biliCookie: { value: string; at: number } | null = null;

/** 领 / 复用设备 cookie；领不到就抛（上层当接口失败处理） */
async function bilibiliCookie(signal: AbortSignal | undefined, fetchImpl: FetchImpl, fresh: boolean): Promise<string> {
  if (!fresh && biliCookie && Date.now() - biliCookie.at < BILI_COOKIE_TTL_MS) return biliCookie.value;
  const res = await fetchImpl(BILI_FINGER_API, { headers: BILI_HEADERS, signal: combineSignals(signal, BILI_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`B站设备 cookie HTTP ${res.status}`);
  const body = (await res.json()) as { code?: unknown; data?: { b_3?: unknown; b_4?: unknown } };
  const b3 = asStr(body.data?.b_3);
  if (body.code !== 0 || !b3) throw new Error('B站设备 cookie 没领到');
  const b4 = asStr(body.data?.b_4);
  const value = `buvid3=${b3}${b4 ? `; buvid4=${b4}` : ''}`;
  biliCookie = { value, at: Date.now() };
  return value;
}

async function bilibiliApiSearch(query: string, signal: AbortSignal | undefined, fetchImpl: FetchImpl): Promise<VideoHit[]> {
  const url = `${BILI_SEARCH_API}?search_type=video&keyword=${encodeURIComponent(query)}&page=1&order=totalrank`;
  let res: Response | null = null;
  for (const fresh of [false, true]) {
    const cookie = await bilibiliCookie(signal, fetchImpl, fresh);
    res = await fetchImpl(url, { headers: { ...BILI_HEADERS, Cookie: cookie }, signal: combineSignals(signal, BILI_TIMEOUT_MS) });
    if (res.status !== 412) break; // 412 = 风控不认这枚 cookie：换新的再试一次
    biliCookie = null;
  }
  if (!res || !res.ok) throw new Error(`B站接口 HTTP ${res?.status ?? '?'}`);
  return parseBilibiliSearch(await res.json());
}

/** 联网搜索结果 → 命中（纯函数）：只留能认出视频页的网址，同网址去重 */
export function hitsFromWeb(route: VideoRoute, results: readonly SearchResult[]): VideoHit[] {
  const hits: VideoHit[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const id = route === 'bilibili' ? bvidFromUrl(r.url) : douyinVideoIdFromUrl(r.url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // 搜索结果标题常带站名尾巴（`_哔哩哔哩_bilibili` / ` - 抖音`），可能不止一节，整串剥掉
    const title = stripSearchEm(r.title).replace(/(?:\s*[-_|–—]\s*(?:哔哩哔哩|bilibili|抖音|douyin|B站)\s*)+$/i, '').trim();
    const snippet = stripSearchEm(r.snippet);
    hits.push({
      route,
      url: route === 'bilibili' ? bilibiliVideoUrl(id) : r.url,
      title: title || r.url,
      ...(snippet ? { snippet: clip(snippet, SNIPPET_MAX) } : {}),
    });
    if (hits.length >= VIDEO_HITS_MAX) break;
  }
  return hits;
}

const cache = new Map<string, { result: VideoRouteResult; at: number }>();

export function resetVideoRouteCache(): void {
  cache.clear();
  biliCookie = null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 一条线路搜一次；`query` 已清洗非空（路由层校验） */
export async function searchVideoRoute(route: VideoRoute, rawQuery: string, ownerId: string | null, signal?: AbortSignal, deps: VideoRouteDeps = {}): Promise<VideoRouteResult> {
  const query = cleanVideoQuery(rawQuery);
  // ★ 缓存键含应试范围签名（与 `search_cache` 同一条理由）：进程内这份 10 分钟缓存若不分范围，
  //   关闭模式时搜到的全站结果会被开启模式的请求直接端走——用户看到的就成了「范围外视频」，且不报错。
  const exam = loadExamContext(ownerId);
  const key = `${route}|${exam.signature}|${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;

  const search = deps.search ?? ((q: string, s?: AbortSignal) => searchWeb(q, ownerId, { signal: s, ...(exam.on ? { allowHosts: exam.hosts } : {}) }).then((r) => r.results));
  const siteSearchUrl = videoSiteSearchUrl(route, query);
  let result: VideoRouteResult;
  if (route === 'bilibili') {
    let apiErr = '';
    let hits: VideoHit[] = [];
    try {
      hits = await bilibiliApiSearch(query, signal, deps.fetchImpl ?? fetchSafe);
    } catch (e) {
      apiErr = errText(e);
    }
    if (!apiErr) {
      result = { route, query, hits, siteSearchUrl, via: hits.length > 0 ? 'api' : 'none', ...(hits.length === 0 ? { note: 'B站站内没搜到这个词的视频' } : {}) };
    } else {
      let webErr = '';
      try {
        hits = hitsFromWeb(route, await search(`site:bilibili.com/video ${query}`, signal));
      } catch (e) {
        webErr = errText(e);
      }
      result =
        hits.length > 0
          ? { route, query, hits, siteSearchUrl, via: 'web', note: 'B站接口没应答，这是联网搜索找到的（没有封面与时长，一样能就地播）' }
          : { route, query, hits: [], siteSearchUrl, via: 'none', note: `B站接口没应答（${clip(apiErr, 60)}），联网搜索也${webErr ? '失败了' : '没找到'}；去站内搜吧` };
    }
  } else {
    let hits: VideoHit[] = [];
    let webErr = '';
    try {
      hits = hitsFromWeb(route, await search(`site:douyin.com ${query}`, signal));
    } catch (e) {
      webErr = errText(e);
    }
    result =
      hits.length > 0
        ? { route, query, hits, siteSearchUrl, via: 'web', note: '抖音不开放接口、不许嵌播：这些是联网搜到的视频页，点开在新标签页看' }
        : { route, query, hits: [], siteSearchUrl, via: 'none', note: `抖音不开放接口，联网搜索也${webErr ? '失败了' : '没搜到能直达的视频'}（搜索引擎几乎不收录抖音）；点下面去抖音站内搜` };
  }
  // 应试模式：B站接口这条路不吃搜索引擎，返回域恒为 bilibili.com ⇒ 白名单没放它时整条线路要如实为空，
  // 不能因为「接口返了」就绕过范围（用户选的范围里没 B 站，就不该看到 B 站视频）。
  if (exam.on && result.hits.length > 0) {
    const kept = result.hits.filter((h) => examAllowed(h.url, exam));
    if (kept.length !== result.hits.length) {
      result =
        kept.length > 0
          ? { ...result, hits: kept }
          : {
              ...result,
              hits: [],
              via: 'none' as const,
              note: `所选应试范围内没有这一路的视频源（范围：${exam.summary || '未选范围'}），可去站内搜`,
            };
    }
  }
  if (result.via !== 'none') {
    cache.delete(key);
    cache.set(key, { result, at: Date.now() });
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return result;
}
