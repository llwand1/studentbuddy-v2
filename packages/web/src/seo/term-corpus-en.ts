/**
 * 英文词条语料的账（渠道台账 C1 英文侧 ＝ 批次 H-1）。
 *
 * ★ 为什么不复用 `term-corpus.ts` 那套类型：中文侧每一条锁都写着中文口径的东西
 *   （`productHint` 必须出现「本产品」、description 预算 105 字、alias 是英文原名），
 *   英文侧一条都不成立。**共用一个类型＝两边各写一半合法字段**，所以类型分开、
 *   而**壳／渲染层／分享卡生成器仍共用**（样式抄两遍就会漂，`page-shell.ts` 那份同理）。
 * ★ 配对关系（`zhSlug`）是**双向 `hreflang` 的唯一事实源**：只有一份，中文侧从它反查。
 *   两边各写一份就会漂，而漂了的 hreflang 不是「少了个标签」——Google 会整簇作废。
 */
import {
  CATALOG_URL,
  SITE_ORIGIN,
  findPublicTerm,
  termUrl,
  type PublicTerm,
  type TermSection,
} from './term-corpus';
import { CATALOG_PATH_EN } from './paths';
import { ENTRIES_EN } from './term-entries-en';

export interface EnglishTerm {
  /** ASCII slug，决定文件名；与中文侧同一口径（发版 tar 链路不引入编码变量） */
  slug: string;
  /** 词条名（英文），出现在 h1 与 title */
  title: string;
  /** 同族说法／提出者，画在 h1 下方一行 */
  alias: string;
  /** 对口的英文搜索意图，接在 title 的词条名后面（★ 以 `:` 起头，与中文侧的拼接方式一致） */
  searchPhrase: string;
  /** 一句话定义，同时是 meta description 的起头 */
  oneLine: string;
  sections: TermSection[];
  pitfalls: string[];
  actions: string[];
  /** 相关词条的**英文** slug；互链只在同语言内走，跨语言交给 hreflang 与页内那条中文链 */
  related: string[];
  /** 产品里对应哪一环，只描述事实 */
  productHint: string;
  /** ★ 配对的中文词条 slug；一条英文挂一条中文，中文侧凭它反查 alternate */
  zhSlug: string;
}

/** 词条页 URL 形状：`.html` 那一条与中文侧完全同因（线上 Caddy 无目录索引） */
export function termEnPath(term: EnglishTerm): string {
  return `/terms/en/${term.slug}.html`;
}

export function termEnUrl(term: EnglishTerm): string {
  return `${SITE_ORIGIN}${termEnPath(term)}`;
}

export { CATALOG_PATH_EN };

export const CATALOG_URL_EN = `${SITE_ORIGIN}${CATALOG_PATH_EN}`;

export const PUBLIC_TERMS_EN: readonly EnglishTerm[] = [...ENTRIES_EN];

export function findEnglishTerm(slug: string): EnglishTerm | undefined {
  return PUBLIC_TERMS_EN.find((t) => t.slug === slug);
}

/** 一条中文词条的英文版（没有就是 undefined——中文侧 12 条，英文侧此刻只有 6 条） */
export function englishCounterpartOf(zhSlug: string): EnglishTerm | undefined {
  return PUBLIC_TERMS_EN.find((t) => t.zhSlug === zhSlug);
}

/** 反方向：一条英文词条的中文版。★ 找不到不算「未登记」而是 bug，由 `term-en.test.ts` 拦红 */
export function chineseCounterpartOf(term: EnglishTerm): PublicTerm | undefined {
  return findPublicTerm(term.zhSlug);
}

/** 同语言内的互链邻居；挑不满两条就按目录顺序补（与中文侧同一把尺） */
export function relatedEnglishTerms(term: EnglishTerm): EnglishTerm[] {
  const picked = term.related
    .map((slug) => findEnglishTerm(slug))
    .filter((t): t is EnglishTerm => t !== undefined);
  if (picked.length >= 2) return picked.slice(0, 3);
  for (const t of PUBLIC_TERMS_EN) {
    if (picked.length >= 2) break;
    if (t.slug !== term.slug && !picked.some((p) => p.slug === t.slug)) picked.push(t);
  }
  return picked;
}

/* ---------------------------------------------------------------------------
 * 多语言版本（`hreflang`）的那一簇
 * ------------------------------------------------------------------------- */

export interface Alternate {
  hreflang: string;
  href: string;
}

export const LANG_ZH = 'zh-CN';
export const LANG_EN = 'en';

/**
 * 一条中文词条的整簇：**含它自己**。★ hreflang 要么不写，写了就得「自指＋互指」，
 *   只写对方不写自己，检索侧判整簇作废（＝两边各白做一次）。
 * ★ 没有英文版就不写这一簇（中文侧 12 条、英文侧此刻 6 条）。「只声明自己是中文」
 *   合法但什么都不解决，留着只会让下一次读这页的人以为有对应版本。
 */
export function zhAlternatesFor(term: PublicTerm): Alternate[] {
  const en = englishCounterpartOf(term.slug);
  if (!en) return [];
  return [
    { hreflang: LANG_ZH, href: termUrl(term) },
    { hreflang: LANG_EN, href: termEnUrl(en) },
  ];
}

/** 一条英文词条的整簇。★ 配不出中文页在这里是** bug 不是状态**，由 `term-en.test.ts` 拦红 */
export function enAlternatesFor(term: EnglishTerm): Alternate[] {
  const cluster: Alternate[] = [{ hreflang: LANG_EN, href: termEnUrl(term) }];
  const zh = chineseCounterpartOf(term);
  if (zh) cluster.push({ hreflang: LANG_ZH, href: termUrl(zh) });
  return cluster;
}

/** 两个目录页互为多语言版本，这一簇是完整的两条 */
export const CATALOG_ALTERNATES: readonly Alternate[] = [
  { hreflang: LANG_ZH, href: CATALOG_URL },
  { hreflang: LANG_EN, href: CATALOG_URL_EN },
];
