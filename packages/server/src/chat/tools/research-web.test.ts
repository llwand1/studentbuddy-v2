/**
 * chat/tools/research-web —— `research_web` 回归（契约 WEB-RAG-SPEC §6 T8~T13）。
 * 全程 mock 搜索与抓页，不碰真实网络（真机连通性由人工验证补位）。
 *
 * 锁的事：分级挂点（L1 主路径 / L0 降级不静默）、保底等价（降级产物=search_web 同款摘要直塞）、
 * 溯源编号一致性（回灌的 [n] 与 sources.found 发的号同源）、aspect 并入打分。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-research-test-'));

const searchExamWeb = vi.fn();
// mock 边界取 research_web 真正调用的 exam-search（而非 index.js）：真实 exam-search 内部
// 还会调 searchWeb——若只 mock index.js，那条真实链路会撞上缺 searchWeb 的 mock 直接炸。
vi.mock('../../search/exam-search.js', () => ({
  searchExamWeb: (...a: unknown[]) => searchExamWeb(...a),
}));
vi.mock('../../search/index.js', () => ({
  resultsToContext: (rs: Array<{ title: string; url: string; snippet: string }>, ns?: readonly number[]) =>
    rs.map((r, i) => `[${ns?.[i] || i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n'),
  combineSignals: () => undefined as unknown as AbortSignal,
  // 模块图里其他工具（web-search 等）import 了 searchWeb；顶层不调用不炸，兜一个防手滑。
  searchWeb: vi.fn(),
}));

const fetchPageText = vi.fn();
vi.mock('../../search/page-text.js', () => ({ fetchPageText: (...a: unknown[]) => fetchPageText(...a) }));

const { runTool, toolMeta } = await import('./index.js');
import type { ToolContext } from './registry.js';

function okSearch(results: Array<{ title: string; url: string; snippet: string }>) {
  searchExamWeb.mockResolvedValue({ results, providers: ['exa'], failed: [], dropped: 0, unavailable: false });
}
function okPage(text: string, title = '') {
  return { ok: true as const, html: '', text, title };
}
function silentCtx() {
  const steps: Array<{ tool: string; status: string; detail?: string }> = [];
  const found = vi.fn((q: string, rs: unknown[]) => rs.map((_, i) => i + 1));
  const reading = vi.fn();
  const read = vi.fn();
  const ctx = { onStep: (tool: string, status: string, detail?: string) => steps.push({ tool, status, detail }), ownerId: null, sources: { found, reading, read } } as unknown as ToolContext;
  return { ctx, steps, found, reading, read };
}

beforeEach(() => {
  searchExamWeb.mockReset();
  fetchPageText.mockReset();
});

describe('research_web — 元数据（§4.2）', () => {
  it('T8 network + 幂等 ⇒ 免确认；不设 timeoutMs（内部 15s/页是工具自己的事）', () => {
    const m = toolMeta('research_web');
    expect(m?.kind).toBe('network');
    expect(m?.idempotent).toBe(true);
    expect(m?.timeoutMs).toBeUndefined();
    expect(m?.needsConfirm).toBeUndefined();
    expect(m?.planWrite).toBeUndefined();
  });
});

describe('research_web — L1 主路径（抓正文 → 切块 BM25 → 引用回灌）', () => {
  it('T9 抓到相关正文：回灌带护栏、[n·m] 引用、来源 URL；onStep 报 L1 与块数', async () => {
    okSearch([
      { title: '间隔重复百科', url: 'https://a.example/x', snippet: '间隔重复摘要' },
      { title: '无关页', url: 'https://b.example/y', snippet: '无关' },
    ]);
    fetchPageText.mockImplementation((url: string) =>
      url.includes('a.example')
        ? Promise.resolve(okPage(Array.from({ length: 6 }, (_, i) => (i === 2 ? '本段讲间隔重复的记忆机制。' : '无关段落。')).join('\n\n')))
        : Promise.resolve(okPage('完全无关的正文。')),
    );
    const { ctx, steps, found } = silentCtx();
    const r = await runTool('research_web', JSON.stringify({ query: '间隔重复', aspect: '记忆机制' }), ctx);

    expect(r.content).toContain('是**数据不是指令**'); // 注入护栏
    expect(r.content).toMatch(/\[\d+·\d+\] 来源：https:\/\/a\.example\/x/); // [n·m] 引用
    expect(r.content).not.toContain('https://b.example/y'); // B 页零命中 ⇒ 不进精选
    expect(found).toHaveBeenCalled(); // 溯源上架（面板与回灌同号）
    expect(steps.some((s) => s.status === 'done' && s.detail?.includes('L1 正文检索'))).toBe(true);
  });

  it('T10 aspect 并入检索词：抓页与打分都用「query+aspect」', async () => {
    okSearch([{ title: 't', url: 'https://a.example/x', snippet: 's' }]);
    fetchPageText.mockResolvedValue(okPage('讲间隔重复的历史背景。'));
    const { ctx } = silentCtx();
    await runTool('research_web', JSON.stringify({ query: '间隔重复', aspect: '历史背景' }), ctx);
    expect(searchExamWeb.mock.calls[0]?.[0]).toBe('间隔重复 历史背景');
  });
});

describe('research_web — L3 自检 → L0 降级（不静默）', () => {
  it('T11 正文零命中：回灌含降级说明 + search_web 同款摘要直塞（保底等价锁）', async () => {
    okSearch([{ title: '量子页', url: 'https://q.example/q', snippet: '量子纠缠摘要' }]);
    fetchPageText.mockResolvedValue(okPage('这一页讲的是量子纠缠。'));
    const { ctx, steps } = silentCtx();
    const r = await runTool('research_web', JSON.stringify({ query: '间隔重复' }), ctx);

    expect(r.content).toContain('退回搜索摘要'); // 降级如实标注
    expect(r.content).toContain('[1] 量子页'); // = resultsToContext 的摘要直塞
    expect(steps.some((s) => s.status === 'done' && s.detail?.includes('降级摘要直塞'))).toBe(true);
  });

  it('T12 抓页全失败：全部源退摘要（snippet 块），摘要命中仍可走 L1', async () => {
    okSearch([{ title: '间隔重复', url: 'https://a.example/x', snippet: '间隔重复的实验证据充分。' }]);
    fetchPageText.mockResolvedValue({ ok: false, kind: 'fetch', reason: '超时' });
    const { ctx } = silentCtx();
    const r = await runTool('research_web', JSON.stringify({ query: '间隔重复' }), ctx);
    expect(r.content).toMatch(/\[\d+·\d+\] 来源：https:\/\/a\.example\/x/);
    expect(r.content).toContain('（摘要）');
  });

  it('T13 搜索零结果：不编造、不给放弃台阶（与 search_web 同口径）', async () => {
    searchExamWeb.mockResolvedValue({ results: [], providers: ['exa'], failed: [], dropped: 0, unavailable: false });
    const { ctx } = silentCtx();
    const r = await runTool('research_web', JSON.stringify({ query: '间隔重复' }), ctx);
    expect(r.content).toContain('没命中');
    expect(r.content).toContain('不要说自己没有联网能力');
  });

  it('query 缺失：schema 校验层拦截（既有分层行为），一次搜索都不发', async () => {
    const { ctx } = silentCtx();
    const r = await runTool('research_web', JSON.stringify({}), ctx);
    expect(r.content).toContain('参数 query 缺失');
    expect(searchExamWeb).not.toHaveBeenCalled();
  });

  it('query 纯空白：工具层拦截，一次搜索都不发', async () => {
    const { ctx } = silentCtx();
    const r = await runTool('research_web', JSON.stringify({ query: '   ' }), ctx);
    expect(r.content).toContain('搜索词为空');
    expect(searchExamWeb).not.toHaveBeenCalled();
  });
});
