/** 搜集抓页与主题窗口：从实时检索选出的页面读正文，保留原文锚点和配图。 */
import { emptyCollectCompleteness } from '@sb/shared';
import type { CollectPageRecord, CollectReport } from '@sb/shared';
import { htmlToText } from '../search/bing-channel.js';
import { studyTextOf } from '../search/study-text.js';
import { combineSignals } from '../search/combine.js';
import { examTopicQuery, relevantTopicText } from '../search/exam-query.js';
import { fetchPageText } from '../search/page-text.js';
import { fetchSafe } from '../search/ssrf-guard.js';
import { retrieveDoc } from './doc-retrieve.js';
import { classifyExamSource, normalizeForAnchor } from './collect-quality.js';
import { markImages, stripMarkers, type PageFigure } from './collect-figures.js';

export const MAX_COLLECT_PAGES = 3;
const PAGE_TEXT_CHARS = 25_000;
const MIN_PAGE_TEXT_CHARS = 500;
export interface CollectedPage extends CollectPageRecord {
  text: string;
  normText: string;
  figures: PageFigure[];
}
type PageOptions = { signal?: AbortSignal; topic?: string; allowHosts?: readonly string[] };

/** 长文只喂主题附近的原文；保持完整的大块上下文，给选项、答案和材料留位置。 */
export function selectCollectText(text: string, topic: string, title = ''): string {
  const query = examTopicQuery(topic);
  if (!query) return '';
  if (text.length <= PAGE_TEXT_CHARS) return relevantTopicText(`${title} ${text}`, query) ? text : '';
  return retrieveDoc(text, query, { k: 6, chunkChars: 10_000, overlap: 2000, budgetChars: 72_000 })
    .filter((c) => relevantTopicText(`${title} ${c.text}`, query)).slice(0, 2)
    .map((c) => c.text).join('\n\n').slice(0, PAGE_TEXT_CHARS);
}

async function fetchPage(rec: { url: string; title: string }, startN: number, opts: PageOptions): Promise<CollectedPage> {
  const page: CollectedPage = { ...rec, fetched: false, text: '', normText: '', figures: [] };
  try {
    let html: string;
    if (opts.topic !== undefined) {
      const fetched = await fetchPageText(rec.url, { signal: opts.signal, timeoutMs: 15_000, allowHosts: opts.allowHosts });
      if (!fetched.ok) {
        page.reason = fetched.kind === 'fetch' ? fetched.reason : fetched.kind === 'empty' ? '无正文' : fetched.what;
        return page;
      }
      html = fetched.html.slice(0, 1_000_000);
      page.title = fetched.title || rec.title;
    } else {
      const res = await fetchSafe(rec.url, {
        headers: { 'User-Agent': 'StudentBuddy/2.0 (personal study tool; 127.0.0.1)', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: combineSignals(opts.signal, 15_000),
      }, undefined, opts.allowHosts);
      if (!res.ok) { page.reason = `HTTP ${res.status}`; return page; }
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('text/html')) { page.reason = `非 HTML 内容（${ct.slice(0, 40) || '未知类型'}）`; return page; }
      html = (await res.text()).slice(0, 1_000_000);
    }
    const body = opts.topic === undefined ? html
      : /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1]
        ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
    const marked = markImages(body, rec.url, startN);
    const text = opts.topic === undefined ? htmlToText(marked.html) : studyTextOf(marked.html);
    if (text.length < MIN_PAGE_TEXT_CHARS) {
      page.reason = `正文过短（${text.length} 字，疑似动态渲染页或反爬占位页）`;
      return page;
    }
    page.text = opts.topic === undefined ? text.slice(0, PAGE_TEXT_CHARS) : selectCollectText(text, opts.topic, page.title);
    if (!page.text) { page.reason = '正文没有与本次主题相关的可摘录内容'; return page; }
    page.fetched = true;
    page.normText = normalizeForAnchor(stripMarkers(page.text));
    page.figures = opts.topic === undefined ? marked.figures
      : marked.figures.filter((f) => new RegExp(`\\[图${f.n}(?::|\\])`).test(page.text));
    const exam = classifyExamSource(page);
    if (exam.exam) page.exam = true;
    if (exam.signals.length) page.signals = exam.signals;
  } catch (err) { page.reason = (err instanceof Error ? err.message : String(err)).slice(0, 200); }
  return page;
}

/** 失败页如实记录，最多保留三页；取消后立即停止，不继续尝试剩余候选。 */
export async function collectPages(
  picks: Array<{ url: string; title: string }>, report: CollectReport, opts: PageOptions = {},
): Promise<CollectedPage[]> {
  const pages: CollectedPage[] = [];
  for (const p of picks) {
    if (pages.length >= MAX_COLLECT_PAGES || opts.signal?.aborted) break;
    const page = await fetchPage(p, Math.max(0, ...pages.flatMap((x) => x.figures.map((f) => f.n))), opts);
    report.pages.push({
      url: page.url, title: page.title, fetched: page.fetched,
      ...(page.reason ? { reason: page.reason } : {}),
      ...(page.exam ? { exam: true } : {}), ...(page.signals ? { signals: page.signals } : {}),
    });
    if (!page.fetched) continue;
    pages.push(page);
    (report.completeness ??= emptyCollectCompleteness()).figuresSeen += page.figures.length;
  }
  return pages;
}
