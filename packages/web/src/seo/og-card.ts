/**
 * 社交分享卡（`og:image`）的 HTML 生成器 ＋ 那批图的地址账。
 *
 * ★ 为什么是「截图」而不是「构建期现画」：社交平台只认一张**位图 URL**，而本仓的构建机与 CI
 *   都没有浏览器（`npm run build` 只做 vite 打包）。所以正路是**本机真机截图 → PNG 当静态资源提交**，
 *   构建只负责把 `public/og/*.png` 原样拷进 `dist/`。重新生成一条命令：`npm run og:shots`
 *   （见 `tools/probes/og-card-cdp.mts`，它同时量「有没有内容被静默裁掉」）。
 * ★ 版式由老板 2026-09-23 从三版真机候选里点名（A 纸面卡 ＋ 底部两行都保留）。
 *   选它的理由也一并记下：**与站点同一套 token**（浅色、品牌蓝是唯一强调色），而不是另一张脸。
 * ★ 卡片文案三条纪律与词条页同源（SEO-SPEC §4）：不写使用量数字、不许诺效果、不引用真实用户。
 *   底部那行「N 个常见误区 · N 件今天就能做的事」是**语料字段的实算长度**，不是使用量。
 */
import { CATALOG_PATH, PUBLIC_TERMS, SITE_ORIGIN, termPath, type PublicTerm } from './term-corpus';

/** 卡片尺寸：1200×630 是各平台通用的 1.91:1（小于这个数会被拉伸，大于则被裁） */
export const OG_CARD_W = 1200;
export const OG_CARD_H = 630;

/** 站内目录：PNG 落在这里，构建原样拷进 dist 根 */
export const OG_DIR_PATH = '/og/';

export interface OgCard {
  /** 决定 PNG 文件名，纯 ASCII（与词条 slug 同一口径，发版 tar 链路不引入编码变量） */
  slug: string;
  /** 品牌行右侧的小标，说明这是哪一类页 */
  kicker: string;
  /** 大字标题（词条名／页名） */
  title: string;
  /** 大字下面那行：别名／副标 */
  alias: string;
  /** 一句话定义，最多两行（预算由 `og-card.test.ts` 的字号预算锁守着） */
  lead: string;
  /** 底部左：往下有什么 */
  itemsLine: string;
  /** 底部右：站内地址（★ 纯文本、不带协议——卡片里不放任何可点资源，也不给外部 URL） */
  urlLine: string;
  /** `og:image:alt`：给读屏与平台兜底用，描述图里有什么 */
  alt: string;
}

/** 词条页的卡：文案全从语料派生，一个字都不另写（另写一份就会漂） */
export function ogCardForTerm(term: PublicTerm): OgCard {
  return {
    slug: term.slug,
    kicker: '学习科学词条',
    title: term.title,
    alias: term.alias,
    lead: term.oneLine,
    itemsLine: `往下：它为什么有效 · ${term.pitfalls.length} 个常见误区 · ${term.actions.length} 件今天就能做的事`,
    urlLine: hostless(`${SITE_ORIGIN}${termPath(term)}`),
    alt: `StudentBuddy 词条卡：${term.title}。${term.oneLine}`,
  };
}

/** 目录页的卡 */
export const CATALOG_OG_CARD: OgCard = {
  slug: 'terms-index',
  kicker: '学习科学词条 · 目录',
  title: '学习科学词条',
  alias: `${PUBLIC_TERMS.length} 条常听到却很少被说清的说法，一条一页`,
  lead: '每条一页讲三件事：它到底是什么、为什么会有效、以及最容易怎么做错。',
  itemsLine: '往下：十二条各自的讲解页，页内互链',
  urlLine: hostless(`${SITE_ORIGIN}${CATALOG_PATH}`),
  alt: `StudentBuddy 学习科学词条目录：${PUBLIC_TERMS.length} 条，一条一页`,
};

/** 首页（落地页）的卡 */
export const HOME_OG_CARD: OgCard = {
  slug: 'home',
  kicker: '以词条为中心的学习助手',
  title: 'StudentBuddy',
  alias: '学过的东西抽成词条，词条自己长出复习、出题、概念图与总结',
  lead: '本地安装包或自己的服务器都能跑——数据存在自己手里。',
  itemsLine: '往下：免注册直接体验，不必先给邮箱',
  urlLine: hostless(SITE_ORIGIN),
  alt: 'StudentBuddy：以词条为中心的学习助手，学练析忆反馈一条闭环',
};

/** 全部卡片：首页 ＋ 目录页 ＋ 每个词条页 ⇒ 与 sitemap 的 14 条 `<loc>` 一一对应 */
export const ALL_OG_CARDS: readonly OgCard[] = [
  HOME_OG_CARD,
  CATALOG_OG_CARD,
  ...PUBLIC_TERMS.map(ogCardForTerm),
];

/** `https://11wand.com/terms/x.html` → `11wand.com/terms/x.html`（卡片上不出现可点的绝对地址） */
function hostless(absolute: string): string {
  return absolute.replace(/^https?:\/\//, '');
}

export function ogImageName(card: OgCard): string {
  return `${card.slug}.png`;
}

/** 站内相对地址：写进 `og:image` 与页面 HTML 的是同一个形状 */
export function ogImagePath(card: OgCard): string {
  return `${OG_DIR_PATH}${ogImageName(card)}`;
}

export function ogImageUrl(card: OgCard): string {
  return `${SITE_ORIGIN}${ogImagePath(card)}`;
}

/**
 * 一个页面的 og/twitter meta 行。
 *
 * ★ `og:image` 必须是**绝对地址**（平台爬虫没有「相对谁」的概念），而 `twitter:card` 要从
 *   `summary` 升到 `summary_large_image`——不升的话平台按小缩略图排，1200×630 的卡会被压成方块。
 */
export function ogImageMetaLines(card: OgCard): string[] {
  return [
    `<meta property="og:image" content="${ogImageUrl(card)}">`,
    `<meta property="og:image:width" content="${OG_CARD_W}">`,
    `<meta property="og:image:height" content="${OG_CARD_H}">`,
    `<meta property="og:image:alt" content="${escapeAttr(card.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
  ];
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 卡片自带的那段样式。★ 与 `tokens.css` 同源的那几个值直接写死在这里：
 * 这张图是一次性产物，引真 token 表就得在截图时跑 vite，得不偿失；
 * 漂了的代价由 `og-card.test.ts` 的颜色锁挡（它逐个比对 tokens.css 现值）。
 */
const CARD_CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${OG_CARD_W}px; height: ${OG_CARD_H}px; overflow: hidden; }
body { font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  color: #1e2433; background: #ffffff; -webkit-font-smoothing: antialiased; }
.frame { width: ${OG_CARD_W}px; height: ${OG_CARD_H}px; padding: 64px 72px;
  display: flex; flex-direction: column; background: #ffffff; position: relative; }
.frame::after { content: ""; position: absolute; left: 0; top: 0;
  width: 10px; height: ${OG_CARD_H}px; background: #007aff; }
.brand { display: flex; align-items: center; gap: 14px; }
.chip { width: 40px; height: 40px; border-radius: 10px; background: #007aff; color: #ffffff;
  font-size: 24px; font-weight: 700; display: grid; place-items: center; }
.bname { font-size: 22px; font-weight: 600; letter-spacing: .01em; }
.bkicker { font-size: 19px; color: #9aa1b0; padding-left: 14px; border-left: 1px solid rgba(30, 40, 60, 0.10); }
h1 { font-size: 104px; line-height: 1.12; font-weight: 700; letter-spacing: .01em; margin-top: 44px; }
.alias { font-size: 26px; color: #6b7385; margin-top: 14px; }
.lead { font-size: 31px; line-height: 1.62; color: #1e2433; margin-top: 34px;
  border-left: 5px solid #007aff; padding: 6px 0 6px 26px; max-width: 1000px; }
.foot { margin-top: auto; display: flex; align-items: baseline; justify-content: space-between; gap: 24px; }
.items { font-size: 21px; color: #6b7385; }
.url { font-size: 21px; color: #9aa1b0; letter-spacing: .02em; }
`;

/** 生成一张卡的独立 HTML（只给截图脚本用，不进 dist、不进 sitemap） */
export function renderOgCardHtml(card: OgCard): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeAttr(card.title)}</title>`,
    `<style>${CARD_CSS}</style>`,
    '</head>',
    '<body>',
    '<div class="frame">',
    '<div class="brand"><span class="chip">S</span><span class="bname">StudentBuddy</span>' +
      `<span class="bkicker">${escapeAttr(card.kicker)}</span></div>`,
    `<h1>${escapeAttr(card.title)}</h1>`,
    `<p class="alias">${escapeAttr(card.alias)}</p>`,
    `<p class="lead">${escapeAttr(card.lead)}</p>`,
    '<div class="foot">',
    `<span class="items">${escapeAttr(card.itemsLine)}</span>`,
    `<span class="url">${escapeAttr(card.urlLine)}</span>`,
    '</div>',
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');
}
