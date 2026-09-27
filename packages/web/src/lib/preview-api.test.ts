import { describe, it, expect, vi, afterEach } from 'vitest';
import { pickTitle, uploadPreview } from './preview-api';

type FakeRes = { ok: boolean; status: number; json: () => Promise<unknown> };

function stubFetch(res: FakeRes): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => res);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uploadPreview', () => {
  it('成功 → 返回 /api/preview/:id，POST 带 json 体', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ id: 'abc' }) });
    await expect(uploadPreview('<b>hi</b>')).resolves.toBe('/api/preview/abc');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ html: '<b>hi</b>' });
  });

  it('400 带 error → 抛出服务端原文（卡片要原样给用户看）', async () => {
    stubFetch({ ok: false, status: 400, json: async () => ({ error: 'html 必须是非空字符串' }) });
    await expect(uploadPreview('')).rejects.toThrow('html 必须是非空字符串');
  });

  it('响应不是 JSON（网关出 HTML）→ 退化成 HTTP 状态码，不把 SyntaxError 抛给用户', async () => {
    stubFetch({ ok: false, status: 502, json: async () => Promise.reject(new SyntaxError('Unexpected token <')) });
    await expect(uploadPreview('<b>hi</b>')).rejects.toThrow('HTTP 502');
  });

  it('200 但缺 id → 也判失败（不返回 undefined 拼出坏 url）', async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({}) });
    await expect(uploadPreview('<b>hi</b>')).rejects.toThrow('HTTP 200');
  });
});

describe('pickTitle', () => {
  it('有 <title> 用它的文本，无或全空白回落到卡片名', () => {
    expect(pickTitle('<html><head><title> 弹跳小球模拟 </title></head>', 'HTML 演示页')).toBe('弹跳小球模拟');
    expect(pickTitle('<title></title><b>x</b>', 'HTML 演示页')).toBe('HTML 演示页');
    expect(pickTitle('<b>无标题片段</b>', 'HTML 演示页')).toBe('HTML 演示页');
  });
});
