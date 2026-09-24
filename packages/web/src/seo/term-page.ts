/**
 * 词条页与目录页的 HTML 生成器（纯函数，构建期与测试期都只碰字符串，不碰文件系统）。
 *
 * ★ 这些 HTML 是**独立静态页**，不引 SPA 的打包产物：爬虫与关掉 JS 的访客都要能读到正文。
 *   壳（样式／head／顶栏／页脚）在 `page-shell.ts`，与更新记录页共用同一份。
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
import { ogCardForTerm, CATALOG_OG_CARD, type OgCard } from './og-card';
import { CHANGELOG_PATH } from './paths';
import { escapeHtml, pageFoot, pageHead, pageTop, type ShellLink } from './page-shell';

/** meta description：一句话定义 ＋ 一句「往下有什么」，实测控制在 90 字内 */
export function termDescription(term: PublicTerm): string {
  return `${term.oneLine}往下是它为什么有效、${term.pitfalls.length} 个常见误区和 ${term.actions.length} 件今天就能做的事。`;
}

function titleOf(term: PublicTerm): string {
  return `${term.title}${term.searchPhrase} - StudentBuddy`;
}

const TERM_NAV: ShellLink[] = [{ href: CATALOG_PATH, label: '全部词条' }];
const TERM_FOOT: ShellLink[] = [
  { href: '/', label: '回到首页' },
  { href: CATALOG_PATH, label: '全部词条' },
  { href: CHANGELOG_PATH, label: '更新记录' },
];

function headOf(title: string, desc: string, canonical: string, card: OgCard): string[] {
  return pageHead({ title, desc, canonical, card });
}

/** 生成一个词条页的完整 HTML */
export function renderTermPage(term: PublicTerm): string {
  const body: string[] = [...pageTop(TERM_NAV)];
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
  body.push(...pageFoot(TERM_FOOT));

  return [
    ...headOf(titleOf(term), termDescription(term), termUrl(term), ogCardForTerm(term)),
    ...body,
  ].join('\n');
}

/** 词条目录页（落盘为 `terms/index.html`，线上地址见 `CATALOG_PATH`）：既是人看的索引，也是爬虫的入口 */
export function renderTermIndexPage(terms: readonly PublicTerm[] = PUBLIC_TERMS): string {
  const rows = terms.map((t) => {
    return `<li><a href="${escapeHtml(termPath(t))}">${escapeHtml(t.title)}</a> — ${escapeHtml(
      t.oneLine,
    )}</li>`;
  });
  const body = [
    ...pageTop(TERM_NAV),
    '<h1>学习科学词条</h1>',
    '<p class="kw">都是学习者常听到、却很少被说清的说法。每条一页：它是什么、为什么有效、容易怎么做错。</p>',
    '<ul>',
    ...rows,
    '</ul>',
    ...pageFoot(TERM_FOOT),
  ];
  return [
    ...headOf(
      '学习科学词条目录 - StudentBuddy',
      '提取练习、间隔重复、认知负荷、元认知……每条一页讲清它是什么、为什么有效、以及最容易怎么做错。',
      CATALOG_URL,
      CATALOG_OG_CARD,
    ),
    ...body,
  ].join('\n');
}
