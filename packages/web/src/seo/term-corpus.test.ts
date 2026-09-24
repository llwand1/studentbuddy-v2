// @vitest-environment node
/**
 * 词条语料的结构锁与「不许编数字」锁。
 *
 * 这批页面是本站第一次对外部访客公开的内容面，因此两件事必须机器守住：
 *   ① 链接不能死（related 指向不存在的 slug ＝ 上线即 404）；
 *   ② 内容里不能出现**任何使用量数字**（真实计数尚未上线，写一个就是造假）。
 */
import { describe, expect, it } from 'vitest';
import { DEMO_SEED_TERMS, REVIEW_INTERVALS_DAYS } from '@sb/shared';
import { PUBLIC_TERMS, findPublicTerm, relatedTerms, termPath, termUrl } from './term-corpus';
import { termDescription } from './term-page';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('词条语料 · 形状', () => {
  it('★ 体验号种子的词条名逐个能在本语料里找到（两边同名同源，漂一个字即刻红）', () => {
    // 为什么锁在 web 侧：种子常量住在 `@sb/shared`（server 写库要读它），而公开语料住在这里——
    // 只有这个文件能同时看见两边。访客从讲解页点进产品，词条库里那个概念**必须同名**。
    const titles = new Set(PUBLIC_TERMS.map((t) => t.title));
    expect(DEMO_SEED_TERMS.length).toBeGreaterThan(0);
    for (const s of DEMO_SEED_TERMS) expect(titles.has(s.term), s.term).toBe(true);
  });

  it('★ 十二条齐备，slug 唯一且是纯 ASCII（发版 tar 链路不引入编码变量）', () => {
    expect(PUBLIC_TERMS).toHaveLength(12);
    const slugs = PUBLIC_TERMS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(SLUG_RE);
    expect(new Set(PUBLIC_TERMS.map((t) => t.title)).size).toBe(PUBLIC_TERMS.length);
  });

  it('每条字段都填够一页：≥2 小节、每节 ≥2 段、3 误区、3 动作、产品落点非空', () => {
    for (const t of PUBLIC_TERMS) {
      expect(t.sections.length, t.slug).toBeGreaterThanOrEqual(2);
      for (const sec of t.sections) {
        expect(sec.h.length, `${t.slug} 小节标题`).toBeGreaterThan(0);
        expect(sec.p.length, `${t.slug}/${sec.h}`).toBeGreaterThanOrEqual(2);
        for (const p of sec.p) expect(p.length, `${t.slug}/${sec.h}`).toBeGreaterThan(20);
      }
      expect(t.pitfalls, t.slug).toHaveLength(3);
      expect(t.actions, t.slug).toHaveLength(3);
      expect(t.productHint.length, t.slug).toBeGreaterThan(10);
      expect(t.alias.length, t.slug).toBeGreaterThan(0);
    }
  });

  it('★ related 全部指得出去（死链上线＝给爬虫留 404），且互链落在 2～3 条', () => {
    for (const t of PUBLIC_TERMS) {
      for (const r of t.related) expect(findPublicTerm(r), `${t.slug} → ${r}`).toBeDefined();
      expect(t.related.length, t.slug).toBeGreaterThanOrEqual(2);
      expect(t.related.length, t.slug).toBeLessThanOrEqual(3);
      expect(relatedTerms(t).length, t.slug).toBeGreaterThanOrEqual(2);
      expect(relatedTerms(t).some((r) => r.slug === t.slug), t.slug).toBe(false);
    }
  });

  it('URL 形状：termPath 带 .html（无扩展名会被线上 Caddy 兜成 SPA 壳），canonical 是绝对地址', () => {
    for (const t of PUBLIC_TERMS) {
      expect(termPath(t)).toBe(`/terms/${t.slug}.html`);
      expect(termUrl(t)).toBe(`https://11wand.com${termPath(t)}`);
      expect(termUrl(t)).toMatch(/^https:\/\/11wand\.com\/terms\/[a-z0-9-]+\.html$/);
    }
  });

  it('★ meta description 有预算：超长的部分搜索引擎会掐掉，掐在哪里不由我们运气决定', () => {
    for (const t of PUBLIC_TERMS) {
      const d = termDescription(t);
      expect(d.length, t.slug).toBeLessThanOrEqual(105);
      expect(d.startsWith(t.oneLine), t.slug).toBe(true);
    }
  });
});

describe('词条语料 · 主词措辞（档位 1）', () => {
  /** 改名的三件：新主词 ＋ 页面上必须仍然看得见的旧名。换叫法不许把原来那条搜索意图丢掉。 */
  const RENAMED: readonly { slug: string; title: string; old: string }[] = [
    { slug: 'tiqu-lixian', title: '主动回忆', old: '提取练习' },
    { slug: 'jiao-cuo-lixian', title: '交错学习', old: '交错练习' },
    { slug: 'yiwang-quxian', title: '艾宾浩斯遗忘曲线', old: '遗忘曲线' },
  ];

  it('★ 三个主词是中文里活着的那种叫法，旧名逐字还在页面上', () => {
    for (const { slug, title, old } of RENAMED) {
      const t = findPublicTerm(slug);
      expect(t, slug).toBeDefined();
      expect(t!.title, slug).toBe(title);
      const page = [
        t!.alias,
        t!.oneLine,
        ...t!.sections.flatMap((s) => [s.h, ...s.p]),
        ...t!.pitfalls,
        ...t!.actions,
        t!.productHint,
      ].join('\n');
      expect(page.includes(old), `${slug} 丢了旧名 ${old}`).toBe(true);
    }
  });

  it('★ 间隔重复首屏摆出七个复习节点，且与产品契约 `REVIEW_INTERVALS_DAYS` 同值同序', () => {
    const t = findPublicTerm('jian-ge-chongfu');
    expect(t).toBeDefined();
    const first = t!.sections[0];
    const text = first.h + first.p.join('');
    for (const d of REVIEW_INTERVALS_DAYS) {
      expect(text.includes(String(d)), `首屏缺节点 ${d}`).toBe(true);
    }
    const nums = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
    expect(nums.slice(0, REVIEW_INTERVALS_DAYS.length)).toEqual([...REVIEW_INTERVALS_DAYS]);
  });

  it('★「复习计划表」真的写进了遗忘曲线的正文，不是只挂在 title 上', () => {
    const t = findPublicTerm('yiwang-quxian');
    expect(t).toBeDefined();
    expect(t!.title).toContain('艾宾浩斯');
    const body = t!.sections.flatMap((s) => [s.h, ...s.p]).join('\n');
    expect(body).toContain('复习计划表');
  });

  it('★ 费曼页给了「四步」并配一个走到底的例子（讲解页最缺的就是一个具体样子）', () => {
    const t = findPublicTerm('fei-man-xuexi-fa');
    expect(t).toBeDefined();
    expect(t!.sections.map((s) => s.h).join('\n')).toContain('四步');
    const body = t!.sections.flatMap((s) => s.p).join('\n');
    expect(body).toContain('例子');
    expect(body).toContain('光合作用');
  });

  it('★ 认知负荷按老板判决保持书面：它不在改名清单里，title 逐字未动', () => {
    const t = findPublicTerm('renzhi-fuhe');
    expect(t).toBeDefined();
    expect(t!.title).toBe('认知负荷');
  });

  it('★ 中文正文不混未成句的英文、不漏 markdown 星号（本批逮到 `harder` 与 `**辨别**` 两处）', () => {
    const ALLOWED = new Set(['AI', 'AAA', 'BBB', 'CCC', 'ABC', 'CAB']);
    for (const t of PUBLIC_TERMS) {
      const prose = [
        ...t.sections.flatMap((s) => [s.h, ...s.p]),
        ...t.pitfalls,
        ...t.actions,
        t.productHint,
      ].join('\n');
      expect(prose.includes('*'), `${t.slug} 正文含 *`).toBe(false);
      for (const m of prose.matchAll(/[A-Za-z]+/g)) {
        expect(ALLOWED.has(m[0]), `${t.slug} 正文里的英文词 ${m[0]}`).toBe(true);
      }
    }
  });
});

describe('词条语料 · 诚实红线', () => {
  const allText = JSON.stringify(PUBLIC_TERMS);

  it('★ 不写任何使用量／人数／评价类数字（真实计数未上线前，写一个就是造假）', () => {
    expect(allText).not.toMatch(/已有.{0,8}人/);
    expect(allText).not.toMatch(/\d+\s*(名|位|人).{0,6}(用户|学生|学习者|正在|体验|使用)/);
    expect(allText).not.toMatch(/(超过|突破)\s*\d+/);
    expect(allText).not.toMatch(/(\d+(,\d{3})*|[\n一-龥]+)\s*(好评|五星|满意度)/);
    expect(allText).not.toMatch(/上万|百万|无数用户/);
  });

  it('★ 不许诺学习效果（可以讲机制，不能讲包过／提分／记忆力提升）', () => {
    expect(allText).not.toMatch(/包过|保过|提分|成绩(提升|提高)\s*\d+|记忆力(提升|增强)/);
    expect(allText).not.toMatch(/保证.{0,6}(记住|学会|通过)/);
  });

  it('产品落点只描述机制，不冒充第三方背书', () => {
    for (const t of PUBLIC_TERMS) {
      expect(t.productHint, t.slug).toMatch(/本产品/);
      expect(t.productHint, t.slug).not.toMatch(/(?:用户|学生)都|大家都|很多人用/);
    }
  });
});
