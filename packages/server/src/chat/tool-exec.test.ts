/**
 * chat/tool-exec —— 工具调度策略回归（并行 / 按序 / 超时 / 取消 / 失败）。
 * 不触 LLM、不碰 DB：执行器靠参数注入假 exec，测的是调度本身，不是任何具体工具。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../llm/types.js';
import type { ToolContext, ToolResult } from './tools/registry.js';
import { ABORT_HINT, DEFAULT_TOOL_TIMEOUT_MS, TIMEOUT_HINT, resolveToolTimeoutMs, runToolCalls, type StepPayload } from './tool-exec.js';

const call = (id: string, name: string, args = '{}'): ToolCall => ({ id, name, arguments: args });

function makeCtx(): { ctx: ToolContext; steps: Array<{ tool: string; status: string; detail?: string }> } {
  const steps: Array<{ tool: string; status: string; detail?: string }> = [];
  return {
    ctx: { onStep: (tool, status, detail) => steps.push({ tool, status, detail }), ownerId: null },
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
    const out = await runToolCalls([call('1', 'a'), call('2', 'b')], ctx, { ownerId: null, exec });
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
    const out = await runToolCalls([call('1', 'slow'), call('2', 'fast')], ctx, { ownerId: null, exec });
    expect(out.map((o) => o.content)).toEqual(['ok:slow', 'ok:fast']);
    expect(out[0]?.id).toBe('1');
  });

  it('空调用列表返回空数组（不进循环、不报错）', async () => {
    const { ctx } = makeCtx();
    await expect(runToolCalls([], ctx, { ownerId: null })).resolves.toEqual([]);
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
      const out = await runToolCalls([call('1', 'hang')], ctx, { ownerId: null, exec, timeoutMs: 80 });
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
    await runToolCalls([call('1', 'a')], ctx, { ownerId: null, exec: spy });
    // 直接断言常量暴露正确，避免真等 30s
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(30_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('快工具跑完不留 timer：本用例能在默认超时内结束即证明 clearTimeout 生效', async () => {
    // 若 finally 里没清 timer，本进程会被 30s 的 timer 挂住、用例超时失败
    const { ctx } = makeCtx();
    const exec = async (): Promise<ToolResult> => ({ content: 'ok' });
    const out = await runToolCalls([call('1', 'a')], ctx, { ownerId: null, exec });
    expect(out[0]?.ok).toBe(true);
  });
});

describe('runToolCalls — 取消与失败', () => {
  it('signal 已中止时不发起调用（不浪费一次外部请求），回灌「用户已停止」', async () => {
    const { ctx, steps } = makeCtx();
    const spy = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok' }));
    const ac = new AbortController();
    ac.abort();
    const out = await runToolCalls([call('1', 'a')], ctx, { ownerId: null, exec: spy, signal: ac.signal });
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
      const out = await runToolCalls([call('1', 'hang')], ctx, { ownerId: null, exec, signal: ac.signal, timeoutMs: 5000 });
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
    const out = await runToolCalls([call('1', 'a')], ctx, { ownerId: null, exec });
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
    const out = await runToolCalls([call('1', 'good'), call('2', 'bad')], ctx, { ownerId: null, exec });
    expect(out[0]).toMatchObject({ name: 'good', ok: true });
    expect(out[1]).toMatchObject({ name: 'bad', ok: false });
  });
});

describe('runToolCalls — signal 透传（v13 体验升级）', () => {
  it('会话级 signal 原样进工具执行上下文：工具内部 fetch 据此真掐断，不再只是丢弃结果', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await runToolCalls([call('1', 'search_web')], { onStep: () => undefined }, {
      ownerId: null,
      exec: async (_n, _a, ctx) => {
        seen = ctx.signal;
        return { content: 'ok' };
      },
      signal: controller.signal,
    });
    expect(seen).toBe(controller.signal);
  });

  it('不给 signal 时 ctx.signal 为 undefined（老调用方零改动）', async () => {
    let seen: AbortSignal | undefined | null = null;
    await runToolCalls([call('1', 't')], { onStep: () => undefined }, {
      ownerId: null,
      exec: async (_n, _a, ctx) => {
        seen = ctx.signal;
        return { content: 'ok' };
      },
    });
    expect(seen).toBeUndefined();
  });
});

describe('runToolCalls — P1 计时与配对字段（契约 TOOL-ECOSYSTEM-SPEC §4.7）', () => {
  /** 捕获完整 onStep（含第 4 参 payload）：P1 三字段全靠它，3 参桩看不见就是没测 */
  function payloadCtx(): { ctx: { onStep: (t: string, s: 'running' | 'done' | 'error', d?: string, p?: StepPayload) => void }; frames: Array<{ tool: string; status: string; detail?: string; payload?: StepPayload }> } {
    const frames: Array<{ tool: string; status: string; detail?: string; payload?: StepPayload }> = [];
    return {
      ctx: { onStep: (tool, status, detail, payload) => frames.push({ tool, status, detail, payload }) },
      frames,
    };
  }

  it('done 终态帧带服务端实测 durationMs（≈墙钟：60ms 的工具不该落在 40ms 以下或 2s 以上）', async () => {
    const { ctx, frames } = payloadCtx();
    await runToolCalls([call('c1', 'slow')], ctx, { ownerId: null, exec: async () => { await delay(60); return { content: 'ok' }; } });
    const term = frames[frames.length - 1];
    expect(term?.status).toBe('done');
    expect(typeof term?.payload?.durationMs).toBe('number');
    expect((term?.payload?.durationMs as number) ?? 0).toBeGreaterThanOrEqual(40);
    expect((term?.payload?.durationMs as number) ?? 0).toBeLessThan(2000);
  });

  it('running 帧只挂 toolCallId 不挂 durationMs：计时只在终态定稿（assistant-ui 口径）', async () => {
    const { ctx, frames } = payloadCtx();
    await runToolCalls([call('c1', 'a')], ctx, {
      ownerId: null,
      exec: async (_n, _a, tctx) => {
        tctx.onStep('a', 'running', '干活中');
        return { content: 'ok' };
      },
    });
    const running = frames.find((f) => f.status === 'running');
    expect(running?.payload?.toolCallId).toBe('c1');
    expect(running?.payload?.durationMs).toBeUndefined();
  });

  it('error 终态帧同时带 durationMs 与 errorText，且不带 result（失败原因不伪装成结果摘要）', async () => {
    const { ctx, frames } = payloadCtx();
    await runToolCalls([call('c1', 'bad')], ctx, { ownerId: null, exec: async () => { throw new Error('boom'); } });
    const term = frames[frames.length - 1];
    expect(term?.status).toBe('error');
    expect(term?.payload?.errorText).toBe('boom');
    expect(typeof term?.payload?.durationMs).toBe('number');
    expect(term?.payload?.result).toBeUndefined();
  });

  it('超时结算也是真耗时：等了 timeoutMs 是事实，durationMs ≥ 设定值', async () => {
    const { ctx, frames } = payloadCtx();
    let release: (() => void) | undefined;
    const exec = (): Promise<ToolResult> => new Promise((r) => { release = () => r({ content: 'late' }); });
    try {
      await runToolCalls([call('c1', 'hang')], ctx, { ownerId: null, exec, timeoutMs: 60 });
      const term = frames[frames.length - 1];
      expect(term?.status).toBe('error');
      expect(String(term?.payload?.errorText)).toContain('超时');
      expect((term?.payload?.durationMs as number) ?? 0).toBeGreaterThanOrEqual(55);
    } finally {
      release?.();
    }
  });

  it('进入执行前已中止：error 帧带 errorText 但 durationMs 缺省——没跑过，落 0 是谎话（§4.7 无时长口径）', async () => {
    const { ctx, frames } = payloadCtx();
    const ac = new AbortController();
    ac.abort();
    const out = await runToolCalls([call('c1', 'a')], ctx, { ownerId: null, exec: async () => ({ content: 'ok' }), signal: ac.signal });
    expect(frames[0]?.payload?.errorText).toBe('已停止');
    expect(frames[0]?.payload?.toolCallId).toBe('c1');
    expect(frames[0]?.payload?.durationMs).toBeUndefined();
    expect(out[0]?.durationMs).toBeUndefined();
  });

  it('同名并行两调用各带各的 toolCallId：前端配对不再依赖倒扫（B-010 的服务端半边）', async () => {
    const { ctx, frames } = payloadCtx();
    // 两卡故意错开完成（b 先完、a 后完）：倒扫实现会把 b 的终态盖到 a 的卡上，
    // 正是这次拆掉的配对方式——现在两卡各带各的 id，前端按 id 找得到北。
    const exec = async (_name: string, argsJson: string, tctx: ToolContext): Promise<ToolResult> => {
      tctx.onStep('twin', 'running');
      const { d } = JSON.parse(argsJson) as { d: number };
      await delay(d);
      return { content: `ok-${d}` };
    };
    const out = await runToolCalls([call('id-a', 'twin', '{"d":40}'), call('id-b', 'twin', '{"d":5}')], ctx, {
      ownerId: null,
      exec,
    });
    const runs = frames.filter((f) => f.status === 'running').map((f) => f.payload?.toolCallId);
    expect(runs).toEqual(['id-a', 'id-b']);
    const terms = frames.filter((f) => f.status === 'done');
    // 完成顺序是 b→a（并行），但 id 各归各
    expect(terms.map((f) => f.payload?.toolCallId)).toEqual(['id-b', 'id-a']);
    expect(out.map((o) => o.id)).toEqual(['id-a', 'id-b']); // 回灌仍按调用顺序
  });

  it('ToolOutcome.durationMs 随结果带出：收口落库（messages.duration_ms）唯一的取值来源', async () => {
    const { ctx } = payloadCtx();
    const out = await runToolCalls([call('c1', 'a')], ctx, { ownerId: null, exec: async () => ({ content: 'ok' }) });
    expect(typeof out[0]?.durationMs).toBe('number');
  });
});

/** 捕获含 payload 的终态帧（S2 用例复用；与 P1 的 payloadCtx 同法） */
function s2Frames(): {
  ctx: { onStep: (t: string, s: 'running' | 'done' | 'error', d?: string, p?: StepPayload) => void };
  frames: Array<{ tool: string; status: string; detail?: string; payload?: StepPayload }>;
} {
  const frames: Array<{ tool: string; status: string; detail?: string; payload?: StepPayload }> = [];
  return { ctx: { onStep: (tool, status, detail, payload) => frames.push({ tool, status, detail, payload }) }, frames };
}

describe('runToolCalls — S2 分档超时（契约 §4.2 / v1.3 拍板⑪）', () => {
  it('优先级：显式 timeoutMs ＞ 逐工具（tidy_terms 120s）＞ kind 档（network 60s / read 30s）＞ 全局缺省；两阶段写另加确认余量', () => {
    expect(resolveToolTimeoutMs('a', 1234)).toBe(1234);
    // tidy_terms：120s 内部调模型 + 60s 确认余量（P3 起它是两阶段写）
    expect(resolveToolTimeoutMs('tidy_terms')).toBe(180_000);
    expect(resolveToolTimeoutMs('search_web')).toBe(60_000);
    // P3 确认门余量：write 档 30s + CONFIRM_TIMEOUT_MS 60s（卡片挂起发生在调用内部，不加就掐死等待）
    expect(resolveToolTimeoutMs('upsert_term')).toBe(90_000);
    expect(resolveToolTimeoutMs('ask_choice')).toBe(30_000);
    expect(resolveToolTimeoutMs('not_registered')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });
});

describe('runToolCalls — S2 同轮去重（契约 §4.3-4）', () => {
  it('同名同参（JSON 键序不同也算同一调用）只执行一次：两卡各归各的 toolCallId，复用卡标「去重复用」', async () => {
    const { ctx, frames } = s2Frames();
    const spy = vi.fn(async (name: string): Promise<ToolResult> => ({ content: `ok:${name}` }));
    const out = await runToolCalls(
      [call('1', 'search_web', '{"query":"a","k":2}'), call('2', 'search_web', '{"k":2,"query":"a"}')],
      ctx,
      { ownerId: null, exec: spy },
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.map((o) => o.id)).toEqual(['1', '2']);
    expect(out[0]?.content).toBe(out[1]?.content);
    const terms = frames.filter((f) => f.status === 'done');
    expect(terms.map((f) => f.payload?.toolCallId)).toEqual(['1', '2']);
    expect(String(terms[0]?.detail ?? '')).not.toContain('去重复用');
    expect(terms[1]?.detail).toContain('（去重复用）');
  });

  it('嵌套对象键序也归一（canonicalToolArgs 的深层稳定性）', async () => {
    const { ctx } = s2Frames();
    const spy = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok' }));
    await runToolCalls(
      [call('1', 'twin2', '{"o":{"b":1,"a":[2,3]}}'), call('2', 'twin2', '{"o":{"a":[2,3],"b":1}}')],
      ctx,
      { ownerId: null, exec: spy },
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('同名不同参不合并（去重键含参数，不是按工具名一刀切）', async () => {
    const { ctx } = s2Frames();
    const spy = vi.fn(async (_n: string, argsJson: string): Promise<ToolResult> => ({ content: argsJson }));
    await runToolCalls([call('1', 'search_web', '{"query":"a"}'), call('2', 'search_web', '{"query":"b"}')], ctx, {
      ownerId: null,
      exec: spy,
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('runToolCalls — S2 network 静默重试（契约 §4.3-5）', () => {
  it('search_web 首次抛错→重试成功：exec 两次、只有一张 done 卡（重试对用户不可见）', async () => {
    const { ctx, frames } = s2Frames();
    let n = 0;
    const exec = async (): Promise<ToolResult> => {
      n += 1;
      if (n === 1) throw new Error('网络抖动');
      return { content: 'ok' };
    };
    const out = await runToolCalls([call('1', 'search_web')], ctx, { ownerId: null, exec });
    expect(n).toBe(2);
    expect(out[0]?.ok).toBe(true);
    expect(frames.filter((f) => f.status === 'done')).toHaveLength(1);
    expect(frames.filter((f) => f.status === 'error')).toHaveLength(0);
  });

  it('重试仍失败：exec 恰好两次封顶，error 帧只有一个（用户不看两次失败）', async () => {
    const { ctx, frames } = s2Frames();
    let n = 0;
    const exec = async (): Promise<ToolResult> => {
      n += 1;
      throw new Error('网络持续抖动');
    };
    const out = await runToolCalls([call('1', 'search_web')], ctx, { ownerId: null, exec });
    expect(n).toBe(2);
    expect(out[0]?.ok).toBe(false);
    expect(out[0]?.content).toContain('网络持续抖动');
    expect(frames.filter((f) => f.status === 'error')).toHaveLength(1);
  });

  it('超时也 Retry 一次：首挂二成结算 done（第一次的挂起 promise 及时 release，不留 pending）', async () => {
    const { ctx, frames } = s2Frames();
    let n = 0;
    let release: (() => void) | undefined;
    const exec = (): Promise<ToolResult> => {
      n += 1;
      if (n === 1) return new Promise((r) => { release = () => r({ content: 'late' }); });
      return Promise.resolve({ content: 'ok-after-retry' });
    };
    try {
      const out = await runToolCalls([call('1', 'search_web')], ctx, { ownerId: null, exec, timeoutMs: 60 });
      expect(n).toBe(2);
      expect(out[0]?.content).toBe('ok-after-retry');
      expect(frames.filter((f) => f.status === 'done')).toHaveLength(1);
    } finally {
      release?.();
    }
  });

  it('write 类（upsert_term）异常不重试：重放=二次副作用风险', async () => {
    const { ctx } = s2Frames();
    const spy = vi.fn(async (): Promise<ToolResult> => {
      throw new Error('boom');
    });
    const out = await runToolCalls([call('1', 'upsert_term')], ctx, { ownerId: null, exec: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out[0]?.ok).toBe(false);
  });

  it('中止不重试：用户已表态，再打一次外部请求是冒犯', async () => {
    const { ctx } = s2Frames();
    const ac = new AbortController();
    let n = 0;
    const exec = async (): Promise<ToolResult> => {
      n += 1;
      ac.abort();
      throw new Error('抖动在中止之后');
    };
    const out = await runToolCalls([call('1', 'search_web')], ctx, { ownerId: null, exec, signal: ac.signal });
    expect(n).toBe(1);
    expect(out[0]?.content).toBe(ABORT_HINT);
  });
});
