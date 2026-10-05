/**
 * exam-direct 回归锁：站内直达的链接挑选与逐站降级。
 * 零真实网络——检索页 HTML 用桩，`fetchPageText` 整体 mock（它是全仓「网址→正文」的唯一实现）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExamSource } from '@sb/shared';

const pageTextMock = vi.hoisted(() => vi.fn());
vi.mock('../search/page-text.js', () => ({
  fetchPageText: pageTextMock,
  PAGE_FETCH_TIMEOUT_MS: 15000,
}));

const { directLinksOf, examDirectPages, examEntryLinks, MAX_DIRECT_LINKS_PER_SITE, MAX_DIRECT_TOTAL } =
  await import('./exam-direct.js');

const HOSTS = ['huatu.com', 'aipta.com', 'jianshe99.com'];
const SEARCH_URL = 'https://so.huatu.com/index/search/search.html?q=%E5%9B%BD%E8%80%83';

function html(anchors: string): string {
  return `<html><body><div id="results">${anchors}</div></body></html>`;
}

describe('directLinksOf：从检索页挑同域题页', () => {
  it('留下带考试特征的题链，标题取锚文本', () => {
    const out = directLinksOf(
      html(`
        <a href="/gwy/2024/zhenti.html">2024 年国考行测真题及答案</a>
        <a href="https://so.huatu.com/zt/2025/index.html">2025 面试备考专题</a>
        <a href="https://www.aipta.com/article/10306.html">考研政治真题解析</a>
      `),
      SEARCH_URL,
      HOSTS,
    );
    expect(out.map((r) => r.url)).toEqual([
      'https://so.huatu.com/gwy/2024/zhenti.html',
      'https://so.huatu.com/zt/2025/index.html',
      'https://www.aipta.com/article/10306.html',
    ]);
    expect(out[0]?.title).toContain('2024 年国考行测真题');
    expect(out[0]?.source).toBe('direct');
    expect(out[0]?.snippet).toBe(''); // 直达只负责「该抓哪页」，正文归 collect
  });

  it('★ 范围外的链接一条都不许留下（直达本身不是免检通道）', () => {
    const out = directLinksOf(
      html(`
        <a href="https://baike.baidu.com/item/行测">行测_百科</a>
        <a href="https://xhuatu.com/gwy/zhenti">仿冒域真题</a>
        <a href="https://zhihu.com/question/1">真题哪里有</a>
      `),
      SEARCH_URL,
      HOSTS,
    );
    expect(out).toEqual([]);
  });

  it('导航/登录/静态资源/无考试特征的链接一律不要', () => {
    const out = directLinksOf(
      html(`
        <a href="/login">登录</a>
        <a href="/about">关于我们</a>
        <a href="/style/site.css">真题样式</a>
        <a href="javascript:void(0)">真题弹窗</a>
        <a href="#anchor">本页真题锚点</a>
        <a href="/gwy/navigation/">栏目导航</a>
      `),
      SEARCH_URL,
      HOSTS,
    );
    expect(out).toEqual([]);
  });

  it('检索页自身与重复链接不入选；相对路径按最终地址解析', () => {
    const dupe = `
      <a href="/gwy/zhenti.html">真题一</a>
      <a href="https://so.huatu.com/gwy/zhenti.html">真题一（绝对写法）</a>
      <a href="${SEARCH_URL}">回到搜索</a>
    `;
    const out = directLinksOf(html(dupe), SEARCH_URL, HOSTS);
    expect(out.map((r) => r.url)).toEqual(['https://so.huatu.com/gwy/zhenti.html']);
  });

  it('每站封顶，防止把整页导航当题链收走', () => {
    const many = Array.from(
      { length: MAX_DIRECT_LINKS_PER_SITE + 6 },
      (_, i) => `<a href="/gwy/zhenti-${i}.html">第${i}套真题</a>`,
    ).join('');
    expect(directLinksOf(html(many), SEARCH_URL, HOSTS)).toHaveLength(MAX_DIRECT_LINKS_PER_SITE);
  });

  it('坏 baseUrl / 无锚文本时不抛，返回空', () => {
    expect(directLinksOf('<a href="x">真题</a>', '不是 URL', HOSTS)).toEqual([]);
    expect(directLinksOf('<a href="/tiku/1.html"></a>', SEARCH_URL, HOSTS)).toEqual([]);
  });
});

describe('examEntryLinks：固定入口页（求职面试组的取题主力）', () => {
  const src = (over: Partial<ExamSource>): ExamSource => ({
    host: 'javaguide.cn',
    label: 'JavaGuide',
    tier: 'question',
    packs: ['tech-interview'],
    entries: [
      { url: 'https://javaguide.cn/zhuanlan/interview-guide.html', label: '面试指南', verifiedAt: '2026-10-05' },
      { url: 'https://www.javaguide.cn/interview-preparation/backend-interview-plan.html', label: '后端面试准备', verifiedAt: '2026-10-05' },
    ],
    ...over,
  });

  it('范围内的站 ⇒ 入口页原样进候选（不查任何搜索引擎）', () => {
    const out = examEntryLinks([src({})], ['javaguide.cn']);
    expect(out.map((r) => r.url)).toEqual([
      'https://javaguide.cn/zhuanlan/interview-guide.html',
      'https://www.javaguide.cn/interview-preparation/backend-interview-plan.html',
    ]);
    expect(out[0]?.title).toBe('JavaGuide｜面试指南');
    expect(out[0]?.source).toBe('entry');
  });

  it('★ 站被取消勾选 ⇒ 入口页一起消失（不许因为"它在表上"就绕过范围）', () => {
    expect(examEntryLinks([src({})], ['other.example'])).toEqual([]);
    expect(examEntryLinks([src({})], [])).toEqual([]);
  });

  it('没有 entries 的站返回空；重复 URL 只留一条', () => {
    expect(examEntryLinks([src({ entries: undefined })], ['javaguide.cn'])).toEqual([]);
    const dup = src({ host: 'x.com', entries: [{ url: 'https://x.com/a', label: 'A', verifiedAt: '2026-10-05' }] });
    const dup2 = src({ host: 'x.com', label: 'X2', entries: [{ url: 'https://x.com/a', label: 'A2', verifiedAt: '2026-10-05' }] });
    expect(examEntryLinks([dup, dup2], ['x.com'])).toHaveLength(1);
  });

  it('入口页 URL 落在站域之外 ⇒ 丢（登记表写错也不越界）', () => {
    const bad = src({ entries: [{ url: 'https://evil.example/x', label: '坏行', verifiedAt: '2026-10-05' }] });
    expect(examEntryLinks([bad], ['javaguide.cn'])).toEqual([]);
  });
});

describe('examDirectPages：逐站降级与站点账', () => {
  // ★ 钩子体必须带花括号：`() => pageTextMock.mockReset()` 会把 **spy 本身**当返回值交出去
  //   （vitest 的 spy 方法可链式、返回自己），而 vitest 见到「钩子返回函数」就当清理回调再调一次——
  //   于是实现里凭空多出一个零参数调用（2026-10-04 写这组用例时当场撞上，报错长得像被测代码的 bug）。
  beforeEach(() => {
    pageTextMock.mockReset();
  });

  const hit = (label: string, url: string) => {
    const [host, name] = label.split('|');
    return { host: host!, label: name ?? host!, url };
  };

  it('成功的站进 sites，失败的站把真因写进 failed，一条都不静默', async () => {
    pageTextMock.mockImplementation(async (url: string) => {
      if (url.includes('aipta')) {
        return { ok: true, html: html('<a href="/article/9.html">高考数学真题及答案</a>'), text: 'x', title: '爱真题' };
      }
      if (url.includes('huatu')) return { ok: false, kind: 'fetch', reason: 'HTTP 403' };
      return { ok: false, kind: 'empty', title: '' };
    });
    const res = await examDirectPages(
      [hit('aipta.com|爱真题', 'https://www.aipta.com/index.php?s=x'), hit('huatu.com|华图', 'https://so.huatu.com/q=x'), hit('jianshe99.com|建工', 'https://kuaisoo.jianshe99.com/s?wd=x')],
      HOSTS,
    );
    expect(res.sites).toEqual(['爱真题']);
    expect(res.failed).toEqual(['华图: HTTP 403', '建工: 无正文（JS 渲染）']);
    expect(res.links.map((l) => l.url)).toEqual(['https://www.aipta.com/article/9.html']);
  });

  it('零候选的站不算成功（sites 只记真出了题链的）', async () => {
    pageTextMock.mockResolvedValue({ ok: true, html: html('<a href="/nav">栏目</a>'), text: 'x', title: 't' });
    const res = await examDirectPages([hit('huatu.com|华图', 'https://so.huatu.com/q=1')], HOSTS);
    expect(res.sites).toEqual([]);
    expect(res.links).toEqual([]);
  });

  it('超过 6 个站点只打前 6 个（每站一次 HTTP，出题不能等到天荒地老）', async () => {
    pageTextMock.mockResolvedValue({ ok: true, html: html(''), text: '', title: '' });
    const many = Array.from({ length: 9 }, (_, i) => hit(`s${i}.com|站${i}`, `https://s${i}.com/search?q=x`));
    const res = await examDirectPages(many, HOSTS);
    expect(pageTextMock.mock.calls.length).toBeLessThanOrEqual(6);
    expect(res.links).toEqual([]);
  });

  it('总数封顶生效，且跨站重复链接只留一条', async () => {
    pageTextMock.mockImplementation(async (url: string) => {
      const n = url.split('/s')[1] ?? '0';
      const anchors = Array.from(
        { length: 8 },
        (_, i) => `<a href="https://www.aipta.com/a/${n}-${i}.html">真题${n}-${i}</a>`,
      ).join('');
      return { ok: true, html: html(anchors), text: 'x', title: 't' };
    });
    const sites = Array.from({ length: 6 }, (_, i) => hit(`aipta.com|爱真题${i}`, `https://www.aipta.com/s${i}`));
    const res = await examDirectPages(sites, ['aipta.com']);
    // 每站 6 条（`MAX_DIRECT_LINKS_PER_SITE`）×6 站＝36 条候选，收口到总量上限 18
    expect(res.links.length).toBe(Math.min(MAX_DIRECT_TOTAL, 36));
    expect(new Set(res.links.map((l) => l.url)).size).toBe(res.links.length);
    expect(res.sites).toHaveLength(6);
  });
});
