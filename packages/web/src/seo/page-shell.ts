/**
 * 公开静态页共用的那一层壳（样式＋head＋顶栏＋页脚）。
 *
 * ★ 为什么单开一层：词条页／目录页／更新页是**三个独立文档**，不引 SPA 产物（爬虫与关 JS
 *   的访客都要能读到正文）。共用一层壳是为了让「品牌那句话说的是什么」「站内怎么回」只有一份，
 *   而不是三份各自抄一遍——抄一遍就漂一次。
 * ★ 这一层的输出**逐字是公网字节**，所以这里不放施工叙述；写规矩请到 `docs/SEO-SPEC.md`。
 *   同一族红线由 `public-hygiene.ts` 那把锁守着。
 */
import { ogImageMetaLines, type OgCard } from './og-card';

export interface ShellLink {
  href: string;
  label: string;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f7f8fa; color: #1c1f24;
  font: 16px/1.85 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
a { color: #2f5fd0; text-decoration: none; }
a:hover { text-decoration: underline; }
.top, main, footer { max-width: 44rem; margin: 0 auto; padding: 0 1.25rem; }
.top { display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding-top: 1.25rem; }
.brand { font-weight: 600; letter-spacing: .01em; }
.top nav a { font-size: .95rem; opacity: .75; }
main { background: #fff; border: 1px solid #e6e8ec; border-radius: 14px;
  padding: 2rem 1.9rem 2.4rem; margin: 1.4rem auto 2rem; }
h1 { font-size: 1.75rem; line-height: 1.35; margin: 0 0 .35rem; }
.alias { margin: 0 0 1.4rem; color: #6b7280; font-size: .95rem; }
.lead { font-size: 1.06rem; background: #f2f5fb; border-left: 3px solid #2f5fd0;
  padding: .85rem 1rem; border-radius: 0 8px 8px 0; margin: 0 0 1.9rem; }
h2 { font-size: 1.18rem; margin: 2rem 0 .6rem; }
p { margin: .55rem 0; }
ul, ol { margin: .5rem 0 0; padding-left: 1.4rem; }
li { margin: .4rem 0; }
.kw { color: #6b7280; font-size: .9rem; margin: 0 0 .6rem; }
.related ul { list-style: none; padding: 0; display: grid; gap: .5rem; }
.cta { margin-top: 2.4rem; padding-top: 1.4rem; border-top: 1px dashed #dfe2e8; }
.cta h2 { margin-top: 0; font-size: 1.05rem; }
.cta a { display: inline-block; margin-top: .7rem; padding: .5rem .95rem;
  background: #2f5fd0; color: #fff; border-radius: 8px; font-size: .95rem; }
.rel { padding-top: 1.2rem; margin-top: 1.2rem; border-top: 1px solid #eceef2; }
.rel:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.rel h2 { display: flex; flex-wrap: wrap; align-items: baseline; gap: .6rem;
  margin: 0 0 .3rem; font-size: 1.1rem; }
.rel h2 .v { font-variant-numeric: tabular-nums; }
.rel h2 time { color: #6b7280; font-size: .85rem; font-weight: 400; }
.note { color: #6b7280; font-size: .9rem; }
footer { color: #6b7280; font-size: .88rem; padding-bottom: 2.5rem; }
`;

/** 页脚上面那句产品话——三个公开页共用，改一次三处同步 */
export const FOOT_LINE =
  'StudentBuddy：把学过的东西抽成词条，再让它自己长出复习、出题与讲解。数据存在自己手里（本地安装包或自己的服务器）。';

/** 英文侧那一句（批次 H-1）。★ 不是中文句的对译：这一句要的是「这站干什么」，两种语言各自说清楚 */
export const FOOT_LINE_EN =
  'StudentBuddy turns what you have studied into terms, then lets those terms grow their own reviews, quizzes and explanations. The data stays in your hands — a local install or your own server.';

export interface HeadOptions {
  title: string;
  desc: string;
  canonical: string;
  /** 有卡就吐 `og:image` 那四行；没卡就一行都不加（更新页此刻没有自己的分享卡） */
  card?: OgCard | null;
  /** canonical 之外还允许哪几条 link（目前只有更新页的 atom 自动发现） */
  extraLinks?: readonly string[];
  /** ★ `<html lang>` 的值。中文侧不传就是 `zh-CN`；英文侧必须传 `en`——语言声明写错，检索侧按中文页排 */
  lang?: string;
  /**
   * 多语言版本（批次 H-1）。★ 每一条都要含本页自己：hreflang 簇要**互相且自指**，
   * 只写对方不写自己，Google 判整簇作废——所以这里给的是全簇，不是「别人」。
   */
  alternates?: readonly { hreflang: string; href: string }[];
}

/** hreflang 行；一簇都没有就一行都不吐（更新页此刻是单语，不需要假装有多语） */
export function hreflangLines(
  alternates: readonly { hreflang: string; href: string }[] | undefined,
): string[] {
  if (!alternates || alternates.length === 0) return [];
  return alternates.map(
    (a) => `<link rel="alternate" hreflang="${escapeHtml(a.hreflang)}" href="${escapeHtml(a.href)}">`,
  );
}

export function pageHead(o: HeadOptions): string[] {
  const t = escapeHtml(o.title);
  const d = escapeHtml(o.desc);
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(o.lang ?? 'zh-CN')}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    `<link rel="canonical" href="${escapeHtml(o.canonical)}">`,
    ...hreflangLines(o.alternates),
    '<meta property="og:type" content="article">',
    `<meta property="og:site_name" content="StudentBuddy">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${escapeHtml(o.canonical)}">`,
    ...(o.card ? ogImageMetaLines(o.card) : []),
    ...(o.extraLinks ?? []),
    `<style>${CSS}</style>`,
    '</head>',
  ];
}

export function pageTop(nav: readonly ShellLink[]): string[] {
  return [
    '<body>',
    '<header class="top">',
    '<a class="brand" href="/">StudentBuddy</a>',
    `<nav>${nav.map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`).join(' · ')}</nav>`,
    '</header>',
    '<main>',
  ];
}

export function pageFoot(links: readonly ShellLink[], line: string = FOOT_LINE): string[] {
  return [
    '</main>',
    '<footer>',
    `<p>${escapeHtml(line)}</p>`,
    `<p>${links
      .map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`)
      .join(' · ')}</p>`,
    '</footer>',
    '</body>',
    '</html>',
  ];
}
