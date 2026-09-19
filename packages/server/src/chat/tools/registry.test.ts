/**
 * chat/tools/registry —— 注册表门面回归（S1 拆目录的结构锁 + §4.2 元数据锁 + 预闸接线锁）。
 * 不触 DB / 网络 / LLM：只用会被预闸拦下的调用和纯元数据断言。
 */
import { describe, expect, it } from 'vitest';
import { TOOL_LLM_INNER_TIMEOUT_MS } from '@sb/shared';
import { runTool, toolDefinitions, toolMeta, toolNames } from './index.js';
import type { ToolContext } from './registry.js';

const KNOWN = ['search_web', 'tidy_terms', 'manage_terms', 'ask_choice'] as const;

function silentCtx(): { ctx: ToolContext; steps: Array<{ tool: string; status: string; detail?: string }> } {
  const steps: Array<{ tool: string; status: string; detail?: string }> = [];
  return { ctx: { onStep: (tool, status, detail) => steps.push({ tool, status, detail }), ownerId: null }, steps };
}

describe('registry — 清单结构（拆分前后不许变的部分）', () => {
  it('四大内建工具在册且保持声明顺序（下发顺序＝拆分前 tools.ts 顺序）', () => {
    const names = toolNames();
    expect(names.filter((n) => (KNOWN as readonly string[]).includes(n))).toEqual([...KNOWN]);
  });

  it('toolDefinitions() 与注册表一一对应；role 参数缺省时不裁剪', () => {
    const defs = toolDefinitions();
    expect(defs.map((d) => d.function.name).filter((n) => (KNOWN as readonly string[]).includes(n))).toEqual([...KNOWN]);
    expect(toolDefinitions('explain').length).toBe(defs.length);
  });
});

describe('registry — §4.2 元数据（分档/重试/确认门三个消费方的共同事实源）', () => {
  it('search_web：network + 幂等（唯一有重试资格的内建工具）', () => {
    const m = toolMeta('search_web');
    expect(m?.kind).toBe('network');
    expect(m?.idempotent).toBe(true);
    expect(m?.timeoutMs).toBeUndefined();
  });

  it('tidy_terms：write + 逐工具 120s（auto 分支内部调模型，档位基线不动）', () => {
    const m = toolMeta('tidy_terms');
    expect(m?.kind).toBe('write');
    expect(m?.timeoutMs).toBe(TOOL_LLM_INNER_TIMEOUT_MS);
    expect(m?.idempotent).toBeUndefined();
  });

  it('manage_terms：write 且非幂等（delete 是 P3 确认门第一客户，P2 只标不拦）', () => {
    const m = toolMeta('manage_terms');
    expect(m?.kind).toBe('write');
    expect(m?.idempotent).toBeUndefined();
  });

  it('ask_choice：read（30s 档）——真正的豁免走 flow 传的 noTimeout 名单，不靠 kind', () => {
    expect(toolMeta('ask_choice')?.kind).toBe('read');
  });

  it('未注册名 toolMeta 返回 undefined（调度器据此落全局缺省档）', () => {
    expect(toolMeta('no_such_tool')).toBeUndefined();
  });
});

describe('registry — runTool 预闸接线（schema.ts 单测测函数，这里测「真的接上了」）', () => {
  it('必填缺失：拦在执行前，工具体不跑、不碰网络，step 标 error', async () => {
    const { ctx, steps } = silentCtx();
    const r = await runTool('search_web', '{}', ctx);
    expect(r.content).toContain('query 缺失（必填）');
    expect(steps[0]).toMatchObject({ tool: 'search_web', status: 'error', detail: '参数校验失败' });
  });

  it('枚举违例：纠错文案自带合法值清单（` / ` 连接）', async () => {
    const { ctx } = silentCtx();
    const r = await runTool('tidy_terms', JSON.stringify({ action: 'nuke' }), ctx);
    expect(r.content).toContain('auto / merge / rename_domain / domain_add / domain_remove');
  });

  it('未知工具与坏 JSON 的老语义不因预闸改变', async () => {
    const { ctx } = silentCtx();
    expect((await runTool('no_such_tool', '{}', ctx)).content).toBe('未知工具：no_such_tool');
    expect((await runTool('search_web', 'not-json', ctx)).content).toContain('JSON 解析失败');
  });
});
