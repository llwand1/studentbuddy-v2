// @vitest-environment node
/**
 * 公开静态页「回应用的链接必须带来源」这把锁（渠道台账 C1/C4，契约 `docs/GROWTH-SPEC.md` §2.5）。
 *
 * ★ 为什么单开一把锁而不满足于逐页 `toContain('href="/?ref=terms"')`：
 *   归因这件事的失败方式是**安静的**——少写一个 `?ref=`，页面照常、爬虫照常、什么错都不报，
 *   只有一个月后读数据时发现「这一批人查不出来源」。那正是 2026-09-24 取证出来的现状
 *   （当天 12 个 `app_open` 桶没有一个查得出来源）。⇒ 判据要写成**遍历所有公开页**，
 *   而不是"改到的那几页各断言一句"：将来新加一页（比如英文版计划表）只要回链不带 ref 就红。
 *
 * ★ 三类判据各挡一种会犯的错：
 *   ① 不许留裸 `href="/"`（那就是把来源丢掉）；
 *   ② ref 名必须是**登记过的那几个**且形如服务端那一格能放的值（写错一个字母就是一个新渠道，
 *      读侧会安静地多出一行没人认领的数）；
 *   ③ 每页至少一条带回应用的路（顶栏品牌或 CTA，两者都没＝这一页把访客关在门外）。
 */
import { describe, expect, it } from 'vitest';
import { renderTermIndexPage, renderTermPage } from './term-page';
import { renderTermIndexPageEn, renderTermPageEn } from './term-page-en';
import { renderChangelogPage } from './changelog-page';
import { renderPlanToolPage } from './plan-page';
import { PUBLIC_TERMS } from './term-corpus';
import { PUBLIC_TERMS_EN } from './term-corpus-en';
import { appHome, REF_CHANGELOG, REF_PLAN, REF_TERMS, REF_TERMS_EN } from './paths';

/** 公开页 → 它该带的来源名。★ 这是一份**清单**：漏登记一页，下面「遍历」那条就罩不住它。 */
const PAGES: Array<{ name: string; html: string; ref: string }> = [
  ...PUBLIC_TERMS.map((t) => ({ name: `词条 ${t.slug}`, html: renderTermPage(t), ref: REF_TERMS })),
  { name: '中文目录页', html: renderTermIndexPage(), ref: REF_TERMS },
  ...PUBLIC_TERMS_EN.map((t) => ({ name: `英文词条 ${t.slug}`, html: renderTermPageEn(t), ref: REF_TERMS_EN })),
  { name: '英文目录页', html: renderTermIndexPageEn(), ref: REF_TERMS_EN },
  { name: '更新记录页', html: renderChangelogPage(), ref: REF_CHANGELOG },
  { name: '复习计划表页', html: renderPlanToolPage(), ref: REF_PLAN },
];

/** 服务端那一格能放的值（`normalizeGrowthSource` 的同一条形状，两边同值由本文件锁）。 */
const SOURCE_SHAPE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const REGISTERED = new Set([REF_TERMS, REF_TERMS_EN, REF_CHANGELOG, REF_PLAN]);

describe('公开页回应用的链接（归因唯一通路：静态页零 JS，链接带不出去就永远带不出去）', () => {
  it('★ 一页不漏：每页都有一条带自己来源名的回应用链接', () => {
    for (const p of PAGES) {
      expect(p.html, `${p.name} 缺回应用链接`).toContain(`href="${appHome(p.ref)}"`);
    }
  });

  it('★ 一页不漏：任何一页都不留裸 `href="/"`（裸链＝把来源丢掉）', () => {
    for (const p of PAGES) {
      expect(p.html, `${p.name} 还有不带 ref 的根链接`).not.toMatch(/href="\/"/);
    }
  });

  it('★ 出现的每个 `/?ref=` 都在登记表里，且形如服务端那一格能放的值', () => {
    const seen = new Set<string>();
    for (const p of PAGES) {
      for (const m of p.html.matchAll(/href="\/\?ref=([^"&]+)"/g)) {
        const ref = m[1] ?? '';
        seen.add(ref);
        expect(SOURCE_SHAPE.test(ref), `${p.name} 的 ref "${ref}" 不合形状（会被截断或改写）`).toBe(true);
      }
    }
    expect([...seen].sort()).toEqual([...REGISTERED].sort());
  });

  it('★ 来源名不许超过服务端那一格的长度上限（超了会被静默截断，读侧看到的不是你写的名字）', () => {
    for (const ref of REGISTERED) expect(ref.length).toBeLessThanOrEqual(24);
  });
});
