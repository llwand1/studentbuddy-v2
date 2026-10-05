/**
 * search/exam-direct — 题源站「站内直达」取候选页（应试模式第二层，契约 EXAM-MODE-SPEC §4）。
 *
 * 为什么要有这一层（都是 2026-10-04 本机出网实测出来的）：
 *  · 免 key 兜底的 Bing 通道**不理 `site:` 操作符**——带 `site:zujuan.xkw.com` 与不带，
 *    返回的 10 条几乎逐条相同 ⇒ 「查询时限定域」这条路不存在；
 *  · 只能后置过滤，但 11 个应试主题共 88 条命中里落在白名单内的 33 条，下钻之后
 *    **只有 1 条能抽出完整题目**（其余是百科、新闻、JS 壳页）。
 *  ⇒ 白名单要真能提升出题质量，必须绕开通用引擎、直接打题源站自己的检索入口。
 *    本件干的就是这一段：检索页 → 同域结果链接 → 交给 `learning/collect.ts` 照常抓正文与摘题。
 *
 * ★ 端点全部来自 `@sb/shared` 的 `EXAM_SOURCES[].direct`，每行带 `verifiedAt`——
 *   这是外部依赖，站改版即过期，不在仓内写死第二份 URL，也不在本文件里猜 URL。
 * 单站失败（403/超时/JS 壳）一律跳过、不阻断：实测 gk100 与 med66 都有详情页 403 的反爬。
 */
import { examHostAllowed } from '@sb/shared';
import type { ExamDirectHit } from '../learning/exam-mode.js';
import { fetchPageText } from './page-text.js';
import type { SearchResult } from './types.js';

/** 一次最多打几个站的检索页（每站一次 HTTP，站多即慢；6 站是「够出题」与「不拖出题」的折中） */
export const MAX_DIRECT_SITES = 6;
/** 每站最多留几条候选链接（检索页首屏之外多半是导航） */
export const MAX_DIRECT_LINKS_PER_SITE = 6;
/** 总候选上限（`collect.ts` 的抓页上限是 3 页，这里给排序留挑选余地） */
export const MAX_DIRECT_TOTAL = 18;

/** 题页特征：链接文字或路径里出现这些才算题目页，否则会把「关于我们」当成候选 */
const EXAM_HINT =
  /(真题|试题|试卷|题库|答案|解析|模拟|历年|考试|专题|复习|zhenti|shiti|shijuan|tiku|question|problem|paper|exam|lianshi|gkst)/i;

/** 明显不是内容页的链接（导航、登录、下载壳、锚点） */
const SKIP_HREF =
  /^(?:javascript:|#|mailto:|tel:|\/$)|\/(?:login|register|about|help|contact|download|app|cart|user|member|sitemap|search|so)\/?(?:\?|$)|\.(?:css|js|png|jpg|jpeg|gif|svg|ico|webp|zip|pdf|apk)(?:\?|$)/i;

function anchorText(inner: string): string {
  return inner
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/**
 * 从一张检索结果页里挑同域题页链接（纯函数，零 IO ⇒ 可在测试里逐条锁）。
 * 判据顺序即防线：能解析 → 不是壳链 → 落在白名单内 → 有考试特征 → 不是本页自己。
 */
export function directLinksOf(html: string, baseUrl: string, hosts: readonly string[]): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  let self: URL;
  try {
    self = new URL(baseUrl);
  } catch {
    return out;
  }
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']{2,600})["'][^>]*>([\s\S]{0,300}?)<\/a>/gi)) {
    const rawHref = m[1]!;
    // ★ 壳链判据要**同时**量原始 href 与解析后的绝对地址：`href="#x"` 解析后就变成检索页自己，
    //   只比绝对地址会让锚点链绕过 `SKIP_HREF`（2026-10-04 写测试时当场逮到）。
    if (SKIP_HREF.test(rawHref) || SKIP_HREF.test(urlOf(rawHref, self.href) ?? '')) continue;
    let url = '';
    try {
      url = new URL(rawHref, baseUrl).href;
    } catch {
      continue;
    }
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (SKIP_HREF.test(url)) continue;
    if (!examHostAllowed(url, hosts)) continue;
    const title = anchorText(m[2] ?? '');
    // 没有锚文本的链接（图标链、空 `<a>`）留不下标题，进参考资料列表就是给用户一条看不见名的链接 ⇒ 丢
    if (!title) continue;
    if (!EXAM_HINT.test(`${title} ${u.pathname}`)) continue;
    // 检索页自身：同源同路径（带不带 query 都算同一个页面）
    if (u.origin === self.origin && u.pathname === self.pathname) continue;
    const key = url.split('#')[0] ?? url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url: key, snippet: '', source: 'direct' });
    if (out.length >= MAX_DIRECT_LINKS_PER_SITE) break;
  }
  return out;
}

/** 安全解析：解不出来返回 null（不抛，纯函数要在脏 HTML 上稳定） */
function urlOf(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * 站内直达：逐站打检索页、取候选链接。
 * 返回的条目 `snippet` 恒为空串——这一层只负责**找到该抓哪一页**，正文与摘题仍由
 * `learning/collect.ts` 干（verbatim 锁在那里，别在这条支路上再建一套出题通道）。
 */
export async function examDirectPages(
  queries: readonly ExamDirectHit[],
  hosts: readonly string[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ links: SearchResult[]; failed: string[]; sites: string[] }> {
  const picked = queries.slice(0, MAX_DIRECT_SITES);
  const failed: string[] = [];
  const sites: string[] = [];
  const links: SearchResult[] = [];
  const seen = new Set<string>();
  const settled = await Promise.allSettled(
    picked.map(async (hit) => ({ hit, page: await fetchPageText(hit.url, { signal: opts.signal, timeoutMs: opts.timeoutMs }) })),
  );
  for (const r of settled) {
    if (r.status === 'rejected') {
      failed.push(`站内直达: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      continue;
    }
    const { hit, page } = r.value;
    if (!page.ok) {
      // 「壳页」与「取不到」分开记：前者说明这个站的检索结果是 JS 渲染的（换端点也没用），后者说明反爬或超时
      const why = page.kind === 'empty' ? '无正文（JS 渲染）' : page.kind === 'not_page' ? page.what : page.reason;
      failed.push(`${hit.label}: ${why}`);
      continue;
    }
    const found = directLinksOf(page.html, hit.url, hosts);
    if (found.length > 0) sites.push(hit.label);
    for (const link of found) {
      if (seen.has(link.url) || links.length >= MAX_DIRECT_TOTAL) continue;
      seen.add(link.url);
      links.push(link);
    }
  }
  return { links, failed, sites };
}
