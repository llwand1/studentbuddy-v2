// @vitest-environment node
/**
 * 词条页 HTML 的生成锁（渲染层：标题唯一／canonical 绝对／转义／互链／落盘）。
 *
 * ★ 这批页面**没有 React、没有运行时**，所以能锁的就该全锁掉：
 *   构建产物长什么样，爬虫看到的就是什么。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CATALOG_PATH, PUBLIC_TERMS } from './term-corpus';
import { PUBLIC_TERMS_EN } from './term-corpus-en';
import { renderTermIndexPage, renderTermPage } from './term-page';
import { escapeHtml } from './page-shell';
import { CHANGELOG_PATH, FEED_PATH } from './paths';
import { renderSitemapXml, writeSeoPages } from './ssg';

describe('词条页 · 单页形状', () => {
  const t = PUBLIC_TERMS[0]!;
  const html = renderTermPage(t);

  it('是一个完整独立文档：doctype＋lang＋charset＋viewport 齐', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('★ 每页 title 与 description 都不同（同一个 title ＝ 爬虫眼里十四页是一个页面）', () => {
    const titles = PUBLIC_TERMS.map((x) => renderTermPage(x).match(/<title>([^<]*)<\/title>/)?.[1]);
    const descs = PUBLIC_TERMS.map((x) => renderTermPage(x).match(/name="description" content="([^"]*)"/)?.[1]);
    expect(new Set(titles).size).toBe(PUBLIC_TERMS.length);
    expect(new Set(descs).size).toBe(PUBLIC_TERMS.length);
    expect(titles[0]).toContain(t.title);
    expect(titles[0]).toContain(t.searchPhrase);
  });

  it('canonical 是绝对地址且指向自己那页；og:url 与它同值', () => {
    expect(html).toContain('<link rel="canonical" href="https://11wand.com/terms/tiqu-lixian.html">');
    expect(html).toContain('<meta property="og:url" content="https://11wand.com/terms/tiqu-lixian.html">');
  });

  it('正文四块齐：h1＝词条名、每节标题、误区与动作各一条不少、产品落点在', () => {
    expect(html).toContain(`<h1>${t.title}</h1>`);
    for (const sec of t.sections) expect(html).toContain(`<h2>${sec.h}</h2>`);
    expect(html).toContain('<h2>常见误区</h2>');
    expect(html).toContain('<h2>今天就能做的</h2>');
    for (const p of t.pitfalls) expect(html).toContain(p);
    for (const a of t.actions) expect(html).toContain(a);
    expect(html).toContain(t.productHint);
  });

  it('★ 互链指向同批页面且带扩展名（不给爬虫留 404），并有一条回首页的路', () => {
    for (const r of t.related) expect(html).toContain(`href="/terms/${r}.html"`);
    expect(html).toContain('href="/"');
    expect(html).toContain(`href="${CATALOG_PATH}"`);
  });

  it('★ 一条「目录形式」的链接都不留（线上实测 /terms/ 兜成 SPA 壳，点了读不到正文）', () => {
    for (const page of [...PUBLIC_TERMS.map(renderTermPage), renderTermIndexPage()]) {
      for (const href of page.match(/href="(\/[^"]*)"/g) ?? []) {
        expect(href).not.toBe('href="/terms/"');
        expect(href).not.toMatch(/\/terms\/$/);
      }
    }
  });

  it('零外部资源与零内联 style 属性（样式全在自带的那一段 <style> 里，脚本一个都不放）', () => {
    expect(html).not.toMatch(/<script/);
    // ★ 批次 H-1 之前这一条锁的是「整页只有一个 <link>＝canonical」。现在合法的多了 hreflang，
    //   所以判据换成形状：**恰好一条 canonical，其余全是 hreflang**，别的一律不许（样式表／外部资源）
    const links = html.match(/<link[^>]*>/g) ?? [];
    const canonicals = links.filter((l) => l.includes('rel="canonical"'));
    expect(canonicals).toHaveLength(1);
    for (const l of links) {
      expect(
        l.includes('rel="canonical"') || /^<link rel="alternate" hreflang="[A-Za-z-]+" href="https:\/\/11wand\.com\/[^"]*">$/.test(l),
        `不在允许形状里的 <link>：${l}`,
      ).toBe(true);
    }
    expect(html).not.toMatch(/rel="stylesheet"/);
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/ style="/);
    // ★ 只有 canonical／og:url／hreflang 是绝对地址（那是它们的规定），页面里每一条可点的链接都是站内路径
    for (const href of html.match(/<a [^>]*href="([^"]*)"/g) ?? []) {
      expect(href).not.toMatch(/href="https?:/);
    }
  });
});

describe('词条页 · 转义', () => {
  it('★ 语料里出现尖括号与引号时按文本渲染，不当标签', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;',
    );
    const dirty = { ...PUBLIC_TERMS[0]!, title: '<script>bad()</script>', oneLine: 'a"b\'c<&>' };
    const html = renderTermPage(dirty);
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).not.toMatch(/content="[^"]*"[^>]*a"/);
  });
});

describe('词条目录页', () => {
  it('十二条全部列出，每行带一句定义', () => {
    const html = renderTermIndexPage();
    for (const t of PUBLIC_TERMS) {
      expect(html).toContain(`/terms/${t.slug}.html`);
      expect(html).toContain(t.title);
    }
    expect(html).toContain('<link rel="canonical" href="https://11wand.com/terms/index.html">');
  });

  it('★ 目录页 URL 与线上真吐得出内容的那一个同形（带 .html）', () => {
    expect(CATALOG_PATH).toBe('/terms/index.html');
  });
});

describe('sitemap 与落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-seo-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('★ sitemap：命名空间正确、条数＝首页＋中英两个目录页＋两边全部词条页＋计划表页、日期是 ISO', () => {
    const xml = renderSitemapXml(PUBLIC_TERMS, PUBLIC_TERMS_EN, new Date('2026-09-22T12:00:00Z'));
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.match(/<loc>/g)).toHaveLength(
      PUBLIC_TERMS.length + PUBLIC_TERMS_EN.length + 4,
    );
    expect(xml).toContain('<lastmod>2026-09-22</lastmod>');
    expect(xml).toContain('https://11wand.com/</loc>');
    expect(xml).toContain('https://11wand.com/terms/tiqu-lixian.html</loc>');
    // ★ 目录页进 sitemap 的必须是带扩展名那一个：报 `/terms/` 等于请爬虫来收 SPA 壳
    expect(xml).toContain('https://11wand.com/terms/index.html</loc>');
    expect(xml).not.toContain('https://11wand.com/terms/</loc>');
    // ★ 英文侧同一条规矩：目录形式（`/terms/en/`）不进，进的是 `/terms/en/index.html`
    expect(xml).toContain('https://11wand.com/terms/en/index.html</loc>');
    expect(xml).not.toContain('https://11wand.com/terms/en/</loc>');
    expect(xml).toContain('https://11wand.com/terms/en/spaced-repetition.html</loc>');
    // ★ 更新页刻意**不在** sitemap 里：C2 的拍板是分享图只做公开词条页那一族，而 sitemap 与卡数
    //   之间没有机器绑定 ⇒ 这一格由下面这两行 not.toContain 守着：要加进来先决定它配不配图。
    expect(xml).not.toContain(CHANGELOG_PATH);
  });

  it('★ 词条页与目录页页脚都链向更新页（清洗后的公开面要被现有公开页带出来）', () => {
    for (const html of [...PUBLIC_TERMS.map(renderTermPage), renderTermIndexPage()]) {
      expect(html).toContain(`href="${CHANGELOG_PATH}"`);
    }
  });

  /** 手写的 SPA 外壳（不执行 JS 的抓取器看到的就是这一份字节） */
  const shell = () => readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

  it('★ 首页给不执行 JS 的抓取器留了一跳：静态 `<a>` 的地址＝`CATALOG_PATH`，并声明 sitemap', () => {
    expect(shell()).toContain(`href="${CATALOG_PATH}"`);
    expect(shell()).toContain('rel="sitemap"');
  });

  it('★ 那一跳必须待在 `hidden` 容器里（一旦可见＝一次没登记的视觉改动）', () => {
    const nav = shell().match(/<nav\b[^>]*>[\s\S]*?<\/nav>/);
    expect(nav, 'index.html 里那条静态入口 nav 被删了').not.toBeNull();
    expect(nav![0]).toContain('hidden');
    expect(nav![0]).toContain(`href="${CATALOG_PATH}"`);
  });

  it('★ 每条指向词条页的链接都有对应落盘文件（URL 与文件同形，上线才有内容可吐）', () => {
    const written = writeSeoPages(dir, PUBLIC_TERMS, PUBLIC_TERMS_EN, new Date('2026-09-22T12:00:00Z'));
    const files = new Set(written.map((w) => `/${w.rel}`));
    for (const html of [...PUBLIC_TERMS.map(renderTermPage), renderTermIndexPage()]) {
      for (const raw of html.match(/href="(\/terms\/[^"]*)"/g) ?? []) {
        const href = raw.slice(6, -1);
        expect(files.has(href), `链接 ${href} 没有落盘文件`).toBe(true);
      }
    }
    expect(files.has(CATALOG_PATH)).toBe(true);
  });

  it('★ 手写的 SPA 外壳里每一条静态链接都落得出盘（拼错一个字就是一条死链）', () => {
    const files = new Set(
      writeSeoPages(dir, PUBLIC_TERMS, PUBLIC_TERMS_EN, new Date('2026-09-22T12:00:00Z')).map((w) => `/${w.rel}`),
    );
    const hrefs = [...shell().matchAll(/<a href="(\/[^"]*)">/g)].map((m) => m[1]!);
    // 外壳里那条 hidden nav 是唯一给爬虫的静态入口，一条都不能是空的
    expect(hrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of hrefs) expect(files.has(href), `静态入口 ${href} 没有落盘文件`).toBe(true);
  });

  it('writeSeoPages 真的把页面写进目录，内容与渲染函数逐字一致', () => {
    const written = writeSeoPages(dir, PUBLIC_TERMS, PUBLIC_TERMS_EN, new Date('2026-09-22T12:00:00Z'));
    // 中英全部词条页 ＋ 两个目录页 ＋ 更新页 ＋ 订阅 ＋ 计划表页 ＋ sitemap（此刻 12＋6＋6＝**24 件**）
    expect(written).toHaveLength(PUBLIC_TERMS.length + PUBLIC_TERMS_EN.length + 6);
    expect(readFileSync(join(dir, 'terms/tiqu-lixian.html'), 'utf8')).toBe(
      renderTermPage(PUBLIC_TERMS[0]!),
    );
    expect(readFileSync(join(dir, 'sitemap.xml'), 'utf8')).toContain('<urlset');
    const rels = new Set(written.map((w) => `/${w.rel}`));
    expect(rels.has(CHANGELOG_PATH)).toBe(true);
    expect(rels.has(FEED_PATH)).toBe(true);
    for (const w of written) expect(w.bytes).toBeGreaterThan(200);
  });
});
