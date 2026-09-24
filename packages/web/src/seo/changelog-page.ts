/**
 * 公开更新记录页 ＋ Atom 订阅（渠道台账 C8）。
 *
 * ★ 形状与词条页同一族：独立静态文档、零脚本、关掉 JS 也读得到正文（共用 `page-shell`）。
 * ★ 内容与日期全部来自 `changelog-public.ts` 那一份手写清洗表——这里**不读**内部 `CHANGELOG.md`，
 *   也不在构建期猜版本号：没写进清洗表的东西不会出现在页面上，这条红线是结构性的。
 * ★ 这一页刻意**不进 `sitemap.xml`**：C2 的拍板是分享图只做那 14 个公开页，
 *   而 sitemap 与卡数之间没有机器绑定，所以由 `changelog.test.ts` 与 `term-page.test.ts` 各一行
 *   `not.toContain` 守着——要把这页报给爬虫，先决定它配不配图。
 *   它的被发现目前走三条路：首页静态入口、词条页与目录页页脚、订阅地址本身。
 */
import { CHANGELOG_PATH, FEED_PATH } from './paths';
import { CATALOG_PATH, SITE_ORIGIN } from './term-corpus';
import { pageFoot, pageHead, pageTop, escapeHtml, type ShellLink } from './page-shell';
import { PUBLIC_RELEASES, RELEASE_SCOPE, releaseAnchor, type ReleaseNote } from './changelog-public';

export const CHANGELOG_URL = `${SITE_ORIGIN}${CHANGELOG_PATH}`;
export const FEED_URL = `${SITE_ORIGIN}${FEED_PATH}`;

const FEED_TITLE = 'StudentBuddy 更新记录';
const FEED_DESC = '线上版每次生效的改动，一条一件可验证的事。';

/** Atom 的日期必须是完整 RFC-3339，而清洗表只记到日 ⇒ 一律 00:00Z，代价写在测试与 §7 里 */
export function feedStamp(date: string): string {
  return `${date}T00:00:00Z`;
}

function navLinks(): ShellLink[] {
  return [{ href: CATALOG_PATH, label: '全部词条' }];
}

function footLinks(): ShellLink[] {
  return [
    { href: '/', label: '回到首页' },
    { href: CATALOG_PATH, label: '全部词条' },
    { href: FEED_PATH, label: '订阅更新' },
  ];
}

function releaseSection(r: ReleaseNote): string[] {
  const items = r.items.map((x) => `<li>${escapeHtml(x)}</li>`);
  return [
    `<section class="rel" id="${escapeHtml(releaseAnchor(r.version))}">`,
    `<h2><span class="v">${escapeHtml(r.version)}</span><time datetime="${escapeHtml(r.date)}">${escapeHtml(r.date)}</time> ${escapeHtml(r.headline)}</h2>`,
    '<ul>',
    ...items,
    '</ul>',
    '</section>',
  ];
}

/** 生成更新记录页的完整 HTML */
export function renderChangelogPage(releases: readonly ReleaseNote[] = PUBLIC_RELEASES): string {
  const head = pageHead({
    title: `${FEED_TITLE} - StudentBuddy`,
    desc: FEED_DESC,
    canonical: CHANGELOG_URL,
    extraLinks: [
      `<link rel="alternate" type="application/atom+xml" title="${FEED_TITLE}" href="${FEED_PATH}">`,
    ],
  });
  return [
    ...head,
    ...pageTop(navLinks()),
    `<h1>${escapeHtml(FEED_TITLE)}</h1>`,
    `<p class="lead">${escapeHtml(RELEASE_SCOPE.lead)}</p>`,
    `<p class="note">${escapeHtml(RELEASE_SCOPE.note)}</p>`,
    ...releases.flatMap(releaseSection),
    `<p class="note">订阅：<a href="${escapeHtml(FEED_PATH)}">${escapeHtml(FEED_URL)}</a></p>`,
    ...pageFoot(footLinks()),
  ].join('\n');
}

function entryXml(r: ReleaseNote): string[] {
  const href = `${CHANGELOG_URL}#${releaseAnchor(r.version)}`;
  const stamp = feedStamp(r.date);
  return [
    '  <entry>',
    `    <title>${escapeHtml(`${r.version} ${r.headline}`)}</title>`,
    `    <link href="${escapeHtml(href)}" rel="alternate">`,
    `    <id>${escapeHtml(href)}</id>`,
    `    <updated>${stamp}</updated>`,
    `    <published>${stamp}</published>`,
    `    <summary>${escapeHtml(r.items.join(' '))}</summary>`,
    '  </entry>',
  ];
}

/** Atom 订阅（落盘 `/atom.xml`）：条目与页面同源、同一份清洗表 */
export function renderAtomFeed(releases: readonly ReleaseNote[] = PUBLIC_RELEASES): string {
  const newest = releases[0];
  if (!newest) throw new Error('PUBLIC_RELEASES 为空 ⇒ 订阅没有可发的条目，这一版不该上线');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeHtml(FEED_TITLE)}</title>`,
    `  <subtitle>${escapeHtml(FEED_DESC)}</subtitle>`,
    `  <link href="${escapeHtml(CHANGELOG_URL)}" rel="alternate">`,
    `  <link href="${escapeHtml(FEED_URL)}" rel="self">`,
    `  <id>${escapeHtml(FEED_URL)}</id>`,
    `  <updated>${feedStamp(newest.date)}</updated>`,
    '  <author><name>StudentBuddy</name></author>',
    ...releases.flatMap(entryXml),
    '</feed>',
    '',
  ].join('\n');
}
