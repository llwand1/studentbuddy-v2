/**
 * api.test — REST 客户端契约回归（B-003 锁）：出题配比两条方法曾整体缺失
 * （`settings.quizMix`/`saveQuizMix` 不存在 ⇒ QuizMixCard/QuizBankPage/ChatView
 * 三处调用全部 TS2339，且 09-03「收口」批次却声称 check 全绿——tsc 本可拦截）。
 * 本文件钉死：方法在、路径对、方法动词对、PUT 带 `{ mix }` 体；响应契约 { mix }。
 *
 * 2026-09-04 回答方式偏好批补三例（同一条 B-003 通则）：tsc 只能证明方法存在，证不了路径与动词
 * 跟服务端路由对得上——而 L1 弹卡的全部行为（要不要问、勾了就存）都建在这三条请求上。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from './api';
import { DEFAULT_ANSWER_STYLE, DEFAULT_QUIZ_MIX, type AnswerStyle } from '@sb/shared';

type FakeRes = { ok: boolean; status: number; json: () => Promise<unknown> };

function stubFetch(res: FakeRes): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => res);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api.settings.quizMix（B-003 回归锁）', () => {
  it('GET /api/settings/quiz-mix，回读服务端归一化后的配比', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ mix: { ...DEFAULT_QUIZ_MIX } }) });
    const r = await api.settings.quizMix();
    expect(r.mix).toEqual(DEFAULT_QUIZ_MIX);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings/quiz-mix');
    expect(init.method ?? 'GET').toBe('GET');
  });
});

describe('api.settings.answerStyle（L0/L1 共用读写，B-003 同一条通则）', () => {
  it('GET /api/settings/answer-style，回读 { style, configured }', async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ style: { ...DEFAULT_ANSWER_STYLE }, configured: false }),
    });
    const r = await api.settings.answerStyle();
    expect(r).toEqual({ style: DEFAULT_ANSWER_STYLE, configured: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings/answer-style');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('PUT 同路径且 body 为 { style }，返回服务端归一化后的偏好', async () => {
    const style: AnswerStyle = { ...DEFAULT_ANSWER_STYLE, verbosity: 'brief', shape: 'bullets' };
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ style, configured: true }) });
    const r = await api.settings.saveAnswerStyle(style);
    expect(r.configured).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings/answer-style');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ style });
  });

  it('DELETE 同路径、不带请求体（恢复默认＝删键，回到 configured:false 的未配过态）', async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: async () => ({ style: { ...DEFAULT_ANSWER_STYLE }, configured: false }),
    });
    const r = await api.settings.resetAnswerStyle();
    expect(r.configured).toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings/answer-style');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });
});

describe('api.settings.saveQuizMix（B-003 回归锁）', () => {
  it('PUT /api/settings/quiz-mix，body 为 { mix }，返回服务端回读配比', async () => {
    const mix = { single: 5, multiple: 2, fill: 0, essay: 0 };
    const fetchMock = stubFetch({ ok: true, status: 200, json: async () => ({ mix }) });
    const r = await api.settings.saveQuizMix(mix);
    expect(r.mix).toEqual(mix);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/settings/quiz-mix');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ mix });
  });
});
