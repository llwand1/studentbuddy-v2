/** 应试搜索：保留通用结果，召回不足时从范围内真实页面补充资料。 */
import { examUrlAllowed } from '@sb/shared';
import type { ExamContext } from '../learning/exam-mode.js';
import { examDirectQueries } from '../learning/exam-mode.js';
import { retrieveDoc } from '../learning/doc-retrieve.js';
import { searchWeb } from './index.js';
import { studyTextOf } from './study-text.js';
import { quizTopicScope } from './exam-topic-scope.js';
import { combineSignals } from './combine.js';
import { examDirectPages, examEntryLinks } from './exam-direct.js';
import { conflictingLanguage, directoryPage, examTopicQuery, questionPage, relevantTopicText, studyPageAllowed, topicLinksOf, topicLinkScore, topicScore } from './exam-query.js';
import { fetchExamPage } from './exam-page.js';
import type { SearchResult } from './types.js';

export const MAX_EXAM_ENTRY_PAGES = 6;
export const MAX_EXAM_DETAIL_PAGES = 4;
export const EXAM_SEARCH_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 6_000;
type SearchOptions = { skipCache?: boolean; signal?: AbortSignal; purpose?: 'quiz' | 'collect' };
export type ExamSearchResult = Awaited<ReturnType<typeof searchWeb>> & { directSites: string[]; unavailable: boolean };

/** 先覆盖不同站点，再取同站其它页；相关页优先，避免 C++/Go/Python 三页占满预算。 */
function entryPicks(exam: ExamContext, query: string, web: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const ranked = [...web, ...examEntryLinks(exam.sources, exam.hosts)]
    .filter((r) => {
      if (seen.has(r.url) || !examUrlAllowed(r.url, exam.hosts) || !studyPageAllowed(r.title, r.url)
        || conflictingLanguage(`${r.title} ${r.url}`, query)) return false;
      seen.add(r.url);
      return true;
    })
    .sort((a, b) => 3 * (topicLinkScore(`${b.title} ${b.url}`, query) - topicLinkScore(`${a.title} ${a.url}`, query))
      + topicScore(b.snippet, query) - topicScore(a.snippet, query));
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
  if (opts.purpose) exam = quizTopicScope(exam, query);
  const empty: ExamSearchResult = { results: [], providers: [], failed: [], dropped: 0, directSites: [], unavailable: false };
  if (!query.trim() || exam.hosts.length === 0 || opts.signal?.aborted) return empty;
  const signal = combineSignals(opts.signal, EXAM_SEARCH_TIMEOUT_MS);
  const base = await searchWeb(query, ownerId, { ...opts, signal, allowHosts: exam.hosts });
  const result: ExamSearchResult = { ...base, results: [], providers: [...base.providers], failed: [...base.failed], directSites: [], unavailable: base.providers.length === 0 && base.failed.length > 0 };
  if (signal.aborted) return result;
  const topic = examTopicQuery(query);
  if (!topic) return result;
  const seen = new Set<string>();
  const readUrls = new Set<string>();
  const details: SearchResult[] = [];
  const failed = result.failed;
  const read = async (hit: SearchResult): Promise<void> => {
    if (signal.aborted || !examUrlAllowed(hit.url, exam.hosts) || readUrls.has(hit.url)) return;
    readUrls.add(hit.url);
    try {
      const page = await fetchExamPage(hit.url, ownerId, { signal, timeoutMs: PAGE_TIMEOUT_MS, allowHosts: exam.hosts });
      if (!page.ok) {
        failed.push(`${new URL(hit.url).hostname}: ${page.kind === 'fetch' ? page.reason : page.kind === 'empty' ? '无正文' : page.what}`);
        return;
      }
      result.unavailable = false; // 页面可读但主题不匹配，仍是「无结果」，不能冒充通道全挂。
      if (/^(?:滑动验证|安全验证|访问验证)(?:页面)?(?:\s*[|—-].*)?$/.test(page.title)) {
        failed.push(`${new URL(hit.url).hostname}: 页面要求验证，无法读取正文`);
        return;
      }
      details.push(...topicLinksOf(page.html, hit.url, exam.hosts, topic));
      if (opts.purpose && directoryPage(page.title, hit.url)) return;
      if (conflictingLanguage(`${page.title} ${hit.url}`, topic) || !studyPageAllowed(page.title, hit.url)) return;
      // 主内容优先，避免文档导航栏里「全站都有的词」伪装成正文命中。
      const main = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(page.html)?.[1]
        ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(page.html)?.[1];
      const body = studyTextOf(main ?? page.html);
      const chunks = retrieveDoc(body, topic, { k: 8, chunkChars: 1200, overlap: 180, budgetChars: 9600 })
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
    Promise.all(entryPicks(exam, topic, base.results).map(read)),
    examDirectPages(examDirectQueries(query, exam), exam.hosts, { signal, timeoutMs: PAGE_TIMEOUT_MS, topic }),
  ]);
  failed.push(...direct.failed);
  if (direct.sites.length > 0) result.unavailable = false;
  let used = 0;
  while (used < MAX_EXAM_DETAIL_PAGES && !signal.aborted) {
    const visited = new Set<string>();
    const picks = [...direct.links, ...details]
      .filter((r) => {
        if (readUrls.has(r.url) || visited.has(r.url) || !examUrlAllowed(r.url, exam.hosts)
          || !studyPageAllowed(r.title, r.url) || conflictingLanguage(`${r.title} ${r.url}`, topic)) return false;
        visited.add(r.url);
        return true;
      })
      .sort((a, b) => Number(directoryPage(a.title, a.url)) - Number(directoryPage(b.title, b.url))
        || topicLinkScore(`${b.title} ${b.url}`, topic) - topicLinkScore(`${a.title} ${a.url}`, topic))
      .slice(0, Math.min(2, MAX_EXAM_DETAIL_PAGES - used));
    if (picks.length === 0) break;
    used += picks.length;
    await Promise.all(picks.map(read));
  }
  const score = (r: SearchResult) => 3 * topicScore(r.title, topic) + topicScore(r.snippet, topic)
    + (opts.purpose === 'collect' && questionPage(r.title, r.url) ? 24 : 0);
  result.results = result.results.filter((r) => examUrlAllowed(r.url, exam.hosts))
    .sort((a, b) => score(b) - score(a)
      || a.url.localeCompare(b.url)).slice(0, 10);
  result.directSites = [...new Set(result.results.filter((r) => r.source === 'entry' || r.source === 'direct')
    .map((r) => exam.sources.find((s) => examUrlAllowed(r.url, [s.host]))?.label ?? new URL(r.url).hostname))];
  return result;
}
