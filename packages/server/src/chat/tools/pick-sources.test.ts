/**
 * pick_sources 工具单测（契约 docs/SOURCE-TRACE-SPEC.md §4.3）。
 * 钉：① 参数坏 / 空 ⇒ 回灌纠错文案；② 无资料架 ⇒ 如实说明不报错；③ 有架子 ⇒ 精选生效、
 * 回灌带编号清单、未知网址原样退回；④ 注册元数据：read 档、幂等、无 scenes 裁剪（全场景可用）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ToolContext } from './registry.js';

vi.mock('../sse-bus.js', () => ({ publish: () => 1 }));
const { runTool, toolDefinitions, toolMeta } = await import('./index.js');
const { createSourceShelf } = await import('../../sources/shelf.js');

const ctx = (extra: Partial<ToolContext> = {}): ToolContext & { steps: string[] } => {
  const steps: string[] = [];
  return { steps, onStep: (t, s, d) => steps.push(`${t}:${s}:${d ?? ''}`), ownerId: null, ...extra };
};

describe('pick_sources', () => {
  it('④ 已注册：read 档、幂等、对所有角色可见', () => {
    expect(toolDefinitions().some((d) => d.function.name === 'pick_sources')).toBe(true);
    expect(toolMeta('pick_sources')).toMatchObject({ kind: 'read', idempotent: true });
  });

  it('① picks 非数组被参数校验挡下；空数组 / 无 url 的条目 ⇒ 纠错文案 + error 步', async () => {
    const bad = await runTool('pick_sources', JSON.stringify({ picks: 'nope' }), ctx());
    expect(bad.content).toContain('参数校验失败');
    const c = ctx();
    const r = await runTool('pick_sources', JSON.stringify({ picks: [{ url: '   ', why: '空网址' }] }), c);
    expect(r.content).toContain('picks 为空或格式不对');
    expect(c.steps[0]).toContain('error');
  });

  it('② 没有资料架 ⇒ 如实说明', async () => {
    const r = await runTool('pick_sources', JSON.stringify({ picks: [{ url: 'https://a.example.com', why: 'x' }] }), ctx());
    expect(r.content).toContain('本轮没有资料架');
  });

  it('③ 有架子 ⇒ 精选生效、回灌带编号、未知退回', async () => {
    const shelf = createSourceShelf('s-pick');
    shelf.found('q', [
      { title: '官方文档', url: 'https://docs.example.com/a', snippet: '', source: 'bing' },
      { title: '博客', url: 'https://blog.example.com/b', snippet: '', source: 'bing' },
    ]);
    const c = ctx({ sources: shelf });
    const r = await runTool(
      'pick_sources',
      JSON.stringify({ picks: [{ url: 'https://docs.example.com/a', why: '官方' }, { url: 'https://made.up/x', why: '编的' }] }),
      c,
    );
    expect(r.content).toContain('[1] 官方文档（docs.example.com）');
    expect(r.content).toContain('https://made.up/x');
    expect(shelf.items()[0]).toMatchObject({ origin: 'pick', why: '官方' });
    expect(c.steps.at(-1)).toBe('pick_sources:done:精选 1 条');
    shelf.dispose();
  });
});
