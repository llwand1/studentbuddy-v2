/**
 * 英文词条页与英文目录页的 HTML 生成器（批次 H-1＝渠道 C1 英文侧）。
 *
 * ★ 与 `term-page.ts` 一样是纯函数：构建期与测试期只碰字符串，不碰文件系统。
 * ★ 壳仍共用 `page-shell.ts` 那一份。★ 这里刻意**不复制一份中文渲染器**：两边文案、语言、
 *   配对各不同，但「head 长什么样、页脚那句话挂在哪个标签里」漂一次就是两份公开字节漂一次。
 */
import { CHANGELOG_PATH, CATALOG_PATH } from './paths';
import {
  CATALOG_ALTERNATES,
  CATALOG_PATH_EN,
  CATALOG_URL_EN,
  PUBLIC_TERMS_EN,
  chineseCounterpartOf,
  relatedEnglishTerms,
  termEnPath,
  termEnUrl,
  enAlternatesFor,
  LANG_EN,
  type EnglishTerm,
} from './term-corpus-en';
import { termPath } from './term-corpus';
import { ogCardForTermEn, CATALOG_EN_OG_CARD } from './og-card';
import { escapeHtml, FOOT_LINE_EN, pageFoot, pageHead, pageTop, type ShellLink } from './page-shell';

/** meta description：一句话定义 ＋ 一句「往下有什么」。★ 预算与中文侧不同，见 `term-en.test.ts` */
export function termDescriptionEn(term: EnglishTerm): string {
  return `${term.oneLine} Plus why it works, ${term.pitfalls.length} mistakes and ${term.actions.length} things to try.`;
}

function titleOf(term: EnglishTerm): string {
  return `${term.title}${term.searchPhrase} - StudentBuddy`;
}

function navOf(term: EnglishTerm): ShellLink[] {
  const zh = chineseCounterpartOf(term);
  const nav: ShellLink[] = [{ href: CATALOG_PATH_EN, label: 'All terms' }];
  // ★ 人看得见的那条语言切换。hreflang 只有爬虫读，双语访客要的是页面上的一跳
  if (zh) nav.push({ href: termPath(zh), label: '中文' });
  return nav;
}

const EN_FOOT: ShellLink[] = [
  { href: '/', label: 'Home' },
  { href: CATALOG_PATH_EN, label: 'All terms' },
  { href: CATALOG_PATH, label: '中文词条' },
  { href: CHANGELOG_PATH, label: 'Changelog (in Chinese)' },
];

/** 生成一个英文词条页的完整 HTML */
export function renderTermPageEn(term: EnglishTerm): string {
  const body: string[] = [...pageTop(navOf(term))];
  body.push(`<h1>${escapeHtml(term.title)}</h1>`);
  body.push(`<p class="alias">${escapeHtml(term.alias)}</p>`);
  body.push(`<p class="lead">${escapeHtml(term.oneLine)}</p>`);

  term.sections.forEach((sec) => {
    body.push(`<h2>${escapeHtml(sec.h)}</h2>`);
    sec.p.forEach((para) => body.push(`<p>${escapeHtml(para)}</p>`));
  });

  body.push('<h2>Common mistakes</h2>');
  body.push('<ul>');
  term.pitfalls.forEach((x) => body.push(`<li>${escapeHtml(x)}</li>`));
  body.push('</ul>');

  body.push('<h2>Things you can try today</h2>');
  body.push('<ol>');
  term.actions.forEach((x) => body.push(`<li>${escapeHtml(x)}</li>`));
  body.push('</ol>');

  body.push('<section class="related"><h2>Read next</h2><ul>');
  relatedEnglishTerms(term).forEach((r) => {
    body.push(
      `<li><a href="${escapeHtml(termEnPath(r))}">${escapeHtml(r.title)}</a> — ${escapeHtml(r.oneLine)}</li>`,
    );
  });
  body.push('</ul></section>');

  body.push('<aside class="cta">');
  body.push('<h2>Where this lives in StudentBuddy</h2>');
  body.push(`<p>${escapeHtml(term.productHint)}</p>`);
  body.push('<a href="/">See how it works</a>');
  body.push('</aside>');
  body.push(...pageFoot(EN_FOOT, FOOT_LINE_EN));

  return [
    ...pageHead({
      title: titleOf(term),
      desc: termDescriptionEn(term),
      canonical: termEnUrl(term),
      lang: LANG_EN,
      card: ogCardForTermEn(term),
      alternates: [...enAlternatesFor(term)],
    }),
    ...body,
  ].join('\n');
}

/** 英文目录页（落盘为 `terms/en/index.html`）：既是索引，也是爬虫进英文侧的那一跳 */
export function renderTermIndexPageEn(
  terms: readonly EnglishTerm[] = PUBLIC_TERMS_EN,
): string {
  const rows = terms.map(
    (t) =>
      `<li><a href="${escapeHtml(termEnPath(t))}">${escapeHtml(t.title)}</a> — ${escapeHtml(
        t.oneLine,
      )}</li>`,
  );
  const body = [
    ...pageTop([{ href: CATALOG_PATH, label: '中文目录' }]),
    '<h1>Learning science terms</h1>',
    '<p class="kw">Concepts learners keep hearing and rarely get explained. One page each: what it is, why it works, how it goes wrong.</p>',
    '<ul>',
    ...rows,
    '</ul>',
    ...pageFoot(EN_FOOT, FOOT_LINE_EN),
  ];
  return [
    ...pageHead({
      title: 'Learning science terms - StudentBuddy',
      desc: 'Spaced repetition, retrieval practice, the forgetting curve, interleaving, cognitive load and the Feynman technique — one page each, in plain language.',
      canonical: CATALOG_URL_EN,
      lang: LANG_EN,
      card: CATALOG_EN_OG_CARD,
      alternates: [...CATALOG_ALTERNATES],
    }),
    ...body,
  ].join('\n');
}
