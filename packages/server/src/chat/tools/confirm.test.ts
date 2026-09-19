/**
 * chat/tools/confirm + write-gate —— 确认门回归（契约 TOOL-ECOSYSTEM-SPEC §4.6/§6.3-4，P3）。
 *
 * 本批最要紧的一条死锁（§4.6-4）：**拒绝与超时路径下 `apply()` 调用次数恒为 0**——
 * 用 spy 计数钉死，而不是测「文案像不像被拒」。两阶段写只要有一次「拒了但还是写了」，
 * 整个确认门就退化成装饰。
 *
 * 零 DB 零网络：探针工具自带 planWrite（假 apply 只数调用），阈值全走 `confirmThreshold`
 * 显式给——`loadConfirmThreshold` 只在 by_size 真裁决时读 `app_settings`，测试不给它读的机会
 * （getDb 会真开库文件，见代码地雷图）。挂起帧经 sse-bus 缓冲，用 snapshot 取 requestId。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SseEvent } from '@sb/shared';
import { registerTool } from './registry.js';
import type { PendingWrite, ToolContext } from './registry.js';
import { runTool, toolMeta } from './index.js';
import { snapshot } from '../sse-bus.js';
import {
  cancelConfirmationsBySession,
  pendingConfirmCount,
  resolveConfirmation,
} from './confirm.js';

/** 探针工具：apply 计数 + 计划条数由参数决定；三个名字分别占住 by_size / 必确认 / 免确认三档 */
const probes = {
  applied: { size: 0, always: 0, off: 0 },
  plan: (bucket: 'size' | 'always' | 'off') => (args: Record<string, unknown>): PendingWrite => {
    const affected = Number(args.n ?? 0);
    return {
      affected,
      actionSummary: `测试动作（${affected} 条）`,
      items: Array.from({ length: affected }, (_, i) => `第 ${i + 1} 条`),
      apply: async () => {
        probes.applied[bucket] += 1;
        return { content: '已执行', meta: { affected } };
      },
    };
  },
};

registerTool('__probe_size', {
  definition: { type: 'function', function: { name: '__probe_size', parameters: { type: 'object', properties: {} } } },
  kind: 'write',
  confirmThreshold: 2,
  planWrite: async (args) => probes.plan('size')(args),
});
registerTool('__probe_always', {
  definition: { type: 'function', function: { name: '__probe_always', parameters: { type: 'object', properties: {} } } },
  kind: 'write',
  needsConfirm: true,
  planWrite: async (args) => probes.plan('always')(args),
});
registerTool('__probe_off', {
  definition: { type: 'function', function: { name: '__probe_off', parameters: { type: 'object', properties: {} } } },
  kind: 'write',
  needsConfirm: false,
  planWrite: async (args) => probes.plan('off')(args),
});

function probeCtx(sessionId?: string, signal?: AbortSignal): { ctx: ToolContext; steps: string[] } {
  const steps: string[] = [];
  return {
    ctx: {
      onStep: (tool, status, detail) => steps.push(`${tool}:${status}:${detail ?? ''}`),
      ownerId: null,
      ...(sessionId ? { sessionId } : {}),
      ...(signal ? { signal } : {}),
    },
    steps,
  };
}

type RequestEv = Extract<SseEvent, { type: 'tool-confirm-request' }>;

/** sse-bus 缓冲跨用例常驻：只认「发了 request 还没 resolved」的活帧，不然会翻到上文的旧卡 */
function openRequestFrames(sid: string): RequestEv[] {
  const evs = snapshot(sid);
  const resolved = new Set(
    evs.flatMap((e) => (e.type === 'tool-confirm-resolved' ? [e.requestId] : [])),
  );
  return evs.filter(
    (e): e is RequestEv => e.type === 'tool-confirm-request' && !resolved.has(e.requestId),
  );
}

/** 等 runTool 挂起前发布的确认帧（planWrite→publish 全在微任务里跑完，轮询两拍足够） */
async function confirmFrame(sid: string): Promise<RequestEv> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
    const [frame] = openRequestFrames(sid);
    if (frame) return frame;
  }
  throw new Error('没等到 tool-confirm-request 帧');
}

async function settleFrameCount(sid: string): Promise<number> {
  return snapshot(sid).filter((e) => e.type === 'tool-confirm-resolved').length;
}

beforeEach(() => {
  probes.applied.size = 0;
  probes.applied.always = 0;
  probes.applied.off = 0;
});

afterEach(() => {
  expect(pendingConfirmCount()).toBe(0); // 残留挂起＝上一个用例忘了收口，当场揪出
});

describe('write-gate — by_size 阈值边界（探针阈值 2：affected 2 免、3 弹）', () => {
  it('恰好等于阈值不弹卡，直接 apply（拍板⑮「一口气说得出的不该弹卡」的下沿）', async () => {
    const { ctx } = probeCtx('s-edge');
    const r = await runTool('__probe_size', '{"n":2}', ctx);
    expect(r.content).toBe('已执行');
    expect(r.meta?.affected).toBe(2);
    expect(r.meta?.confirm ?? null).toBeNull(); // 没经过门：留痕是 null，不是 allow
    expect(probes.applied.size).toBe(1);
  });

  it('超阈值弹卡：批准前 apply 不跑，allow_once 后**同轮**执行', async () => {
    const { ctx } = probeCtx('s-over');
    const p = runTool('__probe_size', '{"n":3}', ctx);
    const frame = await confirmFrame('s-over');
    expect(frame.tool).toBe('__probe_size');
    expect(frame.affected).toBe(3);
    expect(frame.items).toHaveLength(3);
    expect(probes.applied.size).toBe(0); // 卡挂着，手没伸进库
    expect(resolveConfirmation(frame.requestId, 'allow_once').ok).toBe(true);
    const r = await p;
    expect(r.content).toBe('已执行');
    expect(r.meta?.confirm).toBe('allow_once');
    expect(probes.applied.size).toBe(1);
  });

  it('needsConfirm=true 无视阈值必弹（1 条也问）；affected 0 连必确认档也不弹空卡（§4.6 落码注 1）', async () => {
    const { ctx } = probeCtx('s-always');
    const p = runTool('__probe_always', '{"n":1}', ctx);
    const frame = await confirmFrame('s-always');
    resolveConfirmation(frame.requestId, 'deny');
    await p;
    expect(probes.applied.always).toBe(0);
    // 全落空的删除就是这个形态：affected 0 → 不弹空卡，gate 直接 apply 让工具如实汇报
    const r0 = await runTool('__probe_always', '{"n":0}', ctx);
    expect(r0.meta?.affected).toBe(0);
    expect(r0.meta?.confirm ?? null).toBeNull(); // 没经过门：留痕 null 而非 allow
    expect(probes.applied.always).toBe(1);
    expect(openRequestFrames('s-always')).toHaveLength(0); // 确实没发新卡
  });
});

describe('write-gate — 拒绝/超时的 apply 恒 0 死锁（§4.6-4，本文件的命根子）', () => {
  it('deny：不回执、不写库，回灌「请勿重复发起」', async () => {
    const { ctx } = probeCtx('s-deny');
    const p = runTool('__probe_always', '{"n":4}', ctx);
    const frame = await confirmFrame('s-deny');
    resolveConfirmation(frame.requestId, 'deny');
    const r = await p;
    expect(r.content).toContain('用户未批准');
    expect(r.content).toContain('请勿重复发起');
    expect(r.meta?.affected).toBeNull(); // 没改＝NULL，不是 0（§4.2 口径）
    expect(r.meta?.confirm).toBe('deny');
    expect(probes.applied.always).toBe(0);
  });

  it('60s 无回执：服务端定时代答 timeout，同样零 apply', async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = probeCtx('s-timeout');
      const p = runTool('__probe_always', '{"n":4}', ctx);
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await p;
      expect(r.content).toContain('超时');
      expect(r.meta?.confirm).toBe('timeout');
      expect(probes.applied.always).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('「停止生成」（signal 中止）按 deny 收口：不干等 60s，卡片不留死卡', async () => {
    const ac = new AbortController();
    const { ctx } = probeCtx('s-abort', ac.signal);
    const p = runTool('__probe_always', '{"n":4}', ctx);
    await confirmFrame('s-abort'); // 只等卡发出，值无断言价值（收口断言在 settleFrameCount）
    ac.abort();
    const r = await p;
    expect(r.meta?.confirm).toBe('deny');
    expect(probes.applied.always).toBe(0);
    expect(await settleFrameCount('s-abort')).toBe(1); // resolved 广播发了，前端卡片同步收口
  });

  it('无 sessionId 的必确认调用保守拒绝（发不出卡＝没人同意过，§4.6 落码注 2）', async () => {
    const { ctx } = probeCtx(); // 不给 sessionId
    const r = await runTool('__probe_always', '{"n":4}', ctx);
    expect(r.meta?.confirm).toBe('deny');
    expect(r.content).toContain('会话上下文');
    expect(probes.applied.always).toBe(0);
  });
});

describe('confirm — 单一裁决者与「本会话允许」不蔓延', () => {
  it('迟到的第二次点选 409；不存在的 404；非法 decision 400', async () => {
    const { ctx } = probeCtx('s-single');
    const p = runTool('__probe_always', '{"n":2}', ctx);
    const frame = await confirmFrame('s-single');
    expect(resolveConfirmation(frame.requestId, 'meow')).toMatchObject({ ok: false, status: 400 });
    expect(resolveConfirmation(frame.requestId, 'allow_once').ok).toBe(true);
    expect(resolveConfirmation(frame.requestId, 'deny')).toMatchObject({ ok: false, status: 409 });
    expect(resolveConfirmation('no-such-id', 'allow_once')).toMatchObject({ ok: false, status: 404 });
    await p;
  });

  it('allow_session 只授「同会话+同工具+同档」：第二个工具照样弹', async () => {
    const a1 = probeCtx('s-sess');
    const p1 = runTool('__probe_size', '{"n":3}', a1.ctx);
    const f1 = await confirmFrame('s-sess');
    resolveConfirmation(f1.requestId, 'allow_session');
    await p1;
    // 同工具再来一发：不再弹卡（allowKey 命中，留痕记 allow_session 而非「没经过门」）
    const a2 = probeCtx('s-sess');
    const r2 = await runTool('__probe_size', '{"n":3}', a2.ctx);
    expect(r2.meta?.confirm).toBe('allow_session');
    expect(r2.content).toBe('已执行');
    // 换工具（哪怕同会话）：照弹——一次批准不是跨工具通行证（key 含工具名与确认档）
    const b = probeCtx('s-sess');
    const p4 = runTool('__probe_always', '{"n":1}', b.ctx);
    const f4 = await confirmFrame('s-sess');
    expect(f4.tool).toBe('__probe_always');
    resolveConfirmation(f4.requestId, 'deny');
    await p4;
  });

  it('删会话：挂起卡全 deny 收口 + 「本会话允许」授权表清空', async () => {
    const a = probeCtx('s-gone');
    const p = runTool('__probe_size', '{"n":3}', a.ctx);
    const f = await confirmFrame('s-gone');
    resolveConfirmation(f.requestId, 'allow_session');
    await p;
    expect(cancelConfirmationsBySession('s-gone')).toBe(0); // 没挂起的了，但授权表随会话清
    const b = probeCtx('s-gone');
    const p2 = runTool('__probe_size', '{"n":3}', b.ctx);
    const f2 = await confirmFrame('s-gone'); // 白拿通行证＝清表没生效
    resolveConfirmation(f2.requestId, 'allow_once');
    await p2;
  });
});

describe('write-gate — 免确认档与元数据接线', () => {
  it('needsConfirm=false 的 write 探针永不弹卡（档位开关真被 gate 读）', async () => {
    const { ctx } = probeCtx('s-off');
    const r = await runTool('__probe_off', '{"n":50}', ctx);
    expect(r.content).toBe('已执行');
    expect(probes.applied.off).toBe(1);
  });

  it('注册表缺省档：write 无声明 ⇒ 行为按 by_size（探针 __probe_size 显式阈值同型验证）', () => {
    expect(toolMeta('__probe_size')?.needsConfirm).toBeUndefined(); // 缺省不写死在注册处，判定住 gate
  });

  it('确认卡载荷形状：actionSummary/affected/items 三硬要求齐（§5.1「只有条数的卡不许上线」）', async () => {
    const { ctx } = probeCtx('s-shape');
    const p = runTool('__probe_size', '{"n":5}', ctx);
    const f = await confirmFrame('s-shape');
    const raw = f as unknown as Record<string, unknown>;
    expect(raw.tool).toBe('__probe_size');
    expect(raw.source).toBe('builtin'); // write 内建 ⇒ builtin（external 才 mcp）
    expect(typeof raw.actionSummary).toBe('string');
    expect(raw.actionSummary).toContain('5');
    expect(Array.isArray(raw.items)).toBe(true);
    expect(typeof raw.expiresAt).toBe('number');
    resolveConfirmation(f.requestId, 'deny');
    await p;
  });

  it('items 超 8 行由 gate 裁成 ≤8 行 + 「…等 N 条」（卡片不铺满屏）', async () => {
    const { ctx } = probeCtx('s-items');
    const p = runTool('__probe_size', '{"n":12}', ctx);
    const f = await confirmFrame('s-items');
    expect(f.items.length).toBeLessThanOrEqual(9);
    expect(f.items[f.items.length - 1]).toContain('等 12 条');
    resolveConfirmation(f.requestId, 'deny');
    await p;
  });
});
