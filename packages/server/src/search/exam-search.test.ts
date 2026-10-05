import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExamContext } from '../learning/exam-mode.js';

const mock = vi.hoisted(() => ({ search: vi.fn(), page: vi.fn(), direct: vi.fn() }));
vi.mock('./index.js', () => ({ searchWeb: mock.search }));
vi.mock('./exam-page.js', () => ({ fetchExamPage: mock.page }));
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
    expect(mock.page).toHaveBeenLastCalledWith('https://study.example/java', null, expect.objectContaining({ allowHosts: ['study.example'], timeoutMs: 6000 }));
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

  it('关模式保持原入口、owner、选项与结果；范围内通用命中仍需正文验证', async () => {
    const base = { results: [1, 2, 3].map((i) => ({ title: 'Java', url: `https://study.example/${i}`, snippet: 'Java', source: 'bing' })), providers: ['bing'], failed: [], dropped: 0 };
    mock.search.mockResolvedValue(base);
    const options = { skipCache: true, signal: new AbortController().signal };
    const c = context(); c.on = false;
    expect(await searchExamWeb('Java', 'u1', c, options)).toEqual({ ...base, directSites: [], unavailable: false });
    expect(mock.search).toHaveBeenLastCalledWith('Java', 'u1', options);
    expect(mock.page).not.toHaveBeenCalled();
    expect(mock.direct).not.toHaveBeenCalled();
    mock.page.mockImplementation(async (url: string) => page(url.endsWith('/1') ? 'Java 泛型采用类型擦除实现。' : '没有相关正文'));
    const r = await searchExamWeb('Java', 'u1', context());
    expect(r.results.map((h) => h.url)).toEqual(['https://study.example/1']);
    expect(mock.page).toHaveBeenCalled();
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

  it('不能用培训广告页的关键词堆叠冒充学习资料', async () => {
    mock.page.mockResolvedValue({ ...page('Java 并发线程池的培训内容'), title: 'Java 私教求职辅导' });
    expect((await searchExamWeb('Java 并发', null, context())).results).toEqual([]);
    await searchExamWeb('Java 并发', null, context(['https://study.example/sijiao_offer.html']));
    expect(mock.page).toHaveBeenCalledTimes(1);
  });

  it('具体长主题需要足够的正文覆盖，只有三个泛化词不能算相关', async () => {
    mock.page.mockResolvedValue(page('Java 并发 线程 学习目录'));
    expect((await searchExamWeb('Java 并发 线程池 拒绝策略 核心线程数', null, context())).results).toEqual([]);
    mock.page.mockResolvedValue(page('Java 并发的线程池包含核心线程数、队列以及拒绝策略。'));
    expect((await searchExamWeb('Java 并发 线程池 拒绝策略 核心线程数', null, context())).results).toHaveLength(1);
  });

  it('高考英语的科目导航不能代替定语从句这个具体考点', async () => {
    mock.page.mockResolvedValue(page('高考英语的真题目录和英语复习计划'));
    expect((await searchExamWeb('高考英语 定语从句', null, context())).results).toEqual([]);
    mock.page.mockResolvedValue(page('英语定语从句使用关系代词连接先行词与从句。'));
    expect((await searchExamWeb('高考英语 定语从句', null, context())).results).toHaveLength(1);
  });

  it('题库目录只能用于发现真实详情，不能直接当作出题参考', async () => {
    mock.page.mockImplementation(async (url: string) => url.endsWith('/java')
      ? page('Java 并发线程池的拒绝策略包括抛出异常与调用者执行。')
      : { ...page('Java 并发线程池目录', '<a href="/java">Java 并发线程池</a>'), title: '题库大全' });
    const r = await searchExamWeb('Java 并发线程池', null, context(), { purpose: 'quiz' });
    expect(r.results.map((h) => h.url)).toEqual(['https://study.example/java']);
  });

  it('HashMap 查询优先发现集合题页，不能被线程安全等泛化链接吃掉预算', async () => {
    const noise = Array.from({ length: 8 }, (_, i) => `<a href="/pool-${i}">Java 线程池的线程安全</a>`).join('');
    mock.page.mockImplementation(async (url: string) => url.endsWith('/collections')
      ? { ...page('Java HashMap 是非线程安全的，并发写入可能丢失数据。'), title: 'Java集合面试题' }
      : page('栏目目录', `${noise}<a href="/collections">Java 集合面试题</a>`));
    const r = await searchExamWeb('Java HashMap 的线程安全', null, context(), { purpose: 'quiz' });
    expect(r.results.map((h) => h.url)).toEqual(['https://study.example/collections']);
    expect(mock.page.mock.calls.some((c: unknown[]) => String(c[0]).includes('collections'))).toBe(true);
    expect(mock.page.mock.calls.length).toBeLessThanOrEqual(1 + MAX_EXAM_DETAIL_PAGES);
  });

  it('站内候选只有目录时，在同一抓页预算里继续读其具体题页', async () => {
    mock.direct.mockResolvedValue({ links: [{ title: 'Java 并发题库大全', url: 'https://study.example/banks', snippet: '', source: 'direct' }], sites: ['技术资料'], failed: [] });
    mock.page.mockImplementation(async (url: string) => url.endsWith('/banks')
      ? { ...page('Java 并发题库列表', '<a href="/question/1">Java 并发拒绝策略</a>'), title: 'Java 并发题库大全' }
      : url.endsWith('/question/1') ? page('Java 并发线程池的拒绝策略包括抛出异常与调用者执行。') : page('无关内容'));
    const r = await searchExamWeb('Java 并发', null, context(), { purpose: 'collect' });
    expect(r.results.map((h) => h.url)).toEqual(['https://study.example/question/1']);
    expect(mock.page).toHaveBeenCalledTimes(3);
  });

  it('验证码占位页明确报无法读取，不当作零命中或相关资料', async () => {
    mock.page.mockResolvedValue({ ...page('Java 并发资料'), title: '滑动验证页面' });
    const r = await searchExamWeb('Java 并发', null, context(), { purpose: 'quiz' });
    expect(r.results).toEqual([]);
    expect(r.failed.join()).toContain('页面要求验证，无法读取正文');
  });

  it('英文主题都出现仍须覆盖中文考点，HashMap 加线程目录不代表线程安全资料', async () => {
    mock.page.mockResolvedValue(page('Java HashMap 底层是数组，线程池题目请点击其它栏目。'));
    expect((await searchExamWeb('Java HashMap 的线程安全', null, context())).results).toEqual([]);
    mock.page.mockResolvedValue(page('Java HashMap 是非线程安全的，多线程并发写入需要同步。'));
    expect((await searchExamWeb('Java HashMap 的线程安全', null, context())).results).toHaveLength(1);
  });
});
