/** 应试搜索：保留通用结果，召回不足时从范围内真实页面补充资料。 */
import { examUrlAllowed } from '@sb/shared';
import type { ExamContext } from '../learning/exam-mode.js';
import { examDirectQueries } from '../learning/exam-mode.js';
import { retrieveDoc } from '../learning/doc-retrieve.js';
import { searchWeb } from './index.js';
import { htmlToText } from './bing-channel.js';
import { combineSignals } from './combine.js';
import { examDirectPages, examEntryLinks } from './exam-direct.js';
import { conflictingLanguage, examTopicQuery, relevantTopicText, topicLinksOf, topicScore } from './exam-query.js';
import { fetchPageText } from './page-text.js';
import type { SearchResult } from './types.js';

export const MAX_EXAM_ENTRY_PAGES = 6;
export const MAX_EXAM_DETAIL_PAGES = 4;
export const EXAM_SEARCH_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 6_000;
type SearchOptions = { skipCache?: boolean; signal?: AbortSignal };
export type ExamSearchResult = Awaited<ReturnType<typeof searchWeb>> & { directSites: string[]; unavailable: boolean };

/** 先覆盖不同站点，再取同站其它页；相关页优先，避免 C++/Go/Python 三页占满预算。 */
function entryPicks(exam: ExamContext, query: string): SearchResult[] {
  const ranked = examEntryLinks(exam.sources, exam.hosts)
    .filter((r) => !conflictingLanguage(`${r.title} ${r.url}`, query))
    .sort((a, b) => topicScore(`${b.title} ${b.url}`, query) - topicScore(`${a.title} ${a.url}`, query));
  const hosts = new Set<string>();
  const first: SearchResult[] = [];
  const rest: SearchResult[] = [];
  for (const r of ranked) {
    const host = new URL(r.url).hostname.replace(/^www\./, '');
    if (hosts.has(host)) rest.push(r);
    else { hosts.add(host); first.push(r); }
  }
  return [...first, ...rest].slice(0, MAX_EXAM_ENTRY_PAGES);
}

export async function searchExamWeb(
  query: string, ownerId: string | null, exam: ExamContext, opts: SearchOptions = {},
): Promise<ExamSearchResult> {
  if (!exam.on) {
    const base = await searchWeb(query, ownerId, opts);
    return { ...base, directSites: [], unavailable: base.providers?.length === 0 && (base.failed?.length ?? 0) > 0 };
  }
  const empty: ExamSearchResult = { results: [], providers: [], failed: [], dropped: 0, directSites: [], unavailable: false };
  if (!query.trim() || exam.hosts.length === 0 || opts.signal?.aborted) return empty;
  const signal = combineSignals(opts.signal, EXAM_SEARCH_TIMEOUT_MS);
  const base = await searchWeb(query, ownerId, { ...opts, signal, allowHosts: exam.hosts });
  const result: ExamSearchResult = { ...base, results: [...base.results], providers: [...base.providers], failed: [...base.failed], directSites: [], unavailable: base.providers.length === 0 && base.failed.length > 0 };
  if (base.results.length >= 3 || signal.aborted) return result;
  const topic = examTopicQuery(query);
  if (!topic) return result;
  const seen = new Set(base.results.map((r) => r.url));
  const details: SearchResult[] = [];
  const failed = result.failed;
  const read = async (hit: SearchResult): Promise<void> => {
    if (signal.aborted || !examUrlAllowed(hit.url, exam.hosts)) return;
    try {
      const page = await fetchPageText(hit.url, { signal, timeoutMs: PAGE_TIMEOUT_MS, allowHosts: exam.hosts });
      if (!page.ok) {
        failed.push(`${new URL(hit.url).hostname}: ${page.kind === 'fetch' ? page.reason : page.kind === 'empty' ? '无正文' : page.what}`);
        return;
      }
      result.unavailable = false; // 页面可读但主题不匹配，仍是「无结果」，不能冒充通道全挂。
      details.push(...topicLinksOf(page.html, hit.url, exam.hosts, topic));
      if (conflictingLanguage(`${page.title} ${hit.url}`, topic)) return;
      // 主内容优先，避免文档导航栏里「全站都有的词」伪装成正文命中。
      const main = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(page.html)?.[1]
        ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(page.html)?.[1];
      const body = main === undefined ? page.text : htmlToText(main);
      const chunks = retrieveDoc(body, topic, { k: 8, chunkChars: 900, overlap: 120, budgetChars: 7200 })
        .filter((c) => relevantTopicText(c.text, topic)).slice(0, 2);
      if (chunks.length === 0 || seen.has(hit.url)) return;
      seen.add(hit.url);
      result.results.push({ ...hit, title: page.title || hit.title, snippet: chunks.map((c) => c.text).join('\n') });
      if (!result.providers.includes(hit.source)) result.providers.push(hit.source);
      const site = exam.sources.find((s) => examUrlAllowed(hit.url, [s.host]))?.label ?? new URL(hit.url).hostname;
      if (!result.directSites.includes(site)) result.directSites.push(site);
    } catch (err) {
      failed.push(`${new URL(hit.url).hostname}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // 通用引擎之外两条补充路并行；单站失败不阻断其他站。
  const [, direct] = await Promise.all([
    Promise.all(entryPicks(exam, topic).map(read)),
    examDirectPages(examDirectQueries(query, exam), exam.hosts, { signal, timeoutMs: PAGE_TIMEOUT_MS }),
  ]);
  failed.push(...direct.failed);
  if (direct.sites.length > 0) result.unavailable = false;
  const candidates = [...direct.links, ...details]
    .filter((r) => !seen.has(r.url) && examUrlAllowed(r.url, exam.hosts))
    .sort((a, b) => topicScore(`${b.title} ${b.url}`, topic) - topicScore(`${a.title} ${a.url}`, topic));
  const visited = new Set<string>();
  const picks = candidates.filter((r) => {
    if (visited.has(r.url)) return false;
    visited.add(r.url);
    return true;
  }).slice(0, MAX_EXAM_DETAIL_PAGES);
  await Promise.all(picks.map(read));
  result.results = result.results.filter((r) => examUrlAllowed(r.url, exam.hosts))
    .sort((a, b) => (3 * topicScore(b.title, topic) + topicScore(b.snippet, topic))
      - (3 * topicScore(a.title, topic) + topicScore(a.snippet, topic))
      || a.url.localeCompare(b.url)).slice(0, 10);
  result.directSites = [...new Set(result.results.filter((r) => r.source === 'entry' || r.source === 'direct')
    .map((r) => exam.sources.find((s) => examUrlAllowed(r.url, [s.host]))?.label ?? new URL(r.url).hostname))];
  return result;
}
