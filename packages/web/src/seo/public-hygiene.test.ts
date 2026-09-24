// @vitest-environment node
/**
 * 「公开字节里不许出现内部字样」这把锁（渠道台账 C8 ＋ `docs/SEO-SPEC.md` §5 第 12 条）。
 *
 * ★ 扫的是**会被发布出去的四类字节**：手写的 SPA 外壳、`public/` 下的静态文件、
 *   构建期渲染出来的词条页／目录页／更新页／订阅／sitemap。
 *   不扫 `dist/`——干净检出与 CI 里没有构建产物，锁在那儿等于没锁（同族教训见批次 G-1）。
 * ★ 这一批锁的来历值得留一句：它上线前从没存在过，所以「首页壳里带着 5 条施工注释」
 *   是**发版之后读线上字节**才看见的（SEO-SPEC §5 第 12 条）。
 *   ★ 本轮第一次跑它就逮到第二处：`public/robots.txt` 的注释里写着内部称呼——
 *   同一个坑，同一个原因：从来没人把「公开字节里写了什么」当判据。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_TERMS } from './term-corpus';
import { PUBLIC_TERMS_EN } from './term-corpus-en';
import { renderTermIndexPage, renderTermPage } from './term-page';
import { renderTermIndexPageEn, renderTermPageEn } from './term-page-en';
import { renderAtomFeed, renderChangelogPage } from './changelog-page';
import { renderSitemapXml } from './ssg';
import { INTERNAL_SHAPES, SHELL_ENTRY_EXCEPTION, internalWordingHits } from './public-hygiene';

const asset = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** 会被原样拷进 dist 的静态文件（`public/` 下除了图片） */
const PUBLIC_STATIC_FILES = ['../../public/robots.txt', '../../public/favicon.svg'];

describe('公开字节 · 内部字样红线', () => {
  it('★ 词表本身不是空的：喂一段真会漏的写法必须命中（否则锁形同虚设）', () => {
    const leaky = '详见 docs/SEO-SPEC.md，跑 npm run og:shots 重新生成，服务在 :18791，由 systemd 管';
    const hits = internalWordingHits(leaky);
    for (const want of ['docs/', 'npm run', ':18791', 'systemd']) {
      expect(hits.some((h) => want.includes(h) || h.includes(want)), `漏检 ${want}`).toBe(true);
    }
    expect(INTERNAL_SHAPES.length).toBeGreaterThan(20);
  });

  it('★ 第五组（拉丁写法）不是空锁：英文页里带出仓内文件名或命令名必须红', () => {
    const leakyEn =
      'See AGENTS.md for the release plan, run npm run build, and check test-plan.md plus the worktree.';
    const hits = internalWordingHits(leakyEn);
    for (const want of ['AGENTS.md', 'npm', 'test-plan', 'worktree']) {
      expect(hits.some((h) => h.includes(want)), `漏检 ${want}`).toBe(true);
    }
    // ★ 反向也要成立：正常的讲解文案不能被这把锁咬到（咬到了下一次就有人拆锁）
    expect(
      internalWordingHits(
        'Spaced repetition spreads the same material over widening gaps, so each review lands before it is gone.',
      ),
    ).toEqual([]);
  });

  it('手写的 SPA 外壳：零 HTML 注释，且不含内部字样', () => {
    const shell = asset('../../index.html');
    // ★ 注释是这一条的原始由来：vite 构建不剥 HTML 注释，写进去的就是发出去的
    expect(shell).not.toContain('<!--');
    // 白名单只放行 vite 那一句入口脚本，且整份文件里至多出现一次
    const occurrences = shell.split(SHELL_ENTRY_EXCEPTION).length - 1;
    expect(occurrences).toBe(1);
    expect(internalWordingHits(shell, [SHELL_ENTRY_EXCEPTION])).toEqual([]);
  });

  it('`public/` 下的静态文件同样过这一关（robots.txt 是全站被抓的第一份字节）', () => {
    for (const rel of PUBLIC_STATIC_FILES) {
      expect(internalWordingHits(asset(rel)), `${rel} 里有内部字样`).toEqual([]);
    }
  });

  it('★ 全部构建期渲染产物：中英两边词条页／两个目录页／更新页／订阅／sitemap 一个都不放过', () => {
    const pages = [
      ...PUBLIC_TERMS.map((t) => renderTermPage(t)),
      renderTermIndexPage(),
      ...PUBLIC_TERMS_EN.map((t) => renderTermPageEn(t)),
      renderTermIndexPageEn(),
      renderChangelogPage(),
      renderAtomFeed(),
      renderSitemapXml(PUBLIC_TERMS, PUBLIC_TERMS_EN),
    ];
    expect(pages.length).toBe(PUBLIC_TERMS.length + PUBLIC_TERMS_EN.length + 5);
    pages.forEach((text, i) => {
      expect(internalWordingHits(text), `第 ${i} 份渲染产物里有内部字样`).toEqual([]);
    });
  });

  it('公开页面上不许有目录形式的链接（点了兜成空壳）', () => {
    const pages = [
      ...PUBLIC_TERMS.map(renderTermPage),
      renderTermIndexPage(),
      ...PUBLIC_TERMS_EN.map(renderTermPageEn),
      renderTermIndexPageEn(),
      renderChangelogPage(),
    ];
    for (const text of pages) {
      for (const raw of text.match(/href="(\/[^"]*)"/g) ?? []) {
        const href = raw.slice(6, -1);
        if (href === '/') continue;
        expect(/\.\w+$/.test(href), `目录形式的链接：${href}`).toBe(true);
      }
    }
  });

  it('订阅与更新页的地址在 robots 里都开了门（默认全封，忘了加就是静默不公开）', () => {
    const robots = asset('../../public/robots.txt');
    expect(robots).toContain('Allow: /changelog/');
    expect(robots).toContain('Allow: /atom.xml');
    expect(robots).toContain('Allow: /terms/');
    expect(robots).toContain('Allow: /og/');
  });
});
