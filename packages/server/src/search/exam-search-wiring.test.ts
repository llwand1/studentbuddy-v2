/** 穿过真实聊天工具、设置路由与出题参考入口，锁住补充检索的接线。 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-exam-wiring-'));
const mock = vi.hoisted(() => vi.fn());
vi.mock('./exam-search.js', () => ({ searchExamWeb: mock }));
vi.mock('./index.js', async (original) => ({
  ...await original<typeof import('./index.js')>(),
  searchWeb: vi.fn(async () => ({ results: [], providers: ['bing'], failed: [], dropped: 8 })),
}));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { saveExamMode, saveExamScope } = await import('../learning/exam-mode.js');
const { runTool } = await import('../chat/tools/index.js');
const { buildQuizSearchBlock } = await import('../learning/quiz-search.js');
const request = (await import('supertest')).default;
const hit = { title: 'Java 并发资料', url: 'https://javaguide.cn/java', snippet: '线程池控制并发', source: 'entry' };
beforeEach(() => {
  mock.mockReset().mockResolvedValue({ results: [hit], providers: ['bing', 'entry'], failed: [], dropped: 8, directSites: ['JavaGuide'] });
  saveExamMode(true, null); saveExamScope({ packs: ['tech-interview'], custom: [] }, null);
});
afterAll(() => closeDb());

describe('三个实际入口共用应试补充检索', () => {
  it('聊天传范围与取消信号，补充结果进入资料架与工具回灌', async () => {
    const found = vi.fn(() => [7]);
    const signal = new AbortController().signal;
    const result = await runTool('search_web', JSON.stringify({ query: 'Java 并发' }), {
      ownerId: null, signal, onStep: vi.fn(), sources: { found } as unknown as import('../sources/shelf.js').SourceSink,
    });
    expect(result.content).toContain('[7] Java 并发资料');
    expect(found).toHaveBeenCalledWith('Java 并发', [hit]);
    expect(mock).toHaveBeenCalledWith('Java 并发', null, expect.objectContaining({ on: true, hosts: expect.arrayContaining(['javaguide.cn']) }), { signal });
  });

  it('设置页真实试搜端点绕缓存，使用同一范围与补充结果', async () => {
    const r = await request(app).post('/api/settings/search/test').set('Origin', 'http://localhost:5173').send({ query: 'Java 并发' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, count: 1, providers: ['bing', 'entry'], scope: { dropped: 8 } });
    expect(mock).toHaveBeenCalledWith('Java 并发', null, expect.objectContaining({ on: true }), { skipCache: true });
  });

  it('出题参考使用同一服务，保留真实 URL 和实际命中站点账', async () => {
    const report: import('@sb/shared').QuizSearchReport = { on: true, count: 0, providers: [], failed: [], refs: [] };
    const r = await buildQuizSearchBlock('Java 并发', '', report, null);
    expect(r.block).toContain('线程池控制并发');
    expect(r.refs[0]?.url).toBe(hit.url);
    expect(report.scope?.directSites).toEqual(['JavaGuide']);
  });

  it('真正的通道故障不被说成范围内没资料', async () => {
    mock.mockResolvedValue({ results: [], providers: [], failed: ['连接超时'], dropped: 0, directSites: [] });
    const r = await runTool('search_web', JSON.stringify({ query: 'Java' }), { ownerId: null, onStep: vi.fn() });
    expect(r.content).toContain('检索通道暂不可用');
    expect(r.content).not.toContain('范围内没找到');
  });

  it('范围内无命中停止仅换措辞重试，且禁止未经检索的 URL', async () => {
    mock.mockResolvedValue({ results: [], providers: [], failed: ['Bing 超时'], dropped: 8, directSites: [], unavailable: false });
    const step = vi.fn();
    const r = await runTool('search_web', JSON.stringify({ query: '不存在的主题' }), { ownerId: null, onStep: step });
    expect(r.content).toContain('本轮不要仅换措辞重复搜索');
    expect(r.content).toContain('未经检索的网址');
    expect(step).toHaveBeenLastCalledWith('search_web', 'done', expect.stringContaining('范围内无结果'));
  });
});
