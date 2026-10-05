/** 应试补充检索的词法相关度：与文档检索共用分词，不把「面试/真题」这类导航词当主题。 */
import { examUrlAllowed, tokenizeForFts } from '@sb/shared';
import { htmlToText } from './bing-channel.js';
import type { SearchResult } from './types.js';

export function examTopicQuery(query: string): string {
  const topic = query.replace(/学习资料|面试题|练习题|工程师|技能要求|岗位职责|搜一下|搜一搜|找一下|搜索|面试|真题|试题|题库|答案|解析|资料|参考|什么|如何|普通|传统|最新|区别|\bvs\b/gi, ' ').trim();
  // 有具体考点时，不让「高考英语」这类整页导航词遮住「定语从句」；只有科目时仍保留范围词。
  const focused = topic.replace(/高考|中考|考研|初中|高中|小学|初[一二三]|高[一二三]/g, ' ').replace(/\s+/g, ' ').trim();
  return focused.replace(/\s/g, '').length > 2 ? focused : topic;
}

export function topicScore(text: string, query: string): number {
  const words = new Set(tokenizeForFts(text));
  return [...new Set(tokenizeForFts(query))].filter((w) => words.has(w)).length;
}

/** 只给发现链接排序，不据此判正文命中；栏目语义解决 HashMap 找不到「集合」入口的问题。 */
export function topicLinkScore(text: string, query: string): number {
  const section = /\b(?:hashmap|concurrenthashmap|arraylist|hashset|treemap)\b/i.test(query)
    ? /集合|collection|hashmap/i
    : /线程池|拒绝策略|核心线程|\bthreadpool\b/i.test(query) ? /并发|concurrent|\/juc\b|线程池/i : null;
  return topicScore(text, query) + (section?.test(text) ? 6 : 0);
}

/** 英文主题（如 Java / AI）必须都在片段里；中文至少命中足够词元，防「并发」把 Go 页带进 Java 查询。 */
export function relevantTopicText(text: string, query: string): boolean {
  const wanted = [...new Set(tokenizeForFts(query))];
  const words = new Set(tokenizeForFts(text));
  const english = wanted.filter((w) => /^[a-z]/.test(w));
  const chinese = wanted.filter((w) => !/^[a-z]/.test(w));
  return wanted.length > 0 && english.every((w) => words.has(w))
    && chinese.filter((w) => words.has(w)).length >= Math.min(2, chinese.length)
    && wanted.filter((w) => words.has(w)).length >= Math.min(wanted.length, Math.max(3, Math.ceil(wanted.length / 3)));
}

/** 培训报名和购买页面不是本次学习依据，关键词再多也不算正文资料。 */
export function studyPageAllowed(title: string, url: string): boolean {
  return !/私教|训练营|辅导报名|课程购买|求职辅导|付费课程|sijiao|(?:^|[/_])offer(?:[._/]|$)/i.test(`${title} ${url}`);
}

export function questionPage(title: string, url: string): boolean {
  return /\/(?:question|interview)\/|concurrent-questions/.test(url)
    || /[?？]|专项|习题|试题|试卷|真题/.test(title);
}

export function directoryPage(title: string, url: string): boolean {
  return /\/pdd\/album\/|\/banks\/?(?:\?|$)|\/(?:tags|categories|archives)\//.test(url)
    || /共0份|题库分类|题库大全|下载汇总/.test(title);
}

/** 明确点名一种语言时，不拿其它语言的专页充当命中；跨语言比较查询仍可保留双方资料。 */
export function conflictingLanguage(text: string, query: string): boolean {
  const languages = (s: string): string[] => [...new Set((s.toLowerCase().match(/\bc\+\+(?!\w)|\b(?:java|python|golang|go)\b/g) ?? [])
    .map((w) => w === 'golang' ? 'go' : w))];
  const wanted = languages(query);
  const named = languages(text);
  return wanted.length === 1 && named.length > 0 && !named.includes(wanted[0]!);
}

/** 仅从已经读过的页面发现同范围链接；按主题排序，禁止猜 URL 或无限爬取。 */
export function topicLinksOf(html: string, base: string, hosts: readonly string[], query: string): SearchResult[] {
  const seen = new Set<string>([base.split('#')[0] ?? base]);
  const out: Array<SearchResult & { score: number }> = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']{1,600})["'][^>]*>([\s\S]{0,500}?)<\/a>/gi)) {
    const href = m[1]!;
    if (/^(?:#|javascript:|mailto:|tel:)/i.test(href)) continue;
    try {
      const url = new URL(href.replace(/&amp;/g, '&'), base);
      url.hash = '';
      if (!examUrlAllowed(url.href, hosts) || seen.has(url.href)) continue;
      if (/\/(?:login|register|search|so|about|contact)(?:\/|\?|$)|\.(?:pdf|zip|png|jpe?g|svg|js|css)(?:\?|$)/i.test(url.href)) continue;
      const title = htmlToText(m[2] ?? '').slice(0, 120);
      const score = topicLinkScore(`${title} ${decodeURIComponent(url.pathname)}`, query);
      if (!title || score === 0 || !studyPageAllowed(title, url.href) || conflictingLanguage(`${title} ${url.href}`, query)) continue;
      seen.add(url.href);
      out.push({ title, url: url.href, snippet: '', source: 'entry', score });
    } catch { /* 脏链接跳过；外部 HTML 不是可信输入。 */ }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4).map(({ score: _score, ...hit }) => hit);
}
