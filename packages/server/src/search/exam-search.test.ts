import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExamContext } from '../learning/exam-mode.js';

const mock = vi.hoisted(() => ({ search: vi.fn(), page: vi.fn(), direct: vi.fn() }));
vi.mock('./index.js', () => ({ searchWeb: mock.search }));
vi.mock('./page-text.js', () => ({ fetchPageText: mock.page }));
vi.mock('./exam-direct.js', async (original) => ({
  ...await original<typeof import('./exam-direct.js')>(), examDirectPages: mock.direct,
}));
const { searchExamWeb, MAX_EXAM_ENTRY_PAGES, MAX_EXAM_DETAIL_PAGES } = await import('./exam-search.js');
const { conflictingLanguage, examTopicQuery, topicLinksOf } = await import('./exam-query.js');

function context(entries = ['https://study.example/guide']): ExamContext {
  return {
    on: true, hosts: ['study.example'], summary: '技术面试', signature: 'test',
    sources: [{ host: 'study.example', label: '技术资料', tier: 'question', packs: ['tech-interview'], note: '',
      entries: entries.map((url) => ({ url, label: '学习指南', verifiedAt: '2026-10-05' })),
    }],
  };
}
function page(body: string, links = '') {
  const html = `<html><title>技术资料</title><nav>Java 导航词</nav><main>${body}</main>${links}</html>`;
  return { ok: true, html, text: `Java 导航词 ${body}`.replace(/<[^>]+>/g, ''), title: '技术资料' };
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.search.mockResolvedValue({ results: [], providers: ['bing'], failed: [], dropped: 8 });
  mock.direct.mockResolvedValue({ links: [], sites: [], failed: [] });
  mock.page.mockResolvedValue(page('没有与查询相关的内容'));
});

describe('应试搜索的真实页面补充', () => {
  it('通用结果全部被滤掉，仍能从长文后半段取得真实相关片段', async () => {
    mock.page.mockResolvedValue(page(`${'填充内容。'.repeat(7000)}Java 并发使用线程池控制任务执行。`));
    const r = await searchExamWeb('Java 并发 面试题', 'user-a', context());
    expect(r.results).toHaveLength(1);
    expect(r.results[0]?.snippet).toContain('线程池');
    expect(r.results[0]?.url).toBe('https://study.example/guide');
    expect(r.providers).toContain('entry');
    expect(r.directSites).toEqual(['技术资料']);
    expect(r.dropped).toBe(8);
    expect(mock.search).toHaveBeenCalledWith('Java 并发 面试题', 'user-a', expect.objectContaining({ allowHosts: ['study.example'] }));
  });

  it('登记的入口页不是命中：正文无相关词、只有导航词时仍为空', async () => {
    const r = await searchExamWeb('Java 面试', null, context());
    expect(r.results).toEqual([]);
    expect(r.providers).not.toContain('entry');
    mock.search.mockResolvedValue({ results: [], providers: [], failed: ['Bing 超时'], dropped: 0 });
    expect((await searchExamWeb('Java', null, context())).unavailable).toBe(false);
  });

  it('从已经读过的入口页发现相关详情，只抓范围内页面', async () => {
    mock.page.mockImplementation(async (url: string) => url.endsWith('/java')
      ? page('Java 并发的线程池有核心线程和任务队列。')
      : page('入口页没有正文命中', '<a href="/java">Java 并发</a><a href="https://evil.example/java">Java 并发</a>'));
    const r = await searchExamWeb('Java 并发', null, context());
    expect(r.results.map((h) => h.url)).toEqual(['https://study.example/java']);
    expect(mock.page.mock.calls.map((c: unknown[]) => c[0])).toEqual(['https://study.example/guide', 'https://study.example/java']);
    expect(mock.page).toHaveBeenLastCalledWith('https://study.example/java', expect.objectContaining({ allowHosts: ['study.example'], timeoutMs: 6000 }));
  });

  it('单站抓取失败不阻断其它站；站内检索结果也必须实际读取正文', async () => {
    mock.direct.mockResolvedValue({ links: [{ title: 'Java 题', url: 'https://study.example/direct', snippet: '', source: 'direct' }], sites: ['技术资料'], failed: ['另一站: HTTP 403'] });
    mock.page.mockImplementation(async (url: string) => url.endsWith('/direct') ? page('Java 泛型通过类型擦除实现。') : { ok: false, kind: 'fetch', reason: 'HTTP 403' });
    const r = await searchExamWeb('Java 泛型', null, context());
    expect(r.results[0]?.source).toBe('direct');
    expect(r.results[0]?.snippet).toContain('类型擦除');
    expect(r.failed).toContain('另一站: HTTP 403');
  });

  it('空范围与已取消请求均不发外部请求', async () => {
    const c = context(); c.hosts = [];
    expect((await searchExamWeb('Java', null, c)).results).toEqual([]);
    expect((await searchExamWeb('Java', null, context(), { signal: AbortSignal.abort() })).results).toEqual([]);
    expect(mock.search).not.toHaveBeenCalled();
    expect(mock.page).not.toHaveBeenCalled();
  });

  it('关模式保持原入口、owner、选项与结果；已足够的通用命中不触发补充抓页', async () => {
    const base = { results: [1, 2, 3].map((i) => ({ title: 'Java', url: `https://study.example/${i}`, snippet: 'Java', source: 'bing' })), providers: ['bing'], failed: [], dropped: 0 };
    mock.search.mockResolvedValue(base);
    const options = { skipCache: true, signal: new AbortController().signal };
    const c = context(); c.on = false;
    expect(await searchExamWeb('Java', 'u1', c, options)).toEqual({ ...base, directSites: [], unavailable: false });
    expect(mock.search).toHaveBeenLastCalledWith('Java', 'u1', options);
    await searchExamWeb('Java', 'u1', context());
    expect(mock.page).not.toHaveBeenCalled();
    expect(mock.direct).not.toHaveBeenCalled();
  });

  it('入口页与详情页都有硬数量预算，不会递归遍历', async () => {
    mock.page.mockResolvedValue(page('入口内容', Array.from({ length: 20 }, (_, i) => `<a href="/java-${i}">Java ${i}</a>`).join('')));
    const r = await searchExamWeb('Java', null, context(Array.from({ length: 30 }, (_, i) => `https://study.example/entry-${i}`)));
    expect(r.results).toEqual([]);
    expect(mock.page).toHaveBeenCalledTimes(MAX_EXAM_ENTRY_PAGES + MAX_EXAM_DETAIL_PAGES);
  });

  it('范围外站内候选和外部链接均不会被请求或返回', async () => {
    mock.direct.mockResolvedValue({ links: [{ title: 'Java', url: 'https://evil.example/java', snippet: 'Java', source: 'direct' }], sites: [], failed: [] });
    await searchExamWeb('Java', null, context());
    expect(mock.page).toHaveBeenCalledTimes(1);
    expect(topicLinksOf('<a href="https://evil.example/java">Java</a>', 'https://study.example/', ['study.example'], 'Java')).toEqual([]);
  });

  it('只给泛化导航词时不把任意入口登记成命中', async () => {
    expect(examTopicQuery('面试题 答案 解析')).toBe('');
    expect((await searchExamWeb('面试题 答案 解析', null, context())).results).toEqual([]);
    expect(mock.page).not.toHaveBeenCalled();
  });

  it('Java 并发查询不能由只有并发的 Go 正文或只有 Java 的目录补成成功', async () => {
    expect(conflictingLanguage('C++ 面试题', 'Java')).toBe(true);
    expect(conflictingLanguage('Java 面试题', 'Java vs Python')).toBe(false);
    mock.page.mockResolvedValue(page('Go 并发的 Goroutine 使用通道通信。Java 题库列表在另一个栏目。'));
    const r = await searchExamWeb('Java 并发', null, context());
    // 同一小段确实同时谈到两词时可作为相关参考；语言完全不匹配则必须拦。
    expect(r.results).toHaveLength(1);
    mock.page.mockResolvedValue(page('Go 并发的 Goroutine 使用通道通信。'));
    expect((await searchExamWeb('Java 并发', null, context())).results).toEqual([]);
    mock.page.mockResolvedValue(page('Java 学习目录和安装配置。'));
    expect((await searchExamWeb('Java 并发', null, context())).results).toEqual([]);
  });
});
