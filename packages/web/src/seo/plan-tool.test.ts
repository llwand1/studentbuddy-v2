// @vitest-environment node
/**
 * 复习计划表生成器（档位 3＝渠道 C1 的工具意图侧）的锁。
 *
 * ★ 这一页最值钱也最脆的地方：**页面上那张表是浏览器里另一份代码算的**。所以第一把锁不查文案，
 *   而是把页面脚本里那半段纯算法抓出来在 vm 里真跑一遍，与仓里的 `buildPlan()` 逐行对账——
 *   「两边各算一份然后相信它们一样」是本仓反复登记过的病（`ebbinghaus.ts` 头注即为它而写）。
 * ★ 其余三族：① 「不落库」要可证（看字节形状，不看形容词）；② 构建期不许烘一张会烂的日期表；
 *   ③ 措辞红线与词条页同一套（数字不造假、不许诺效果、中文正文只写中文）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { REVIEW_INTERVALS_DAYS } from '@sb/shared';
import { PUBLIC_TERMS } from './term-corpus';
import { renderTermPage } from './term-page';
import { PLAN_TOOL_PATH } from './paths';
import { buildPlan, weekdayOf, type PlanRow } from './plan-schedule';
import { PLAN_CORE_JS, PLAN_PAGE_SCRIPT, renderPlanToolPage } from './plan-page';
import { PLAN_OG_CARD } from './og-card';
import { writeSeoPages } from './ssg';
import { internalWordingHits } from './public-hygiene';

interface PageRow {
  offset: number;
  date: string;
  weekday: string;
  newCount: number;
  reviewCount: number;
  reviewGroups: number[];
  total: number;
}

/** 把页面脚本里那半段算法真的跑起来——测的就是发出去的那串字节，不是它的抄本 */
function runPagePlan(start: string, daily: number, days: number): PageRow[] {
  return runInNewContext(`${PLAN_CORE_JS}\nplan(${JSON.stringify(start)}, ${daily}, ${days});`) as PageRow[];
}

/** 两边归一化成同一种可比较的形状（TS 侧字段叫 `reviewBatches`，页内那半段叫 `reviewGroups`） */
function shape(rows: readonly (PlanRow | PageRow)[]): string[] {
  return rows.map((r) => {
    const groups = 'reviewBatches' in r ? r.reviewBatches : r.reviewGroups;
    return [r.offset, r.date, r.weekday, r.newCount, r.reviewCount, r.total, groups.join('+')].join('|');
  });
}

const PAGE = renderPlanToolPage();
const DIR = mkdtempSync(join(tmpdir(), 'sb-plan-'));
const WRITTEN = new Set(
  writeSeoPages(DIR, PUBLIC_TERMS, [], new Date('2026-09-24T12:00:00Z')).map((w) => `/${w.rel}`),
);

describe('计划表页 · 两边算的是同一张表', () => {
  it('★ 页面脚本与 `buildPlan()` 在 70 天上逐行逐列相同（日期、星期、组数、合计都算）', () => {
    const a = runPagePlan('2026-01-05', 7, 70);
    const b = buildPlan('2026-01-05', 7, 70);
    expect(a).toHaveLength(b.length);
    expect(shape(a)).toEqual(shape(b));
  });

  it('★ 钳制两边同形：新学量与天数被塞进 0、负数、小数、超大值都不崩也不越界', () => {
    for (const [daily, days] of [
      [0, 0],
      [-5, -9],
      [999, 9999],
      [1, 1],
      [100, 180],
      [2.7, 12.9],
      [Number.NaN, Number.NaN],
    ] as const) {
      const a = runPagePlan('2026-03-10', daily, days);
      const b = buildPlan('2026-03-10', daily, days);
      expect(a.length, `${daily}/${days}`).toBeLessThanOrEqual(180);
      expect(a.length, `${daily}/${days}`).toBeGreaterThanOrEqual(1);
      expect(shape(a), `${daily}/${days}`).toEqual(shape(b));
    }
  });

  it('日期算术跨月与闰年都对（差一天在复习场景里就是「今天该不该背」那种可见错误）', () => {
    expect(buildPlan('2026-02-27', 1, 3).map((r) => r.date)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(buildPlan('2028-02-28', 1, 2).map((r) => r.date)).toEqual(['2028-02-28', '2028-02-29']);
    expect(buildPlan('2026-12-31', 1, 2).map((r) => r.date)).toEqual(['2026-12-31', '2027-01-01']);
    expect(weekdayOf('2026-01-05')).toBe('一');
    expect(shape(runPagePlan('2026-12-31', 4, 3))).toEqual(shape(buildPlan('2026-12-31', 4, 3)));
  });

  it('★ 回炉量阶梯上升：第 1 天没有回炉，第 5 天三组，第 16 天五组，第 61 天七组全到', () => {
    const rows = buildPlan('2026-01-01', 10, 62);
    expect(rows[0]?.reviewBatches).toEqual([]);
    expect(rows[4]?.reviewBatches).toEqual([1, 2, 4]);
    expect(rows[15]?.reviewBatches).toEqual([1, 2, 4, 7, 15]);
    expect(rows[60]?.reviewBatches).toEqual([...REVIEW_INTERVALS_DAYS]);
    let prev = 0;
    for (const r of rows) {
      expect(r.total).toBeGreaterThanOrEqual(prev);
      prev = r.total;
    }
  });

  it('回炉的偏移永远只可能是那七个点之一（算法没被改出第八个节点）', () => {
    for (const r of buildPlan('2026-05-06', 3, 90)) {
      for (const g of r.reviewBatches) expect(REVIEW_INTERVALS_DAYS).toContain(g);
      expect(r.reviewCount).toBe(r.newCount * r.reviewBatches.length);
      expect(r.total).toBe(r.newCount + r.reviewCount);
    }
  });
});

describe('计划表页 · 「不落库」是可证的字节形状', () => {
  it('★ 整页没有任何网络与本地写入面（形容词不算，出现即红）', () => {
    for (const banned of [
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'EventSource',
      'sendBeacon',
      'localStorage',
      'sessionStorage',
      'document.cookie',
      'indexedDB',
      '/api/',
      'method="post"',
      '<form',
    ]) {
      expect(PAGE, `页面里出现了 ${banned}`).not.toContain(banned);
    }
  });

  it('★ 构建期不烘日期：字节里不许出现任何一个 `YYYY-MM-DD`（烘进去就是一张会烂的表）', () => {
    expect(PAGE).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(PLAN_PAGE_SCRIPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('关掉脚本也读得到一张完整的表：形状表、七个节点、`noscript` 说明都在字节里', () => {
    expect(PAGE).toContain('<table class="plan">');
    expect(PAGE).toContain('<noscript>');
    expect(PAGE).toContain('第 12 天');
    expect(PAGE).toContain(`按 ${REVIEW_INTERVALS_DAYS.join(' / ')} 天`);
    // ★ 只查人读得到的那半份字节：脚本里 `!== undefined` 是代码，不是渲染残渣
    const readable = PAGE.slice(0, PAGE.indexOf('<script>'));
    expect(readable).not.toContain('undefined');
    expect(readable).not.toContain('NaN');
  });
});

describe('计划表页 · 公开面形状', () => {
  it('★ 地址带 `.html`、纯 ASCII，且 `writeSeoPages` 真写得出这一个文件（URL 与文件同形）', () => {
    expect(PLAN_TOOL_PATH).toBe('/ebbinghaus-plan.html');
    expect(PLAN_TOOL_PATH.slice(1)).toMatch(/^[a-z0-9-]+\.html$/);
    expect(WRITTEN.has(PLAN_TOOL_PATH)).toBe(true);
    expect(readFileSync(join(DIR, PLAN_TOOL_PATH.slice(1)), 'utf8')).toBe(PAGE);
    expect(PAGE).toContain(`<link rel="canonical" href="https://11wand.com${PLAN_TOOL_PATH}">`);
  });

  it('★ 页内每个站内链接都指向带扩展名的落盘页（点了不是空壳，也不给爬虫留死链）', () => {
    const hrefs = [...PAGE.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1] ?? '');
    expect(hrefs.length).toBeGreaterThanOrEqual(5);
    for (const href of hrefs) {
      if (href === '/') continue;
      expect(/\.\w+$/.test(href), `目录形式的链接：${href}`).toBe(true);
      expect(WRITTEN.has(href), `死链：${href}`).toBe(true);
    }
  });

  it('中文词条页页脚链向它，它也链回两条讲原理的页（互链只有一半＝孤岛页）', () => {
    for (const t of PUBLIC_TERMS) {
      const foot = renderTermPage(t).slice(renderTermPage(t).lastIndexOf('<footer>'));
      expect(foot, t.slug).toContain(PLAN_TOOL_PATH);
    }
    expect(PAGE).toContain('/terms/yiwang-quxian.html');
    expect(PAGE).toContain('/terms/jian-ge-chongfu.html');
  });

  it('分享卡与页面同源：底部那行地址就是 canonical 的路径，图也是那一张', () => {
    expect(PLAN_OG_CARD.urlLine).toBe(`11wand.com${PLAN_TOOL_PATH}`);
    expect(PLAN_OG_CARD.slug).toBe('ebbinghaus-plan');
    expect(PLAN_OG_CARD.alt).toContain('StudentBuddy');
    expect(PAGE).toContain(`<meta property="og:image" content="https://11wand.com/og/${PLAN_OG_CARD.slug}.png">`);
  });
});

describe('计划表页 · 构建期这一层要能被纯 Node 加载', () => {
  it('★ `src/seo/` 的非测试文件不许引 `@sb/shared` 根入口（要取产品事实就走子路径）', () => {
    // ★ 这条不是风格问题：`vite.config.ts` 是在**纯 Node**里加载 `ssg.ts` 这一层的，
    //   而 shared 根入口内部写的是 `./x.js` 说明符（NodeNext 约定）——Node 找不到 `.js` 文件，
    //   `npm run build` 直接红在配置加载阶段。★ 而 CI 只跑 `npm run check`（不含 build），
    //   ⇒ 这一族破坏**没有任何自动闸门**，本例就是补上的那一道。
    const dir = new URL('./', import.meta.url);
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources.length).toBeGreaterThan(10);
    for (const f of sources) {
      const text = readFileSync(new URL(f, dir), 'utf8');
      expect(text, `${f} 引了 @sb/shared 根入口 ⇒ 构建期加载不了`).not.toMatch(/from '@sb\/shared'/);
    }
  });
});

describe('计划表页 · 措辞红线（与词条页同一套）', () => {
  /** 只取人读得到的可见文字：去掉 head、样式、脚本，再把标签剥掉 */
  const visible = PAGE.slice(PAGE.indexOf('<body>'), PAGE.indexOf('</footer>'))
    .replace(PLAN_PAGE_SCRIPT, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .split('StudentBuddy')
    .join(' ');

  it('★ 中文正文只写中文：可见文字里不许混拉丁字母（星号也算，渲染器不解析 markdown）', () => {
    expect(visible).not.toMatch(/\*/);
    expect(visible).not.toMatch(/[A-Za-z]/);
    expect(PAGE).not.toMatch(/\*\*[^*]+\*\*/);
  });

  it('★ 不写使用量数字、不许诺学习效果（真实计数未上线前，写一个就是造假）', () => {
    const all = JSON.stringify(PLAN_OG_CARD) + visible;
    expect(all).not.toMatch(/已有.{0,8}人|\d+\s*(名|位|人).{0,6}(用户|学生|学习者|正在|体验|使用)/);
    expect(all).not.toMatch(/(超过|突破)\s*\d+|上万|百万|无数用户/);
    expect(all).not.toMatch(/包过|保过|提分|成绩(提升|提高)\s*\d+|记忆力(提升|增强)/);
    expect(all).not.toMatch(/保证.{0,6}(记住|学会|通过)/);
  });

  it('★ 公开字节里没有内部字样，且这条页自己的产品落点不冒充背书', () => {
    expect(internalWordingHits(PAGE)).toEqual([]);
    expect(visible).toContain('本产品');
    expect(visible).not.toMatch(/(?:用户|学生)都|大家都|很多人用/);
  });
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));
