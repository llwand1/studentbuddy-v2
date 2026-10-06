import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ read: vi.fn(), render: vi.fn(), key: vi.fn() }));
vi.mock('./index.js', () => ({ getProviderKey: mock.key }));
vi.mock('./page-text.js', async (original) => ({ ...await original<typeof import('./page-text.js')>(), fetchPageText: mock.read }));
vi.mock('./tinyfish.js', () => ({ tinyfishPage: mock.render }));
const { fetchExamPage } = await import('./exam-page.js');
const url = 'https://javaguide.cn/java';
const rendered = { ok: true, html: '<main>实际正文</main>', text: '实际正文'.repeat(200), title: 'Java' };
beforeEach(() => { vi.resetAllMocks(); mock.key.mockReturnValue('test-key'); mock.render.mockResolvedValue(rendered); });
describe('应试正文补读', () => {
  it('可读长正文不调用渲染服务', async () => {
    mock.read.mockResolvedValue(rendered);
    expect(await fetchExamPage(url, 'user-a')).toEqual(rendered);
    expect(mock.render).not.toHaveBeenCalled();
  });
  it('拒绝访问、服务故障或验证页补读，用户 key 与范围、取消信号透传', async () => {
    for (const status of [403, 412, 429, 503, 567]) {
      mock.read.mockResolvedValue({ ok: false, kind: 'fetch', reason: `HTTP ${status}` });
      expect(await fetchExamPage(url, 'user-a', { allowHosts: ['javaguide.cn'], timeoutMs: 3000 })).toEqual(rendered);
    }
    expect(mock.key).toHaveBeenCalledWith('tinyfish', 'user-a');
    expect(mock.render).toHaveBeenCalledWith(url, 'test-key', expect.objectContaining({ allowHosts: ['javaguide.cn'], signal: expect.any(AbortSignal) }));
    mock.read.mockResolvedValue({ ...rendered, title: '滑动验证' });
    await fetchExamPage(url, 'user-a');
    expect(mock.render).toHaveBeenCalledTimes(6);
  });
  it('直读超时仍保留补读预算，不把局部超时当成整页取消', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    try {
      mock.read.mockImplementation((_url, opts) => new Promise((resolve) => {
        opts.signal.addEventListener('abort', () => resolve({ ok: false, kind: 'fetch', reason: 'The operation was aborted due to timeout' }), { once: true });
      }));
      const pending = fetchExamPage(url, null, { timeoutMs: 6000 });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual(rendered);
      expect(mock.render.mock.calls[0]?.[2].signal.aborted).toBe(false);
      expect(mock.read.mock.calls[0]?.[1].timeoutMs).toBe(3000);
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
  it('安全拒绝、二进制文件不改用外部服务绕过', async () => {
    for (const page of [{ ok: false, kind: 'fetch', reason: '该地址不被允许访问' }, { ok: false, kind: 'fetch', reason: 'HTTP 404' }, { ok: false, kind: 'not_page', what: 'PDF', detail: 'PDF' }]) {
      mock.read.mockResolvedValue(page);
      expect(await fetchExamPage(url, null)).toEqual(page);
    }
    expect(mock.render).not.toHaveBeenCalled();
  });
  it('无 key 或取消后不补读；补读错误如实返回', async () => {
    const page = { ok: false, kind: 'empty', title: '' };
    mock.read.mockResolvedValue(page); mock.key.mockReturnValue('');
    expect(await fetchExamPage(url, null)).toEqual(page);
    mock.key.mockReturnValue('k');
    expect(await fetchExamPage(url, null, { signal: AbortSignal.abort() })).toEqual(page);
    expect(mock.render).not.toHaveBeenCalled();
    mock.render.mockRejectedValue(new Error('TinyFish fetch HTTP 429'));
    expect(await fetchExamPage(url, null)).toEqual({ ok: false, kind: 'fetch', reason: 'TinyFish fetch HTTP 429' });
  });
});
