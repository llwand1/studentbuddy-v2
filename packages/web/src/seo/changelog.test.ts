// @vitest-environment node
/**
 * 公开更新记录页与 Atom 订阅的锁（渠道台账 C8）。
 *
 * ★ 这批锁分三类，各自挡一类真实会犯的错：
 *   ① 数据形状——排反一次序、多打一个空格，订阅端整列错位，而页面看起来一切正常；
 *   ② 「不许凭空造版本」——清洗表是手写的，手写就有编的风险，所以拿内部 `CHANGELOG.md` 反查；
 *   ③ 页与订阅同源——同一份数据渲两遍，锚点与 `<id>` 必须对得上。
 * ★ 已知拦不住的那一头也记在这里：**这页落后于线上**（发版忘了回来加一条）机器查不出来，
 *   因为「CHANGELOG 有而清洗表没有」是正常状态（未上线的拟号也在表里）。代价登记在
 *   `docs/GROWTH-CHANNELS.md` §C8 与 `docs/dev/manual-test.md`。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHANGELOG_PATH, FEED_PATH } from './paths';
import { PUBLIC_TERMS } from './term-corpus';
import { PUBLIC_TERMS_EN } from './term-corpus-en';
import { PUBLIC_RELEASES, RELEASE_SCOPE, releaseAnchor, type ReleaseNote } from './changelog-public';
import { CHANGELOG_URL, FEED_URL, renderAtomFeed, renderChangelogPage } from './changelog-page';
import { renderSitemapXml } from './ssg';

const html = renderChangelogPage();
const xml = renderAtomFeed();

/** 内部账本（清洗表必须能在它里面找到出处，但不许反过来被它带出去） */
const internalLedger = (): string =>
  readFileSync(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8');

describe('清洗表 · 数据形状', () => {
  it('非空、版本号唯一、格式是 vX.Y.Z', () => {
    expect(PUBLIC_RELEASES.length).toBeGreaterThan(0);
    const vs = PUBLIC_RELEASES.map((r) => r.version);
    expect(new Set(vs).size).toBe(vs.length);
    for (const v of vs) expect(v).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('★ 新到旧排列（排反一次，订阅端最新条目就变成最旧那条）', () => {
    const nums = PUBLIC_RELEASES.map((r) =>
      r.version.slice(1).split('.').map((n) => Number(n)),
    );
    const key = (n: number[]): number => n[0]! * 1e8 + n[1]! * 1e4 + n[2]!;
    for (let i = 1; i < nums.length; i++) expect(key(nums[i - 1]!)).toBeGreaterThan(key(nums[i]!));
  });

  it('日期是 ISO 且与版本顺序同向；每条至少一件可验证的事', () => {
    let prev = '';
    for (const r of PUBLIC_RELEASES) {
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.date <= prev || prev === '').toBe(true);
      prev = r.date;
      expect(r.headline.length).toBeGreaterThan(0);
      expect(r.items.length).toBeGreaterThan(0);
      for (const item of r.items) expect(item.trim().length).toBeGreaterThan(8);
    }
  });

  it('★ 不凭空造版本：清洗表里每一个版本号都在内部账本出现过', () => {
    const ledger = internalLedger();
    for (const r of PUBLIC_RELEASES) expect(ledger.includes(r.version), r.version).toBe(true);
  });

  it('★ 口径三禁（与词条语料同族）：不写使用量、不许诺效果、不引用真实用户', () => {
    const banned = [/名用户/, /位用户/, /人用过/, /次访问/, /提升\d+/, /保证/, /一定考/];
    const text = PUBLIC_RELEASES.map((r) => `${r.headline}${r.items.join('')}`).join('\n');
    for (const re of banned) expect(re.test(text), `清洗表里出现了 ${re.source}`).toBe(false);
  });
});

describe('更新页 · HTML 形状', () => {
  it('是独立完整文档，零脚本，链向首页与词条目录', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).not.toMatch(/<script/);
    expect(html).toContain('href="/?ref=changelog"');
    expect(html).toContain('href="/terms/index.html"');
  });

  it('canonical 与 og:url 是自己的绝对地址；带 atom 自动发现', () => {
    expect(html).toContain(`<link rel="canonical" href="${CHANGELOG_URL}">`);
    expect(html).toContain(`<meta property="og:url" content="${CHANGELOG_URL}">`);
    expect(html).toContain(`href="${FEED_PATH}"`);
    expect(html).toContain('application/atom+xml');
  });

  it('每一条清洗表都在页面上有一段，且带自己的锚点', () => {
    for (const r of PUBLIC_RELEASES) {
      expect(html).toContain(`id="${releaseAnchor(r.version)}"`);
      expect(html).toContain(r.headline);
      for (const item of r.items) expect(html).toContain(item);
    }
    expect(html).toContain(RELEASE_SCOPE.lead);
  });

  it('★ 地址一律带 .html（线上门没有扩展名会兜成 SPA 壳）', () => {
    expect(CHANGELOG_PATH).toBe('/changelog/index.html');
    for (const href of html.match(/href="(\/[^"]*)"/g) ?? []) {
      expect(href).not.toMatch(/\/changelog\/"/);
    }
  });

  it('★ 这一页不在 sitemap 里（要进去先决定它配不配分享图，别顺手补一行）', () => {
    const xml2 = renderSitemapXml(PUBLIC_TERMS, PUBLIC_TERMS_EN, new Date('2026-09-24T00:00:00Z'));
    expect(xml2).not.toContain(CHANGELOG_PATH);
    // ★ 条数＝首页＋中英两个目录页＋两边全部词条页＋计划表页（此刻 12＋6＝18 条词条页 ⇒ 22）
    expect(xml2.match(/<loc>/g)).toHaveLength(PUBLIC_TERMS.length + PUBLIC_TERMS_EN.length + 4);
  });
});

describe('Atom 订阅', () => {
  it('命名空间、self／alternate、条目数与清洗表一致', () => {
    expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(xml).toContain(`<link href="${FEED_URL}" rel="self">`);
    expect(xml).toContain(`<link href="${CHANGELOG_URL}" rel="alternate">`);
    expect(xml.match(/<entry>/g)).toHaveLength(PUBLIC_RELEASES.length);
  });

  it('★ 每个 entry 有 id／title／link／updated，id 唯一且对得上页内锚点', () => {
    for (const r of PUBLIC_RELEASES) {
      const id = `${CHANGELOG_URL}#${releaseAnchor(r.version)}`;
      expect(xml).toContain(`<id>${id}</id>`);
      expect(xml).toContain(`<link href="${id}" rel="alternate">`);
      expect(html).toContain(`id="${releaseAnchor(r.version)}"`);
    }
    const ids = xml.match(/<id>([^<]*)<\/id>/g) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('日期是完整 RFC-3339；feed 的 updated 取最新一条', () => {
    const stamps = [...xml.matchAll(/<updated>([^<]*)<\/updated>/g)].map((m) => m[1]!);
    expect(stamps.length).toBeGreaterThan(PUBLIC_RELEASES.length);
    for (const s of stamps) expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
    const newest = PUBLIC_RELEASES[0]!;
    expect(xml).toContain(`<updated>${newest.date}T00:00:00Z</updated>`);
  });

  it('★ 标题或正文里出现尖括号与 & 时按文本转义（XML 一旦不合法，阅读器整条丢弃）', () => {
    const dirty: ReleaseNote = {
      version: 'v9.9.9',
      date: '2026-09-24',
      headline: '<feed> & 坏数据',
      items: ['含 <script> 与 "引号" 的一条'],
    };
    const out = renderAtomFeed([dirty, ...PUBLIC_RELEASES]);
    expect(out).toContain('&lt;feed&gt; &amp; 坏数据');
    expect(out).not.toContain('<feed> 坏');
    expect((out.match(/<feed /g) ?? []).length).toBe(1);
  });
});
