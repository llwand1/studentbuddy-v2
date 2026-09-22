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
import { PUBLIC_TERMS } from './term-corpus';
import { escapeHtml, renderTermIndexPage, renderTermPage } from './term-page';
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
    expect(html).toContain('href="/terms/"');
  });

  it('零外部资源与零内联 style 属性（样式全在自带的那一段 <style> 里，脚本一个都不放）', () => {
    expect(html).not.toMatch(/<script/);
    // ★ 整页只允许一个 <link>，就是 canonical 自己——没有样式表、没有外部资源
    const links = html.match(/<link[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('rel="canonical"');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/ style="/);
    // ★ 只有 canonical／og:url 是绝对地址（那是它们的规定），页面里每一条可点的链接都是站内路径
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
    expect(html).toContain('<link rel="canonical" href="https://11wand.com/terms/">');
  });
});

describe('sitemap 与落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-seo-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('★ sitemap：命名空间正确、条数＝首页＋目录页＋十二条、日期是 ISO', () => {
    const xml = renderSitemapXml(PUBLIC_TERMS, new Date('2026-09-22T12:00:00Z'));
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.match(/<loc>/g)).toHaveLength(PUBLIC_TERMS.length + 2);
    expect(xml).toContain('<lastmod>2026-09-22</lastmod>');
    expect(xml).toContain('https://11wand.com/</loc>');
    expect(xml).toContain('https://11wand.com/terms/tiqu-lixian.html</loc>');
  });

  it('writeSeoPages 真的把页面写进目录，内容与渲染函数逐字一致', () => {
    const written = writeSeoPages(dir, PUBLIC_TERMS, new Date('2026-09-22T12:00:00Z'));
    expect(written).toHaveLength(PUBLIC_TERMS.length + 2);
    expect(readFileSync(join(dir, 'terms/tiqu-lixian.html'), 'utf8')).toBe(
      renderTermPage(PUBLIC_TERMS[0]!),
    );
    expect(readFileSync(join(dir, 'sitemap.xml'), 'utf8')).toContain('<urlset');
    for (const w of written) expect(w.bytes).toBeGreaterThan(200);
  });
});
