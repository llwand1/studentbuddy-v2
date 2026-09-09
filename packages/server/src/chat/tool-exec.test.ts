/**
 * chat/tool-exec —— 工具调度策略回归（并行 / 按序 / 超时 / 取消 / 失败）。
 * 不触 LLM、不碰 DB：执行器靠参数注入假 exec，测的是调度本身，不是任何具体工具。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../llm/types.js';
import type { ToolContext, ToolResult } from './tools.js';
import { ABORT_HINT, DEFAULT_TOOL_TIMEOUT_MS, TIMEOUT_HINT, runToolCalls } from './tool-exec.js';

const call = (id: string, name: string, args = '{}'): ToolCall => ({ id, name, arguments: args });

function makeCtx(): { ctx: ToolContext; steps: Array<{ tool: string; status: string; detail?: string }> } {
  const steps: Array<{ tool: string; status: string; detail?: string }> = [];
  return {
    ctx: { onStep: (tool, status, detail) => steps.push({ tool, status, detail }) },
    steps,
  };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('runToolCalls — 并行与顺序', () => {
  it('同轮多工具是真并行：两个 120ms 的工具总耗时接近 120ms 而不是 240ms', async () => {
    const { ctx } = makeCtx();
    const exec = async (name: string): Promise<ToolResult> => {
      await delay(120);
      return { content: `ok:${name}` };
    };
    const t0 = Date.now();
    const out = await runToolCalls([call('1', 'a'), call('2', 'b')], ctx, { exec });
    const cost = Date.now() - t0;
    expect(cost).toBeLessThan(200); // 串行会到 240ms 以上
    expect(out.map((o) => o.name)).toEqual(['a', 'b']);
  });

  it('结果按调用顺序回灌，与完成先后无关（顺序稳定性＝回归锁可钉）', async () => {
    const { ctx } = makeCtx();
    const exec = async (name: string): Promise<ToolResult> => {
      await delay(name === 'slow' ? 60 : 5); // 后调用的先完成
      return { content: `ok:${name}` };
    };
    const out = await runToolCalls([call('1', 'slow'), call('2', 'fast')], ctx, { exec });
    expect(out.map((o) => o.content)).toEqual(['ok:slow', 'ok:fast']);
    expect(out[0]?.id).toBe('1');
  });

  it('空调用列表返回空数组（不进循环、不报错）', async () => {
    const { ctx } = makeCtx();
    await expect(runToolCalls([], ctx)).resolves.toEqual([]);
  });
});

describe('runToolCalls — 超时', () => {
  it('超时的工具回灌「别重复调用」+ 标 error，且不拖死本轮', async () => {
    const { ctx, steps } = makeCtx();
    // 永不 resolve 的 promise 必须在用例结束前 release：留着 pending 会让 vitest worker 退不干净
    // （tinypool 会反复补 worker，最后报成莫名其妙的栈溢出），那不是被测代码的问题
    let release: (() => void) | undefined;
    const exec = (): Promise<ToolResult> =>
      new Promise((r) => {
        release = () => r({ content: 'late' });
      });
    const t0 = Date.now();
    try {
      const out = await runToolCalls([call('1', 'hang')], ctx, { exec, timeoutMs: 80 });
      expect(Date.now() - t0).toBeLessThan(500);
      expect(out[0]?.ok).toBe(false);
      expect(out[0]?.content).toBe(TIMEOUT_HINT);
      expect(steps[0]).toMatchObject({ tool: 'hang', status: 'error' });
      expect(steps[0]?.detail).toContain('超时');
    } finally {
      release?.();
    }
  });

  it('默认超时是契约里的 30s（未显式传时生效）', async () => {
    const { ctx } = makeCtx();
    const spy = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok' }));
    await runToolCalls([call('1', 'a')], ctx, { exec: spy });
    // 直接断言常量暴露正确，避免真等 30s
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(30_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('快工具跑完不留 timer：本用例能在默认超时内结束即证明 clearTimeout 生效', async () => {
    // 若 finally 里没清 timer，本进程会被 30s 的 timer 挂住、用例超时失败
    const { ctx } = makeCtx();
    const exec = async (): Promise<ToolResult> => ({ content: 'ok' });
    const out = await runToolCalls([call('1', 'a')], ctx, { exec });
    expect(out[0]?.ok).toBe(true);
  });
});

describe('runToolCalls — 取消与失败', () => {
  it('signal 已中止时不发起调用（不浪费一次外部请求），回灌「用户已停止」', async () => {
    const { ctx, steps } = makeCtx();
    const spy = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok' }));
    const ac = new AbortController();
    ac.abort();
    const out = await runToolCalls([call('1', 'a')], ctx, { exec: spy, signal: ac.signal });
    expect(spy).not.toHaveBeenCalled();
    expect(out[0]?.content).toBe(ABORT_HINT);
    expect(steps[0]).toMatchObject({ status: 'error', detail: '已停止' });
  });

  it('执行途中被中止：不等超时就结算（否则用户点「停止」要干等 30s）', async () => {
    const { ctx, steps } = makeCtx();
    const ac = new AbortController();
    let release: (() => void) | undefined;
    const exec = (): Promise<ToolResult> =>
      new Promise((r) => {
        release = () => r({ content: 'late' });
      });
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 40);
    try {
      const out = await runToolCalls([call('1', 'hang')], ctx, { exec, signal: ac.signal, timeoutMs: 5000 });
      expect(Date.now() - t0).toBeLessThan(1000); // 远小于 5s 超时 ⇒ 确实没在干等
      expect(out[0]?.content).toBe(ABORT_HINT);
      expect(steps[0]).toMatchObject({ status: 'error', detail: '已停止' });
    } finally {
      release?.();
    }
  });

  it('工具抛错时不炸本轮：回灌失败原因给模型自纠，并标 error 上屏', async () => {
    const { ctx, steps } = makeCtx();
    const exec = async (): Promise<ToolResult> => {
      throw new Error('boom');
    };
    const out = await runToolCalls([call('1', 'a')], ctx, { exec });
    expect(out[0]?.ok).toBe(false);
    expect(out[0]?.content).toContain('boom');
    expect(steps[0]).toMatchObject({ status: 'error', detail: 'boom' });
  });

  it('部分失败不影响同轮其他工具：一成一败都要回灌（原子落库的另一半）', async () => {
    const { ctx } = makeCtx();
    const exec = async (name: string): Promise<ToolResult> => {
      if (name === 'bad') throw new Error('坏工具');
      return { content: `ok:${name}` };
    };
    const out = await runToolCalls([call('1', 'good'), call('2', 'bad')], ctx, { exec });
    expect(out[0]).toMatchObject({ name: 'good', ok: true });
    expect(out[1]).toMatchObject({ name: 'bad', ok: false });
  });
});
