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
import { PUBLIC_TERMS_EN, termEnPath } from './term-corpus-en';
import { renderTermIndexPage, renderTermPage } from './term-page';
import { renderTermIndexPageEn, renderTermPageEn } from './term-page-en';
import { renderSitemapXml } from './ssg';
import {
  ALL_OG_CARDS,
  CATALOG_OG_CARD,
  HOME_OG_CARD,
  OG_CARD_H,
  OG_CARD_W,
  ogCardForTerm,
  ogCardForTermEn,
  CATALOG_EN_OG_CARD,
  ogImageMetaLines,
  ogImageName,
  ogImageUrl,
  renderOgCardHtml,
} from './og-card';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 读仓内静态资源（PNG 与 index.html／robots.txt／tokens.css 都是提交进仓的真文件） */
const asset = (rel: string) => readFileSync(new URL(rel, import.meta.url));

describe('分享卡 · 形状', () => {
  it('★ 卡数＝首页＋中英两个目录页＋两边全部词条页＋计划表工具页＝sitemap 的 `<loc>` 数，slug 唯一且纯 ASCII', () => {
    expect(ALL_OG_CARDS).toHaveLength(PUBLIC_TERMS.length + PUBLIC_TERMS_EN.length + 4);
    const slugs = ALL_OG_CARDS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(SLUG_RE);
    expect(ALL_OG_CARDS.map((c) => c.slug)).toEqual([
      'home',
      'terms-index',
      ...PUBLIC_TERMS.map((t) => t.slug),
      'terms-en-index',
      ...PUBLIC_TERMS_EN.map((t) => t.slug),
      'ebbinghaus-plan',
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
    // ★ 两档：CJK 每字约 1em 宽、拉丁字母约 0.55em，同一串数字给两种文字必有一档是错的
    //   （「The forgetting curve」20 个字符在 CJK 那一档＝直接顶出画框）。
    //   这一档是**排版预算**，不是「能不能挤进去」的判据——真渲染有没有被裁由探针量
    //   （`tools/probes/og-card-cdp.mts` 逐张测越界，撑破不落盘）。
    const CJK = { title: 14, alias: 52, lead: 66, itemsLine: 46, urlLine: 44 };
    const LATIN = { title: 24, alias: 56, lead: 112, itemsLine: 52, urlLine: 44 };
    for (const c of ALL_OG_CARDS) {
      const budget = c.script === 'latin' ? LATIN : CJK;
      for (const f of ['title', 'alias', 'lead', 'itemsLine', 'urlLine'] as const) {
        expect([...c[f]].length, `${c.slug}.${f}`).toBeLessThanOrEqual(budget[f]);
      }
    }
  });

  it('★ 每一张卡都对应 sitemap 里的一条 `<loc>`，反过来也成立（公开页与配图不多不少）', () => {
    const xml = renderSitemapXml();
    const locs = new Set(
      [...xml.matchAll(/<loc>https:\/\/11wand\.com(\/[^<]*)<\/loc>/g)].map((m) => m[1] ?? ''),
    );
    // 卡上的 `urlLine` 就是「这张卡属于哪一页」（去掉协议那一格已经锁过），拿它当键
    const cardPaths = new Set(ALL_OG_CARDS.map((c) => c.urlLine.replace(/^11wand\.com/, '') || '/'));
    expect(cardPaths.size).toBe(ALL_OG_CARDS.length);
    expect(cardPaths).toEqual(locs);
  });
});

describe('分享卡 · 与语料同源', () => {
  it('★ 每条中文卡的标题／副标／一句话逐字等于语料字段（另写一份就会漂）', () => {
    for (const t of PUBLIC_TERMS) {
      const c = ogCardForTerm(t);
      expect(c.title, t.slug).toBe(t.title);
      expect(c.alias, t.slug).toBe(t.alias);
      expect(c.lead, t.slug).toBe(t.oneLine);
    }
  });

  it('★ 英文侧同一条纪律：卡上那三行逐字等于英文语料（两边各写一份文案就会漂）', () => {
    for (const t of PUBLIC_TERMS_EN) {
      const c = ogCardForTermEn(t);
      expect(c.title, t.slug).toBe(t.title);
      expect(c.alias, t.slug).toBe(t.alias);
      expect(c.lead, t.slug).toBe(t.oneLine);
      expect(c.script, t.slug).toBe('latin');
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
    // 英文侧两条同一把尺（★ 那句英文话术里的数字也必须来自数组长度）
    for (const t of PUBLIC_TERMS_EN) {
      const c = ogCardForTermEn(t);
      expect(c.itemsLine, t.slug).toContain(`${t.pitfalls.length} mistakes`);
      expect(c.itemsLine, t.slug).toContain(`${t.actions.length} things to try`);
      const grown = ogCardForTermEn({
        ...t,
        pitfalls: [...t.pitfalls, 'one more'],
        actions: [...t.actions, 'one more'],
      });
      expect(grown.itemsLine, t.slug).toContain(`${t.pitfalls.length + 1} mistakes`);
      expect(grown.itemsLine, t.slug).toContain(`${t.actions.length + 1} things to try`);
    }
  });

  it('底部地址行＝该页 canonical 去掉协议（卡片上不出现可点的绝对 URL）', () => {
    for (const t of PUBLIC_TERMS) {
      expect(ogCardForTerm(t).urlLine, t.slug).toBe(`11wand.com${termPath(t)}`);
    }
    for (const t of PUBLIC_TERMS_EN) {
      expect(ogCardForTermEn(t).urlLine, t.slug).toBe(`11wand.com${termEnPath(t)}`);
    }
    expect(HOME_OG_CARD.urlLine).toBe('11wand.com');
    expect(CATALOG_OG_CARD.urlLine).toBe('11wand.com/terms/index.html');
    expect(CATALOG_EN_OG_CARD.urlLine).toBe('11wand.com/terms/en/index.html');
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

  it('★ 每个词条页的 og:image 指向自己那张（中英两批一起，串了页就是给 A 页配 B 页的图）', () => {
    for (const t of PUBLIC_TERMS) {
      const html = renderTermPage(t);
      expect(html, t.slug).toContain(`<meta property="og:image" content="${ogImageUrl(ogCardForTerm(t))}">`);
      expect(html, t.slug).toContain('twitter:card" content="summary_large_image');
      expect(html, t.slug).not.toMatch(/content="summary"/);
    }
    for (const t of PUBLIC_TERMS_EN) {
      const html = renderTermPageEn(t);
      expect(html, t.slug).toContain(
        `<meta property="og:image" content="${ogImageUrl(ogCardForTermEn(t))}">`,
      );
      expect(html, t.slug).not.toMatch(/content="summary"/);
    }
    expect(renderTermIndexPage()).toContain(ogImageUrl(CATALOG_OG_CARD));
    expect(renderTermIndexPageEn()).toContain(ogImageUrl(CATALOG_EN_OG_CARD));
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
    const pages = [
      ...PUBLIC_TERMS.map(renderTermPage),
      renderTermIndexPage(),
      ...PUBLIC_TERMS_EN.map(renderTermPageEn),
      renderTermIndexPageEn(),
    ];
    const refs = new Set(
      pages.flatMap((html) => [...html.matchAll(/content="(https:\/\/11wand\.com\/og\/[^"]+)"/g)].map((m) => m[1] ?? '')),
    );
    // 12 中文词条页＋中文目录页＋6 英文词条页＋英文目录页；首页那张在 index.html，上一条锁已核
    expect(refs.size).toBe(PUBLIC_TERMS.length + PUBLIC_TERMS_EN.length + 2);
    for (const ref of refs) {
      const name = ref.slice(`${SITE_ORIGIN}/og/`.length);
      expect(name).toMatch(/^[a-z0-9-]+\.png$/);
      expect(() => asset(`../../public/og/${name}`), ref).not.toThrow();
    }
  });

  it('robots.txt 给 `/og/` 开了门（本站默认全封，不放行就是自己挡自己的图）', () => {
    const robots = asset('../../public/robots.txt').toString('utf8');
    expect(robots).toContain('Allow: /og/');
    // ★ 英文页嵌在 `/terms/` 底下，靠的是那一扇**前缀**放行。这一条锁的是「前缀还盖得住」，
    //   而不是再抄一行 `Allow: /terms/en/`——抄了就会有第二份口径，改了前缀它也不会红。
    const allow = (path: string): boolean =>
      robots.includes(`Allow: ${path}`) ||
      [...robots.matchAll(/^Allow: (\/[^$\r\n]*)\s*$/gm)].some((m) => path.startsWith(m[1] ?? '#'));
    for (const t of PUBLIC_TERMS_EN) expect(allow(termEnPath(t)), termEnPath(t)).toBe(true);
  });
});

describe('分享卡 · HTML 与配色', () => {
  it('★ 卡片 HTML 零脚本、零 link、零外部 URL、零内联 style 属性', () => {
    for (const c of ALL_OG_CARDS) {
      const html = renderOgCardHtml(c);
      expect(html, c.slug).toContain('<!doctype html>');
      // ★ 语言声明跟着文字走：拉丁卡写 `lang="en"`。字是英文、语言声明是中文＝浏览器与朗读软件都排错
      expect(html, c.slug).toContain(
        `<html lang="${c.script === 'latin' ? 'en' : 'zh-CN'}">`,
      );
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
    // ★ 英文侧要另写一遍：上面五条全是中文形状，拉丁字一个都拦不住
    expect(allText).not.toMatch(/\d+\s*(students?|users?|learners?|people)\b/i);
    expect(allText).not.toMatch(/thousands|millions of|countless\b/i);
    expect(allText).not.toMatch(/(5|five)[- ]star|top[- ]rated|\d+(\.\d+)?\/5|rating/i);
    expect(allText).not.toMatch(/(loved|trusted|recommended|chosen) by\b/i);
  });

  it('★ 不许诺学习效果（机制可以讲，疗效不能讲）', () => {
    expect(allText).not.toMatch(/包过|保过|提分|成绩(提升|提高)\s*\d+|记忆力(提升|增强)/);
    expect(allText).not.toMatch(/保证.{0,6}(记住|学会|通过)/);
    // ★ 英文侧同一族：这一条要拦的是「把机制说成疗效」，拉丁字也要拦得住
    expect(allText).not.toMatch(/guarantee| guarantees?| guaranteed/i);
    expect(allText).not.toMatch(/\bproven to (raise|improve|boost|double)\b/i);
    expect(allText).not.toMatch(/(boost|improve|double)\s+your\s+(memory|grades?|score|retention)/i);
    expect(allText).not.toMatch(/remember everything|never forget|\b100%\b|fastest results/i);
  });
});
