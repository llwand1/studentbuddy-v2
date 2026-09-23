/**
 * 词条页的 HTML 生成器（纯函数，构建期与测试期都只碰字符串，不碰文件系统）。
 *
 * ★ 这些 HTML 是**独立静态页**，不引 SPA 的打包产物：爬虫与关掉 JS 的访客都要能读到正文。
 * 因此页面自带一段极小的样式，除本站链接外不放任何外部资源。
 */
import {
  CATALOG_PATH,
  CATALOG_URL,
  PUBLIC_TERMS,
  relatedTerms,
  termPath,
  termUrl,
  type PublicTerm,
} from './term-corpus';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** meta description：一句话定义 ＋ 一句「往下有什么」，实测控制在 90 字内 */
export function termDescription(term: PublicTerm): string {
  return `${term.oneLine}往下是它为什么有效、${term.pitfalls.length} 个常见误区和 ${term.actions.length} 件今天就能做的事。`;
}

function titleOf(term: PublicTerm): string {
  return `${term.title}${term.searchPhrase} - StudentBuddy`;
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
footer { color: #6b7280; font-size: .88rem; padding-bottom: 2.5rem; }
`;

function head(title: string, desc: string, canonical: string): string {
  const t = escapeHtml(title);
  const d = escapeHtml(desc);
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    '<meta property="og:type" content="article">',
    `<meta property="og:site_name" content="StudentBuddy">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    '<meta name="twitter:card" content="summary">',
    `<style>${CSS}</style>`,
    '</head>',
  ].join('\n');
}

function topBar(): string {
  return [
    '<body>',
    '<header class="top">',
    '<a class="brand" href="/">StudentBuddy</a>',
    `<nav><a href="${CATALOG_PATH}">全部词条</a></nav>`,
    '</header>',
    '<main>',
  ].join('\n');
}

function footBar(): string {
  return [
    '</main>',
    '<footer>',
    '<p>StudentBuddy：把学过的东西抽成词条，再让它自己长出复习、出题与讲解。',
    '数据存在自己手里（本地安装包或自己的服务器）。</p>',
    `<p><a href="/">回到首页</a> · <a href="${CATALOG_PATH}">全部词条</a></p>`,
    '</footer>',
    '</body>',
    '</html>',
  ].join('\n');
}

/** 生成一个词条页的完整 HTML */
export function renderTermPage(term: PublicTerm): string {
  const body: string[] = [topBar()];
  body.push(`<h1>${escapeHtml(term.title)}</h1>`);
  body.push(`<p class="alias">${escapeHtml(term.alias)}</p>`);
  body.push(`<p class="lead">${escapeHtml(term.oneLine)}</p>`);

  term.sections.forEach((sec) => {
    body.push(`<h2>${escapeHtml(sec.h)}</h2>`);
    sec.p.forEach((para) => body.push(`<p>${escapeHtml(para)}</p>`));
  });

  body.push('<h2>常见误区</h2>');
  body.push('<ul>');
  term.pitfalls.forEach((x) => body.push(`<li>${escapeHtml(x)}</li>`));
  body.push('</ul>');

  body.push('<h2>今天就能做的</h2>');
  body.push('<ol>');
  term.actions.forEach((x) => body.push(`<li>${escapeHtml(x)}</li>`));
  body.push('</ol>');

  body.push('<section class="related"><h2>接着读</h2><ul>');
  relatedTerms(term).forEach((r) => {
    body.push(
      `<li><a href="${escapeHtml(termPath(r))}">${escapeHtml(r.title)}</a> — ${escapeHtml(r.oneLine)}</li>`,
    );
  });
  body.push('</ul></section>');

  body.push('<aside class="cta">');
  body.push('<h2>这一条在 StudentBuddy 里落在哪一环</h2>');
  body.push(`<p>${escapeHtml(term.productHint)}</p>`);
  body.push('<a href="/">看看怎么用</a>');
  body.push('</aside>');
  body.push(footBar());

  return [head(titleOf(term), termDescription(term), termUrl(term)), ...body].join('\n');
}

/** 词条目录页（落盘为 `terms/index.html`，线上地址见 `CATALOG_PATH`）：既是人看的索引，也是爬虫的入口 */
export function renderTermIndexPage(terms: readonly PublicTerm[] = PUBLIC_TERMS): string {
  const rows = terms.map((t) => {
    return `<li><a href="${escapeHtml(termPath(t))}">${escapeHtml(t.title)}</a> — ${escapeHtml(
      t.oneLine,
    )}</li>`;
  });
  const body = [
    topBar(),
    '<h1>学习科学词条</h1>',
    '<p class="kw">都是学习者常听到、却很少被说清的说法。每条一页：它是什么、为什么有效、容易怎么做错。</p>',
    '<ul>',
    ...rows,
    '</ul>',
    footBar(),
  ];
  return [
    head(
      '学习科学词条目录 - StudentBuddy',
      '提取练习、间隔重复、认知负荷、元认知……每条一页讲清它是什么、为什么有效、以及最容易怎么做错。',
      CATALOG_URL,
    ),
    ...body,
  ].join('\n');
}
