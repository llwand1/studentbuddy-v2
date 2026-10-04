/**
 * lookup/wiki —— 维基百科条目速查（契约 `docs/LOOKUP-SPEC.md` §3）。
 *
 * 为什么先查它：划词速查里绝大多数是**术语**，而术语的标准释义不该每次都烧一次模型额度。
 * 维基的 REST summary 接口又快（一次 GET）、又稳定、又免费、还自带条目链接可供追溯。
 *
 * 两步：
 *   ① `/w/api.php?action=query&list=search` 找到最匹配的条目标题（直接拿查询词拼 summary
 *      在中文站经常 404——「闭包」的条目实际叫「闭包 (计算机科学)」）；
 *   ② `/api/rest_v1/page/summary/{title}` 取首段摘要。
 *
 * ★ 语种回落：按字形先选 zh / en，落空再试另一个。很多计算机术语中文站没有、英文站有。
 * ★ 消歧义页不算命中：`type === 'disambiguation'` 的摘要是一串「可能指……」，
 *   给出去等于让人白读一遍——按未命中处理，把机会让给 AI 讲解。
 * ★ 走 `fetchSafe`（与全仓同一套 SSRF 口径）。主机名是**我们自己拼的常量**，
 *   查询词只进 query string，不参与主机解析。
 */
import { WIKI_EXTRACT_MAX, otherWikiLang, wikiLangFor, type WikiLookup } from '@sb/shared';
import { fetchSafe } from '../search/ssrf-guard.js';
import { combineSignals } from '../search/combine.js';

const TIMEOUT_MS = 8_000;
const UA = 'studentbuddy/0.2 (learning app; contact via github.com/llwand1/studentbuddy-v2)';

/** 缓存：同一个词在一次学习里会被反复划到（上限 200 条、TTL 1 天） */
const cache = new Map<string, { at: number; val: WikiLookup }>();
const TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX = 200;

function cacheGet(k: string): WikiLookup | null {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(k);
    return null;
  }
  return hit.val;
}

function cachePut(k: string, val: WikiLookup): void {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(k, { at: Date.now(), val });
}

interface SearchHit {
  title: string;
}

async function searchTitle(lang: string, term: string, signal?: AbortSignal): Promise<string | null> {
  const q = new URLSearchParams({ action: 'query', list: 'search', srsearch: term, srlimit: '1', format: 'json', origin: '*' });
  const res = await fetchSafe(`https://${lang}.wikipedia.org/w/api.php?${q.toString()}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: combineSignals(signal, TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  const list = (body as { query?: { search?: SearchHit[] } }).query?.search;
  const first = Array.isArray(list) ? list[0] : undefined;
  return first && typeof first.title === 'string' && first.title !== '' ? first.title : null;
}

interface SummaryBody {
  title?: unknown;
  extract?: unknown;
  type?: unknown;
  content_urls?: { desktop?: { page?: unknown } };
}

async function summary(lang: string, title: string, signal?: AbortSignal): Promise<{ title: string; extract: string; url: string } | null> {
  const res = await fetchSafe(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: combineSignals(signal, TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const b = (await res.json()) as SummaryBody;
  // 消歧义页按未命中处理：它的摘要是一串「可能指……」，读了等于没读
  if (b.type === 'disambiguation') return null;
  const extract = typeof b.extract === 'string' ? b.extract.trim() : '';
  const got = typeof b.title === 'string' ? b.title : title;
  if (extract === '') return null;
  const page = b.content_urls?.desktop?.page;
  const url = typeof page === 'string' ? page : `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(got)}`;
  return { title: got, extract: extract.length > WIKI_EXTRACT_MAX ? `${extract.slice(0, WIKI_EXTRACT_MAX)}…` : extract, url };
}

async function tryLang(lang: string, term: string, signal?: AbortSignal): Promise<WikiLookup | null> {
  const title = await searchTitle(lang, term, signal);
  if (!title) return null;
  const s = await summary(lang, title, signal);
  if (!s) return null;
  return { ok: true, title: s.title, extract: s.extract, url: s.url, lang, redirected: s.title.trim() !== term.trim() };
}

/**
 * 查一个词。先按字形选语种，落空再试另一个；两边都没有就如实说没有
 * ——**不编**，也不把消歧义页当答案（小窗会据此把「让 AI 讲解」提为主按钮）。
 */
export async function wikiLookup(term: string, langHint?: string, signal?: AbortSignal): Promise<WikiLookup> {
  const q = term.trim();
  if (q === '') return { ok: false, reason: '没有可查的词' };
  const first = langHint === 'zh' || langHint === 'en' ? langHint : wikiLangFor(q);
  const key = `${first}|${q}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  let out: WikiLookup;
  try {
    const a = await tryLang(first, q, signal);
    const b = a ?? (await tryLang(otherWikiLang(first), q, signal));
    out = b ?? { ok: false, reason: `维基百科没有「${q}」的条目` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 网络问题不缓存：下次可能就通了
    return { ok: false, reason: /abort|timeout/i.test(msg) ? '维基百科查询超时' : '维基百科查询失败' };
  }
  cachePut(key, out);
  return out;
}

/** 测试用 */
export function resetWikiCache(): void {
  cache.clear();
}
