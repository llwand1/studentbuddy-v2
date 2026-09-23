// @vitest-environment node
/**
 * 社交分享卡（`og:image`）的锁。
 *
 * ★ 本批最想要的一条是**第 4 组「图真的在」**：`og:image` 指向一张不存在的 PNG，平台不会报错，
 *   只会渲染出一张空卡——和 SEO-SPEC §5 第 9 条那个「错地址也返 200」的 soft 404 是同一类错，
 *   区别是这次连 200 都拿不到，而看的人只看到一个空白。所以它必须机器守，不能靠发版后目检。
 * ★ 其余几组防的是**漂**：卡片文案与语料不同源、落地页 meta 与生成器不同源、卡片配色与
 *   `tokens.css` 不同源、字号预算被超长文案撑破（撑破了不许偷偷缩字，要重排版）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_TERMS, SITE_ORIGIN, termPath } from './term-corpus';
import { renderTermIndexPage, renderTermPage } from './term-page';
import {
  ALL_OG_CARDS,
  CATALOG_OG_CARD,
  HOME_OG_CARD,
  OG_CARD_H,
  OG_CARD_W,
  ogCardForTerm,
  ogImageMetaLines,
  ogImageName,
  ogImageUrl,
  renderOgCardHtml,
} from './og-card';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 读仓内静态资源（PNG 与 index.html／robots.txt／tokens.css 都是提交进仓的真文件） */
const asset = (rel: string) => readFileSync(new URL(rel, import.meta.url));

describe('分享卡 · 形状', () => {
  it('★ 卡数＝首页＋目录页＋十二条＝sitemap 的 14 条，slug 唯一且纯 ASCII', () => {
    expect(ALL_OG_CARDS).toHaveLength(PUBLIC_TERMS.length + 2);
    const slugs = ALL_OG_CARDS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(SLUG_RE);
    expect(ALL_OG_CARDS.map((c) => c.slug)).toEqual([
      'home',
      'terms-index',
      ...PUBLIC_TERMS.map((t) => t.slug),
    ]);
  });

  it('每张卡五个可见字段都非空，且 alt 在（平台抓不到图时靠它兜底）', () => {
    for (const c of ALL_OG_CARDS) {
      for (const f of ['kicker', 'title', 'alias', 'lead', 'itemsLine', 'urlLine', 'alt'] as const) {
        expect(c[f].trim().length, `${c.slug}.${f}`).toBeGreaterThan(0);
      }
      expect(c.alt, c.slug).toContain('StudentBuddy');
    }
  });

  it('★ 字号预算：卡片是定尺寸位图，超预算＝要重排版，不许偷偷缩字', () => {
    for (const c of ALL_OG_CARDS) {
      expect([...c.title].length, `${c.slug} 标题`).toBeLessThanOrEqual(14);
      expect([...c.alias].length, `${c.slug} 副标`).toBeLessThanOrEqual(52);
      expect([...c.lead].length, `${c.slug} 一句话`).toBeLessThanOrEqual(66);
      expect([...c.itemsLine].length, `${c.slug} 底部左`).toBeLessThanOrEqual(46);
      expect([...c.urlLine].length, `${c.slug} 底部右`).toBeLessThanOrEqual(44);
    }
  });
});

describe('分享卡 · 与语料同源', () => {
  it('★ 十二条卡的标题／副标／一句话逐字等于语料字段（另写一份就会漂）', () => {
    for (const t of PUBLIC_TERMS) {
      const c = ogCardForTerm(t);
      expect(c.title, t.slug).toBe(t.title);
      expect(c.alias, t.slug).toBe(t.alias);
      expect(c.lead, t.slug).toBe(t.oneLine);
    }
  });

  it('★ 底部那行数字是语料字段的实算长度，不是使用量', () => {
    for (const t of PUBLIC_TERMS) {
      const c = ogCardForTerm(t);
      expect(c.itemsLine, t.slug).toContain(`${t.pitfalls.length} 个常见误区`);
      expect(c.itemsLine, t.slug).toContain(`${t.actions.length} 件今天就能做的事`);
    }
    // ★ 上一段拦不住硬编码：语料里每条**恰好** 3 误区 3 动作，写死「3」在上面同样通过。
    //   故改按派生判：夹具多加一项，卡上的数字必须跟着动——锁的是「这行由字段算出来」这件事。
    for (const t of PUBLIC_TERMS) {
      const grown = ogCardForTerm({
        ...t,
        pitfalls: [...t.pitfalls, '多加的一条'],
        actions: [...t.actions, '多加的一条'],
      });
      expect(grown.itemsLine, t.slug).toContain(`${t.pitfalls.length + 1} 个常见误区`);
      expect(grown.itemsLine, t.slug).toContain(`${t.actions.length + 1} 件今天就能做的事`);
    }
  });

  it('底部地址行＝该页 canonical 去掉协议（卡片上不出现可点的绝对 URL）', () => {
    for (const t of PUBLIC_TERMS) {
      expect(ogCardForTerm(t).urlLine, t.slug).toBe(`11wand.com${termPath(t)}`);
    }
    expect(HOME_OG_CARD.urlLine).toBe('11wand.com');
    expect(CATALOG_OG_CARD.urlLine).toBe('11wand.com/terms/index.html');
  });
});

describe('分享卡 · meta 行', () => {
  it('og:image 是绝对地址，宽高写死 1200×630，twitter 升到大卡', () => {
    const lines = ogImageMetaLines(HOME_OG_CARD);
    expect(lines).toContain(`<meta property="og:image" content="${SITE_ORIGIN}/og/home.png">`);
    expect(lines).toContain(`<meta property="og:image:width" content="${OG_CARD_W}">`);
    expect(lines).toContain(`<meta property="og:image:height" content="${OG_CARD_H}">`);
    expect(lines.join('\n')).toMatch(/property="og:image:alt" content="[^"]{6,}"/);
    expect(lines).toContain('<meta name="twitter:card" content="summary_large_image">');
    // ★ 大卡不升级，平台会按小缩略图排，1200×630 被压成方块——所以这行不许留在 `summary`
    expect(lines.join('\n')).not.toMatch(/content="summary"/);
  });

  it('★ 每个词条页的 og:image 指向自己那张（串了页就是给 A 页配 B 页的图）', () => {
    for (const t of PUBLIC_TERMS) {
      const html = renderTermPage(t);
      expect(html, t.slug).toContain(`<meta property="og:image" content="${ogImageUrl(ogCardForTerm(t))}">`);
      expect(html, t.slug).toContain('twitter:card" content="summary_large_image');
      expect(html, t.slug).not.toMatch(/content="summary"/);
    }
    expect(renderTermIndexPage()).toContain(ogImageUrl(CATALOG_OG_CARD));
  });

  it('★ 落地页 index.html 的那张卡与生成器同源（改 slug 不改这里即刻红）', () => {
    const html = asset('../../index.html').toString('utf8');
    expect(html).toContain(`og:image" content="${ogImageUrl(HOME_OG_CARD)}`);
    expect(html).toContain(`og:image:alt" content="${HOME_OG_CARD.alt}"`);
    expect(html).toContain('twitter:card" content="summary_large_image"');
  });
});

describe('分享卡 · 图真的在（本批最想要的一条）', () => {
  it('★ 每张卡都有对应 PNG，且 IHDR 尺寸就是 1200×630', () => {
    for (const c of ALL_OG_CARDS) {
      const buf = asset(`../../public/og/${ogImageName(c)}`);
      expect(buf.length, ogImageName(c)).toBeGreaterThan(1000);
      expect([...buf.subarray(0, 8)], 'PNG 签名').toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      // IHDR：宽在 16..19、高在 20..23，都是大端
      expect(buf.readUInt32BE(16), ogImageName(c)).toBe(OG_CARD_W);
      expect(buf.readUInt32BE(20), ogImageName(c)).toBe(OG_CARD_H);
    }
  });

  it('★ 页面里出现的每一个 `/og/` 地址都能对上 `public/og/` 里的文件（og:image 不许是死链）', () => {
    const pages = [...PUBLIC_TERMS.map(renderTermPage), renderTermIndexPage()];
    const refs = new Set(
      pages.flatMap((html) => [...html.matchAll(/content="(https:\/\/11wand\.com\/og\/[^"]+)"/g)].map((m) => m[1] ?? '')),
    );
    expect(refs.size).toBe(PUBLIC_TERMS.length + 1); // 12 词条页＋目录页；首页那张在 index.html，上一条锁已核
    for (const ref of refs) {
      const name = ref.slice(`${SITE_ORIGIN}/og/`.length);
      expect(name).toMatch(/^[a-z0-9-]+\.png$/);
      expect(() => asset(`../../public/og/${name}`), ref).not.toThrow();
    }
  });

  it('robots.txt 给 `/og/` 开了门（本站默认全封，不放行就是自己挡自己的图）', () => {
    expect(asset('../../public/robots.txt').toString('utf8')).toContain('Allow: /og/');
  });
});

describe('分享卡 · HTML 与配色', () => {
  it('★ 卡片 HTML 零脚本、零 link、零外部 URL、零内联 style 属性', () => {
    for (const c of ALL_OG_CARDS) {
      const html = renderOgCardHtml(c);
      expect(html, c.slug).toContain('<!doctype html>');
      expect(html, c.slug).toContain('<html lang="zh-CN">');
      expect(html, c.slug).not.toMatch(/<script/);
      expect(html, c.slug).not.toMatch(/<link/);
      expect(html, c.slug).not.toMatch(/https?:\/\//);
      expect(html, c.slug).not.toMatch(/ style="/);
      expect(html, c.slug).not.toMatch(/<img/);
    }
  });

  it('★ 配色与字体逐个能在 tokens.css 现值里找到（卡片与站点不是两张脸）', () => {
    const tokens = asset('../styles/tokens.css').toString('utf8');
    const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    const values = new Set([...tokens.matchAll(/--sb-[a-z-]+:\s*([^;]+);/g)].map((m) => norm(m[1] ?? '')));
    const css = renderOgCardHtml(HOME_OG_CARD).match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    const colors = [...css.matchAll(/(#[0-9a-f]{3,8}\b|rgba?\([^)]*\))/g)].map((m) => norm(m[1] ?? ''));
    expect(colors.length).toBeGreaterThan(8);
    for (const color of new Set(colors)) expect(values.has(color), color).toBe(true);
    // 字体那一串整段来自 `--sb-font`
    expect(norm(css)).toContain(norm('font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;'));
    expect(norm(tokens)).toContain(norm('--sb-font: "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;'));
  });
});

describe('分享卡 · 诚实红线（与词条页同源）', () => {
  const allText = JSON.stringify(ALL_OG_CARDS) + ALL_OG_CARDS.map(renderOgCardHtml).join('');

  it('★ 不写任何使用量／人数／评价类数字（真实计数未上线，写一个就是造假）', () => {
    expect(allText).not.toMatch(/已有.{0,8}人/);
    expect(allText).not.toMatch(/\d+\s*(名|位|人).{0,6}(用户|学生|学习者|正在|体验|使用)/);
    expect(allText).not.toMatch(/(超过|突破)\s*\d+/);
    expect(allText).not.toMatch(/(\d+(,\d{3})*|[一-龥]+)\s*(好评|五星|满意度)/);
    expect(allText).not.toMatch(/上万|百万|无数用户/);
  });

  it('★ 不许诺学习效果（机制可以讲，疗效不能讲）', () => {
    expect(allText).not.toMatch(/包过|保过|提分|成绩(提升|提高)\s*\d+|记忆力(提升|增强)/);
    expect(allText).not.toMatch(/保证.{0,6}(记住|学会|通过)/);
  });
});
