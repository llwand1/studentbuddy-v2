/**
 * 公开词条语料（SEO 长尾页的唯一事实源）。
 *
 * ★ 这些页面是**给人读的静态讲解页**，不是产品数据的投影，因此：
 *   ① 内容里**不写任何用户数／使用量**（真实计数批未上线前，写一个数字就是造假）；
 *   ② 不引用任何真实账号的词条（`term_library` 里全是私有数据）；
 *   ③ 与产品的连接只说「产品里有哪一环」，不承诺效果。
 * 三条都由 `term-corpus.test.ts` 锁着，不靠自觉。
 */
import { ENTRIES_A } from './term-entries-a';
import { ENTRIES_B } from './term-entries-b';
import { CATALOG_PATH } from './paths';

export interface TermSection {
  /** 小节标题 */
  h: string;
  /** 小节正文（每段一句到三句） */
  p: string[];
}

export interface PublicTerm {
  /** ASCII 拼音 slug，决定文件名；禁用非 ASCII（发版 tar 链路不想再引入编码变量） */
  slug: string;
  /** 词条名（中文），出现在 h1 与 title */
  title: string;
  /** 别名／英文原名，画在 h1 下方一行 */
  alias: string;
  /** 这一页对口的搜索意图，用于 title 后半段 */
  searchPhrase: string;
  /** 一句话定义，同时是 meta description 的起头 */
  oneLine: string;
  sections: TermSection[];
  /** 常见误区（学生真实会踩的，不写稻草人） */
  pitfalls: string[];
  /** 可执行动作（学生视角，今天就能做） */
  actions: string[];
  /** 相关词条 slug，页内互链用 */
  related: string[];
  /** 产品里对应哪一环，只描述事实 */
  productHint: string;
}

/** 线上站点绝对前缀；canonical／sitemap／互链都从它拼 */
export const SITE_ORIGIN = 'https://11wand.com';

/** 词条页 URL 形状：带 `.html` 才走线上 Caddy 的静态文件通道（实测无扩展名一律兜成 SPA 壳） */
export function termPath(term: PublicTerm): string {
  return `/terms/${term.slug}.html`;
}

export function termUrl(term: PublicTerm): string {
  return `${SITE_ORIGIN}${termPath(term)}`;
}

/**
 * 目录页路径：值在 `seo/paths`，SPA 侧与构建侧共用同一份常量。
 * 这里转出只是为了 `termUrl` 那批地址都在同一个模块里拼齐。
 */
export { CATALOG_PATH };

/** 目录页的绝对地址（canonical 与 sitemap 用） */
export const CATALOG_URL = `${SITE_ORIGIN}${CATALOG_PATH}`;

export const PUBLIC_TERMS: readonly PublicTerm[] = [...ENTRIES_A, ...ENTRIES_B];

export function findPublicTerm(slug: string): PublicTerm | undefined {
  return PUBLIC_TERMS.find((t) => t.slug === slug);
}

/** 给相关词条挑得出链接的邻居；不足三条时按目录顺序补 */
export function relatedTerms(term: PublicTerm): PublicTerm[] {
  const picked = term.related
    .map((slug) => findPublicTerm(slug))
    .filter((t): t is PublicTerm => t !== undefined);
  if (picked.length >= 2) return picked.slice(0, 3);
  for (const t of PUBLIC_TERMS) {
    if (picked.length >= 2) break;
    if (t.slug !== term.slug && !picked.some((p) => p.slug === t.slug)) picked.push(t);
  }
  return picked;
}
