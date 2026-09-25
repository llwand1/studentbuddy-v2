// @vitest-environment node
/**
 * 「公开字节里不许出现内部字样」这把锁（渠道台账 C8 ＋ `docs/SEO-SPEC.md` §5 第 12 条）。
 *
 * ★ 扫的是**会被发布出去的字节**：手写的 SPA 外壳、`public/` 下的静态文件、
 *   构建期渲染出来的词条页／目录页／更新页／订阅／sitemap。
 * ★ 下面那条「不扫 `dist/`」的旧判据**已于 issue #8 撤销**，理由记在这里不删：
 *   当时的依据是「干净检出与 CI 里没有构建产物，锁在那儿等于没锁」——这话对了一半，
 *   另一半是 CI 从此**先 `npm run build` 再 `npm run check`**，产物就在场上；
 *   本地没构建时那几例显式 skip（看得见地跳过），而不是悄悄绿过去。
 *   ★ 而当初推断「压缩器会剥注释所以 bundle 干净」也被实测否掉了：注释确实剥了，
 *   字符串常量原样进 bundle（逐条账见 `public-hygiene.ts` 末段）。
 * ★ 这一批锁的来历值得留一句：它上线前从没存在过，所以「首页壳里带着 5 条施工注释」
 *   是**发版之后读线上字节**才看见的（SEO-SPEC §5 第 12 条）。
 *   ★ 本轮第一次跑它就逮到第二处：`public/robots.txt` 的注释里写着内部称呼——
 *   同一个坑，同一个原因：从来没人把「公开字节里写了什么」当判据。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_TERMS } from './term-corpus';
import { PUBLIC_TERMS_EN } from './term-corpus-en';
import { renderTermIndexPage, renderTermPage } from './term-page';
import { renderTermIndexPageEn, renderTermPageEn } from './term-page-en';
import { renderAtomFeed, renderChangelogPage } from './changelog-page';
import { renderPlanToolPage } from './plan-page';
import { renderSitemapXml } from './ssg';
import { BUNDLE_ALLOW, BUNDLE_INAPPLICABLE, INTERNAL_SHAPES, SHELL_ENTRY_EXCEPTION, bundleWordingHits, internalWordingHits } from './public-hygiene';

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

  it('★ 全部构建期渲染产物：中英两边词条页／两个目录页／更新页／订阅／计划表页／sitemap 一个都不放过', () => {
    const pages = [
      ...PUBLIC_TERMS.map((t) => renderTermPage(t)),
      renderTermIndexPage(),
      ...PUBLIC_TERMS_EN.map((t) => renderTermPageEn(t)),
      renderTermIndexPageEn(),
      renderChangelogPage(),
      renderAtomFeed(),
      renderPlanToolPage(),
      renderSitemapXml(PUBLIC_TERMS, PUBLIC_TERMS_EN),
    ];
    expect(pages.length).toBe(PUBLIC_TERMS.length + PUBLIC_TERMS_EN.length + 6);
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
      renderPlanToolPage(),
    ];
    for (const text of pages) {
      for (const raw of text.match(/href="(\/[^"]*)"/g) ?? []) {
        const href = raw.slice(6, -1);
        // ★ 扩展名那条规矩只管**落盘路径**，不管查询串：`/?ref=terms` 的 pathname 还是 `/`（SPA 壳），
        //   整串拿去配正则会把归因链误杀成「目录形式的链接」。
        const bare = href.split('?')[0] ?? href;
        if (bare === '/') continue;
        expect(/\.\w+$/.test(bare), `目录形式的链接：${href}`).toBe(true);
      }
    }
  });

  it('订阅与更新页的地址在 robots 里都开了门（默认全封，忘了加就是静默不公开）', () => {
    const robots = asset('../../public/robots.txt');
    expect(robots).toContain('Allow: /changelog/');
    expect(robots).toContain('Allow: /atom.xml');
    expect(robots).toContain('Allow: /terms/');
    expect(robots).toContain('Allow: /og/');
    // ★ 计划表页不在 /terms/ 前缀下，忘了单开一扇就是静默不公开
    expect(robots).toContain('Allow: /ebbinghaus-plan.html');
  });
});

/**
 * 构建产物那一路（issue #8）：`dist/assets/` 下那份 `.js`／`.css` 就是访客浏览器里真正跑着的字节。
 *
 * ★ 没有产物时这几例**显式跳过**（本地没跑 build 就是这样），而不是悄悄绿过去；
 *   CI 已把 `npm run build` 排在 `npm run check` 前面，那边一定在跑。
 */
interface Shipped {
  readonly name: string;
  readonly text: string;
}

function shippedBytes(): Shipped[] {
  const dir = new URL('../../dist/assets/', import.meta.url);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => ({ name: f, text: readFileSync(new URL(f, dir), 'utf8') }));
}

const SHIPPED = shippedBytes();
const HAS_DIST = SHIPPED.length > 0;

describe('公开字节 · 构建产物（JS／CSS，issue #8）', () => {
  it('★ 假 leak 必须红：加了豁免之后这一路不能变成空锁', () => {
    const fake =
      'const cfg={host:"http://127.0.0.1:8787/x",key:"sk-proj-abcdefgh",password:"hunter2hunter2"};import("docs/SEO-SPEC.md");unit="systemd";';
    const hits = bundleWordingHits(fake);
    for (const want of ['127.0.0.1', 'sk-p', 'docs/', 'systemd']) {
      expect(hits, `漏检 ${want}`).toContain(want);
    }
    // 口令写成字符串常量必须红（`password` 那个形状整体不适用，是它的替顶上来的）
    expect(hits.some((h) => h.includes('hunter2')), '口令字面值漏检').toBe(true);
    // ★ 豁免只放行那一处写法，不是整类放行：`/api/tools/` 后面接上别的东西照样红
    expect(bundleWordingHits('fetch("/api/tools/../../etc/shadow")').length, '豁免把整类放行了').toBeGreaterThan(0);
    // 反向：同一个字段名当值用是正常代码，不能被咬（咬了下一次就有人删豁免）
    expect(bundleWordingHits('a.type==="password"&&a.autoComplete==="new-password"')).toEqual([]);
  });

  it('★ 整体不适用的只有那两条，不许有人偷偷加第三条', () => {
    expect(BUNDLE_INAPPLICABLE.map((re) => re.source)).toEqual(['\\bP[012]\\b', 'password']);
  });

  it.skipIf(!HAS_DIST)('★ 真实产物：未豁免前确实带字样（钉住「bundle 本来就干净」这个偷懒前提），豁免后必须为空', () => {
    // 至少一份 JS ＋ 一份 CSS，且总量像一份真 bundle——目录空了／只剩个壳都过不了这条
    expect(SHIPPED.length, 'dist/assets 下没有 .js/.css').toBeGreaterThan(1);
    const bytes = SHIPPED.reduce((n, s) => n + s.text.length, 0);
    expect(bytes, '产物小得不像真 bundle').toBeGreaterThan(200_000);
    for (const { name, text } of SHIPPED) {
      expect(internalWordingHits(text).length, `${name} 一条都没命中，词表该重看`).toBeGreaterThan(0);
      expect(bundleWordingHits(text), `${name} 里有内部字样`).toEqual([]);
    }
  });

  it.skipIf(!HAS_DIST)('★ 豁免不许变成死的：每一条必须当场还在产物里出现（依赖升级／文案改动之后要重看）', () => {
    const all = SHIPPED.map((s) => s.text).join('\n');
    for (const a of BUNDLE_ALLOW) {
      expect(all, `豁免已失效，产物里找不到它：${a.needle}`).toContain(a.needle);
    }
  });
});
