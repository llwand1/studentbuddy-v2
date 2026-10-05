import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCollectReport } from '@sb/shared';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../search/index.js', () => ({ getProviderKey: () => '' }));
vi.mock('../search/ssrf-guard.js', () => ({ fetchSafe: fetchMock }));
const { collectPages, selectCollectText } = await import('./collect-pages.js');
const answer = 'Java 并发线程池的拒绝策略有哪些？AbortPolicy 会抛出异常，CallerRunsPolicy 由调用线程执行任务。';
const html = (body: string) => `<title>Java 并发</title><main>${body}</main>`;
const response = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
beforeEach(() => fetchMock.mockReset());

describe('搜集页面的主题窗口', () => {
  it('题干在 25000 字以后仍能连同答案完整读到，正文预算不超限', () => {
    const text = `${'无关内容。'.repeat(9000)}${answer}${'更多无关内容。'.repeat(2000)}`;
    const selected = selectCollectText(text, 'Java 线程池 拒绝策略');
    expect(selected).toContain(answer);
    expect(selected.length).toBeLessThanOrEqual(25_000);
    expect(selected.length).toBeGreaterThan(300);
  });

  it('空泛主题或不相关正文不送进摘题模型', () => {
    expect(selectCollectText('只有导航链接', '面试题 资料')).toBe('');
    expect(selectCollectText('Python 的生成器使用 yield', 'Java 线程池')).toBe('');
  });

  it('短正文保持原文，答案和材料不被摘要改写', () => {
    expect(selectCollectText(answer, 'Java 线程池')).toBe(answer);
  });

  it('范围参数穿过逐跳抓页，先失败的候选不吃掉成功页预算', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(response(html(answer.repeat(15))));
    const report = emptyCollectReport();
    const pages = await collectPages([{ url: 'https://study.example/a', title: 'A' }, { url: 'https://study.example/b', title: 'B' }], report,
      { topic: 'Java 线程池', allowHosts: ['study.example'] });
    expect(pages).toHaveLength(1);
    expect(report.pages[0]?.reason).toBe('HTTP 403');
    expect(pages[0]?.text).toContain(answer);
    expect(fetchMock).toHaveBeenLastCalledWith('https://study.example/b', expect.any(Object), 4, ['study.example']);
  });

  it('应试搜集复用网页解码，GBK 题目不能变成乱码后被漏掉', async () => {
    const phrase = Buffer.from('d3a2d3efb6a8d3efb4d3bee4', 'hex');
    const bytes = Buffer.concat([Buffer.from('<title>'), phrase, Buffer.from('</title><main>'),
      ...Array.from({ length: 100 }, () => phrase), Buffer.from('</main>')]);
    fetchMock.mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'text/html; charset=gbk' } }));
    const pages = await collectPages([{ url: 'https://study.example/a', title: '原标题' }], emptyCollectReport(), { topic: '高考英语 定语从句' });
    expect(pages[0]?.title).toBe('英语定语从句');
    expect(pages[0]?.text).toContain('英语定语从句');
    expect(pages[0]?.text).not.toContain('\uFFFD');
  });

  it('导航中的主题词不能让无关正文变成可摘录资料', async () => {
    fetchMock.mockResolvedValue(response(`<title>资料</title><nav>Java 线程池</nav><main>${'无关页面。'.repeat(200)}</main>`));
    const report = emptyCollectReport();
    expect(await collectPages([{ url: 'https://study.example/a', title: '资料' }], report, { topic: 'Java 线程池' })).toEqual([]);
    expect(report.pages[0]?.reason).toContain('没有与本次主题');
  });

  it('长文窗口保留带 alt 的题图，跨页图编号不因窗口过滤出现重复', async () => {
    const images = Array.from({ length: 9 }, (_, i) => `<img src="https://study.example/${i}.png" width="100" height="100">`).join('');
    const image = '<img src="https://study.example/question.png" width="100" height="100" alt="线程池结构">';
    fetchMock.mockResolvedValueOnce(response(html(`${images}${'无关内容。'.repeat(9000)}${answer}${image}${'末尾。'.repeat(200)}`)))
      .mockResolvedValueOnce(response(html(`${answer.repeat(15)}${image}`)));
    const report = emptyCollectReport();
    const pages = await collectPages([{ url: 'https://study.example/a', title: 'A' }, { url: 'https://study.example/b', title: 'B' }], report, { topic: 'Java 线程池' });
    expect(pages[0]?.figures.map((f) => f.n)).toEqual([10]);
    expect(pages[0]?.text).toContain('[图10:线程池结构]');
    expect(pages[1]?.figures[0]?.n).toBe(11);
  });

  it('模式关闭保留原来的页首窗口，取消后不再发请求', async () => {
    const body = `${'页首内容。'.repeat(6000)}${answer}`;
    fetchMock.mockResolvedValue(response(html(body)));
    const pages = await collectPages([{ url: 'https://study.example/a', title: '原标题' }], emptyCollectReport());
    expect(pages[0]?.title).toBe('原标题');
    expect(pages[0]?.text).not.toContain('AbortPolicy');
    fetchMock.mockClear();
    expect(await collectPages([{ url: 'https://study.example/a', title: 'A' }], emptyCollectReport(), { signal: AbortSignal.abort() })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
