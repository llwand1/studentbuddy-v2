// @vitest-environment node
/**
 * 英文侧的锁（批次 H-1＝渠道 C1 英文侧）。
 *
 * ★ 这一批最想要的不是「英文页长什么样」，而是**配对闭合**：中英两边靠 `zhSlug` 一份表连起来，
 *   而 `hreflang` 的规则是「要么不写，写了必须自指＋互指」。所以这里每条互指判据都是**双向跑**的：
 *   从中文页找英文、从英文页找中文，两边地址必须互相算得出同一个值。
 * ★ 第二想拦的是「只有英文页、没有入口」：爬虫进不来就等于没做。⇒ 手写 SPA 外壳里那一条
 *   静态 `<a>`（不执行 JS 也抓得到）单独锁一次，且它必须落得出盘。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CATALOG_PATH, PUBLIC_TERMS, termPath, termUrl, type PublicTerm } from './term-corpus';
import {
  CATALOG_PATH_EN,
  PUBLIC_TERMS_EN,
  englishCounterpartOf,
  findEnglishTerm,
  relatedEnglishTerms,
  termEnPath,
  termEnUrl,
  zhAlternatesFor,
  type EnglishTerm,
} from './term-corpus-en';
import { renderTermIndexPage, renderTermPage } from './term-page';
import { renderTermIndexPageEn, renderTermPageEn, termDescriptionEn } from './term-page-en';
import { renderSitemapXml, writeSeoPages } from './ssg';
import { escapeHtml } from './page-shell';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const shell = (): string => readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

describe('英文语料 · 形状', () => {
  it('六条齐备，slug 唯一且纯 ASCII；★ 且不与中文侧的 slug 撞（撞了＝两张卡抢同一个 PNG 文件名）', () => {
    expect(PUBLIC_TERMS_EN.length).toBeGreaterThan(0);
    const slugs = PUBLIC_TERMS_EN.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(SLUG_RE);
    const zh = new Set(PUBLIC_TERMS.map((t) => t.slug));
    for (const s of slugs) expect(zh.has(s), `slug 与中文侧撞了：${s}`).toBe(false);
    expect(new Set(PUBLIC_TERMS_EN.map((t) => t.title)).size).toBe(PUBLIC_TERMS_EN.length);
  });

  it('每条填得够一页：≥2 小节、每节 ≥2 段、每段是一句完整英文、3 误区、3 动作、产品落点非空', () => {
    for (const t of PUBLIC_TERMS_EN) {
      expect(t.sections.length, t.slug).toBeGreaterThanOrEqual(2);
      for (const sec of t.sections) {
        expect(sec.p.length, `${t.slug}/${sec.h}`).toBeGreaterThanOrEqual(2);
        for (const p of sec.p) {
          expect(p.length, `${t.slug}/${sec.h}`).toBeGreaterThan(60);
          expect(/[.!?]$/.test(p.trim()), `${t.slug}/${sec.h} 段落没收尾`).toBe(true);
        }
      }
      expect(t.pitfalls, t.slug).toHaveLength(3);
      expect(t.actions, t.slug).toHaveLength(3);
      expect(t.productHint.length, t.slug).toBeGreaterThan(30);
      expect(t.searchPhrase.startsWith(':'), t.slug).toBe(true);
    }
  });

  it('★ 互链只在英文侧走：related 全部指得出去，且 2～3 条', () => {
    for (const t of PUBLIC_TERMS_EN) {
      for (const r of t.related) expect(findEnglishTerm(r), `${t.slug} → ${r}`).toBeDefined();
      expect(t.related.length, t.slug).toBeGreaterThanOrEqual(2);
      expect(t.related.length, t.slug).toBeLessThanOrEqual(3);
      expect(relatedEnglishTerms(t).some((r) => r.slug === t.slug), t.slug).toBe(false);
    }
  });

  it('URL 形状带 .html（无扩展名线上兜成 SPA 壳），canonical 是绝对地址', () => {
    for (const t of PUBLIC_TERMS_EN) {
      expect(termEnPath(t)).toBe(`/terms/en/${t.slug}.html`);
      expect(termEnUrl(t)).toBe(`https://11wand.com${termEnPath(t)}`);
    }
    expect(CATALOG_PATH_EN).toBe('/terms/en/index.html');
  });

  it('★ description 有预算：搜索引擎掐掉的部分不该由运气决定（英文按 160 字符）', () => {
    for (const t of PUBLIC_TERMS_EN) {
      const d = termDescriptionEn(t);
      expect(d.length, t.slug).toBeLessThanOrEqual(160);
      expect(d.startsWith(t.oneLine), t.slug).toBe(true);
    }
  });
});

describe('中英配对 · hreflang 必须双向闭合', () => {
  it('★ 每条英文都配得到一条真实中文词条（`zhSlug` 写错＝这一簇静默少一半）', () => {
    for (const t of PUBLIC_TERMS_EN) {
      const zh = PUBLIC_TERMS.find((x) => x.slug === t.zhSlug);
      expect(zh, `${t.slug} 的 zhSlug 指不到中文词条`).toBeDefined();
    }
  });

  it('★ 一对一：没有两条英文挂同一条中文（挂了同一条＝两个 canonical 互称自己）', () => {
    const zs = PUBLIC_TERMS_EN.map((t) => t.zhSlug);
    expect(new Set(zs).size).toBe(zs.length);
  });

  it('★ 两边的 alternate 逐字互指：中文页里的英文地址＝英文页的 canonical，反过来也是', () => {
    for (const en of PUBLIC_TERMS_EN) {
      const zh = PUBLIC_TERMS.find((x) => x.slug === en.zhSlug) as PublicTerm;
      const zhHtml = renderTermPage(zh);
      const enHtml = renderTermPageEn(en);
      expect(zhHtml, zh.slug).toContain(
        `<link rel="alternate" hreflang="en" href="${termEnUrl(en)}">`,
      );
      expect(enHtml, en.slug).toContain(
        `<link rel="alternate" hreflang="zh-CN" href="${termUrl(zh)}">`,
      );
      // 自指那一条也在（只写对方不写自己，检索侧判整簇作废）
      expect(zhHtml, zh.slug).toContain(`hreflang="zh-CN" href="${termUrl(zh)}"`);
      expect(enHtml, en.slug).toContain(`hreflang="en" href="${termEnUrl(en)}"`);
    }
  });

  it('★ 没配英文版的中文页一条 hreflang 都不写（写了就是声明一个不存在的版本）', () => {
    const unpaired = PUBLIC_TERMS.filter((t) => !englishCounterpartOf(t.slug));
    expect(unpaired.length).toBeGreaterThan(0);
    for (const t of unpaired) {
      expect(zhAlternatesFor(t)).toEqual([]);
      expect(renderTermPage(t)).not.toContain('hreflang');
    }
  });

  it('两个目录页互为多语言版本（各 2 条 alternate，两边都在簇里）', () => {
    const zh = renderTermIndexPage();
    const en = renderTermIndexPageEn();
    expect(zh).toContain(`hreflang="en" href="https://11wand.com${CATALOG_PATH_EN}"`);
    expect(en).toContain(`hreflang="zh-CN" href="https://11wand.com${CATALOG_PATH}"`);
    for (const [html, self] of [
      [zh, CATALOG_PATH],
      [en, CATALOG_PATH_EN],
    ] as const) {
      expect(html.match(/rel="alternate" hreflang="/g) ?? []).toHaveLength(2);
      expect(html).toContain(`rel="canonical" href="https://11wand.com${self}"`);
    }
  });

  it('★ 人看得见的语言切换也在：英文页顶栏链它的中文页，配了英文的中文页顶栏链回去', () => {
    for (const en of PUBLIC_TERMS_EN) {
      const zh = PUBLIC_TERMS.find((x) => x.slug === en.zhSlug) as PublicTerm;
      expect(renderTermPageEn(en)).toContain(`href="${termPath(zh)}"`);
      expect(renderTermPage(zh)).toContain(`href="${termEnPath(en)}"`);
    }
  });
});

describe('英文页 · 单页形状', () => {
  const t = PUBLIC_TERMS_EN[0]!;
  const html = renderTermPageEn(t);

  it('独立文档：doctype／★ lang="en"／charset／viewport 齐，正文四块不缺', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(`<h1>${t.title}</h1>`);
    expect(html).toContain('<h2>Common mistakes</h2>');
    expect(html).toContain('<h2>Things you can try today</h2>');
    expect(html).toContain('<h2>Where this lives in StudentBuddy</h2>');
    for (const x of [...t.pitfalls, ...t.actions, t.productHint]) expect(html).toContain(escapeHtml(x));
  });

  it('★ title 与 description 在**全部 18 页**里唯一（中英共用一套 title 空间，重复了爬虫按一页排）', () => {
    const titles = [
      ...PUBLIC_TERMS.map((x) => renderTermPage(x)),
      ...PUBLIC_TERMS_EN.map((x) => renderTermPageEn(x)),
    ].map((h) => h.match(/<title>([^<]*)<\/title>/)?.[1]);
    expect(new Set(titles).size).toBe(titles.length);
    const descs = [
      ...PUBLIC_TERMS.map((x) => renderTermPage(x)),
      ...PUBLIC_TERMS_EN.map((x) => renderTermPageEn(x)),
    ].map((h) => h.match(/name="description" content="([^"]*)"/)?.[1]);
    expect(new Set(descs).size).toBe(descs.length);
  });

  it('零脚本、恰好一条 canonical、其余 `<link>` 全是 hreflang、零外部资源、可点的链接全在站内', () => {
    expect(html).not.toMatch(/<script/);
    const links = html.match(/<link[^>]*>/g) ?? [];
    expect(links.filter((l) => l.includes('rel="canonical"'))).toHaveLength(1);
    for (const l of links) {
      expect(
        l.includes('rel="canonical"') ||
          /^<link rel="alternate" hreflang="[A-Za-z-]+" href="https:\/\/11wand\.com\/[^"]*">$/.test(l),
        l,
      ).toBe(true);
    }
    expect(html).not.toMatch(/rel="stylesheet"/);
    expect(html).not.toMatch(/src="https?:/);
    for (const a of html.match(/<a [^>]*href="([^"]*)"/g) ?? []) {
      expect(a).not.toMatch(/href="https?:/);
    }
  });

  it('★ 语料里混进标签时按文本渲染（英文文案带引号与撇号是常态，转义不能只在中文侧验）', () => {
    const dirty: EnglishTerm = {
      ...PUBLIC_TERMS_EN[0]!,
      title: '<script>bad()</script>',
      oneLine: `a"b'c<>`,
      productHint: '<img src=x onerror=alert(1)>',
    };
    const out = renderTermPageEn(dirty);
    expect(out).not.toContain('<script>bad()');
    expect(out).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(out).not.toContain('<img src=x');
  });
});

describe('英文侧的入口与落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-seo-en-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('★ 手写的 SPA 外壳里有英文目录页那一跳，且它落得出盘（没有入口＝英文侧白做）', () => {
    const hrefs = [...shell().matchAll(/<a href="(\/[^"]*)">/g)].map((m) => m[1]!);
    expect(hrefs).toContain(CATALOG_PATH_EN);
    const files = new Set(
      writeSeoPages(dir, PUBLIC_TERMS, PUBLIC_TERMS_EN, new Date('2026-09-24T12:00:00Z')).map(
        (w) => `/${w.rel}`,
      ),
    );
    for (const href of hrefs) expect(files.has(href), `静态入口 ${href} 没有落盘文件`).toBe(true);
  });

  it('那条静态入口仍待在 `hidden` 容器里（漏成可见＝一次没登记的视觉改动）', () => {
    const nav = shell().match(/<nav\b[^>]*>[\s\S]*?<\/nav>/);
    expect(nav, 'index.html 里那条静态入口 nav 被删了').not.toBeNull();
    expect(nav![0]).toContain('hidden');
    expect(nav![0]).toContain(CATALOG_PATH_EN);
  });

  it('英文页里每条 `/terms/` 链接都有对应落盘文件；sitemap 含全部英文地址', () => {
    const files = new Set(
      writeSeoPages(dir, PUBLIC_TERMS, PUBLIC_TERMS_EN, new Date('2026-09-24T12:00:00Z')).map(
        (w) => `/${w.rel}`,
      ),
    );
    for (const html of [...PUBLIC_TERMS_EN.map(renderTermPageEn), renderTermIndexPageEn()]) {
      for (const raw of html.match(/href="(\/terms\/[^"]*)"/g) ?? []) {
        const href = raw.slice(6, -1);
        expect(files.has(href), `链接 ${href} 没有落盘文件`).toBe(true);
      }
    }
    const xml = renderSitemapXml(PUBLIC_TERMS, PUBLIC_TERMS_EN);
    for (const t of PUBLIC_TERMS_EN) expect(xml, t.slug).toContain(`${termEnUrl(t)}</loc>`);
  });

  it('英文目录页把六条全列出来，每条带一句定义', () => {
    const html = renderTermIndexPageEn();
    for (const t of PUBLIC_TERMS_EN) {
      expect(html).toContain(termEnPath(t));
      expect(html).toContain(escapeHtml(t.title));
    }
  });
});

describe('英文语料 · 诚实红线（与中文侧同源，但必须用英文再写一遍）', () => {
  const allText = JSON.stringify(PUBLIC_TERMS_EN);

  it('★ 不写使用量／人数／评价（真实计数未上线，写一个就是造假）', () => {
    expect(allText).not.toMatch(/\d+\s*(students?|users?|learners?|people)\b/i);
    expect(allText).not.toMatch(/thousands|millions of|countless\b/i);
    expect(allText).not.toMatch(/(loved|trusted|recommended|chosen) by\b/i);
    expect(allText).not.toMatch(/(5|five)[- ]star|top[- ]rated|\d+(\.\d+)?\/5|rating/i);
  });

  it('★ 不许诺效果：机制可以讲，疗效不能讲；★ 也不许编研究数字', () => {
    expect(allText).not.toMatch(/guarantee| guaranteed| guarantees/i);
    expect(allText).not.toMatch(/(boost|improve|double)\s+your\s+(memory|grades?|score|retention)/i);
    expect(allText).not.toMatch(/remember everything|never forget|\b100%\b/i);
    expect(allText).not.toMatch(/\d+(\.\d+)?%\s*(of|more)/i);
  });

  it('产品落点只描述机制，不冒充第三方背书', () => {
    for (const t of PUBLIC_TERMS_EN) {
      expect(t.productHint, t.slug).toMatch(/StudentBuddy/);
      expect(t.productHint, t.slug).not.toMatch(/students (everywhere|worldwide)|\bjoin\b|thousands/i);
    }
  });
});
