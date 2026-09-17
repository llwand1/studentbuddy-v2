/**
 * run-status —— 运行状态映射的回归锁。
 *
 * ★ 这组用例的靶子是「按钮亮着但一点就 409」这类状态不一致：
 *   `advanceGate` 的判定必须与服务端 `advanceRun` 逐条对齐（仅 running / paused 可推进），
 *   且**拒绝时必须给出具体原因**——用户得知道是走完了、还是出错了、还是到了上限。
 */
import { describe, it, expect } from 'vitest';
import { FLOW_MAX_STEPS, type FlowRun, type FlowRunStatus } from '@sb/shared';
import {
  advanceButtonText,
  advanceGate,
  canCancel,
  frozenVersionText,
  pauseHint,
  runBlockReason,
  runProgressText,
  runStatusLabel,
  runStatusTone,
  stepStatusLabel,
} from './run-status';

const run = (patch: Partial<FlowRun> = {}): FlowRun => ({
  id: 'r1',
  defId: 'd1',
  defVersion: 1,
  sessionId: null,
  status: 'running',
  currentStepId: null,
  cursor: null,
  stepCount: 0,
  pauseReason: null,
  error: null,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  finishedAt: null,
  ...patch,
});

describe('状态文案', () => {
  it('五种运行状态各有中文名', () => {
    const all: FlowRunStatus[] = ['running', 'paused', 'done', 'failed', 'cancelled'];
    expect(all.map(runStatusLabel)).toEqual(['进行中', '等你操作', '已完成', '失败', '已终止']);
  });

  it('状态色调 class 带状态后缀（配色分档在 CSS）', () => {
    expect(runStatusTone('paused')).toContain('paused');
    expect(runStatusTone('running')).toContain('running');
  });

  it('四种步骤状态各有中文名', () => {
    expect(stepStatusLabel('running')).toBe('执行中');
    expect(stepStatusLabel('done')).toBe('完成');
    expect(stepStatusLabel('failed')).toBe('失败');
    expect(stepStatusLabel('skipped')).toBe('跳过');
  });
});

describe('advanceGate —— 能否推进（必须与服务端 advancing 判定一致）', () => {
  it('running 可推进', () => {
    expect(advanceGate(run({ status: 'running' }))).toEqual({ ok: true });
  });

  it('★ paused 也能推进（paused 只是「停在某步等用户」，不是终态）', () => {
    expect(advanceGate(run({ status: 'paused' }))).toEqual({ ok: true });
  });

  it('done 拒绝，且说明是走完了', () => {
    const g = advanceGate(run({ status: 'done' }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('终点');
  });

  it('cancelled 拒绝，且提示要重新开始', () => {
    const g = advanceGate(run({ status: 'cancelled' }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('终止');
  });

  it('failed 拒绝，且把服务端给的原因为准（不吞掉 error）', () => {
    const g = advanceGate(run({ status: 'failed', error: '步骤执行失败：模型返回空' }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain('模型返回空');
  });

  it('failed 但没带 error 时也有兜底文案（不留空）', () => {
    const g = advanceGate(run({ status: 'failed', error: null }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason.length).toBeGreaterThan(0);
  });

  it('★ 达到步数上限：提前拦住，不让用户白点一次', () => {
    const g = advanceGate(run({ status: 'running', stepCount: FLOW_MAX_STEPS }));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain(String(FLOW_MAX_STEPS));
  });

  it('上限前一步仍可推进（边界不属于超限）', () => {
    expect(advanceGate(run({ status: 'running', stepCount: FLOW_MAX_STEPS - 1 }))).toEqual({ ok: true });
  });
});

describe('canCancel / 按钮文案', () => {
  it('仅 running / paused 可终止（与服务端幂等语义一致）', () => {
    expect(canCancel(run({ status: 'running' }))).toBe(true);
    expect(canCancel(run({ status: 'paused' }))).toBe(true);
    expect(canCancel(run({ status: 'done' }))).toBe(false);
    expect(canCancel(run({ status: 'failed' }))).toBe(false);
    expect(canCancel(run({ status: 'cancelled' }))).toBe(false);
  });

  it('第一步是「开始学习」，跑过之后是「继续下一步」', () => {
    expect(advanceButtonText(run({ stepCount: 0 }))).toBe('开始学习');
    expect(advanceButtonText(run({ stepCount: 2 }))).toBe('继续下一步');
  });

  it('★ paused 一律显示「继续下一步」（用户刚做完交互，语义就是恢复）', () => {
    expect(advanceButtonText(run({ status: 'paused', stepCount: 3 }))).toBe('继续下一步');
  });
});

describe('pauseHint —— 停等说明', () => {
  it('用服务端给的 pauseReason（它知道在等什么）', () => {
    const h = pauseHint(run({ status: 'paused', pauseReason: '题目已生成，请先作答' }));
    expect(h).toBe('题目已生成，请先作答');
  });

  it('★ paused 但没有 pauseReason 时给兜底文案，绝不返回空串', () => {
    const h = pauseHint(run({ status: 'paused', pauseReason: null }));
    expect(h.length).toBeGreaterThan(0);
  });

  it('非 paused 状态无停等说明', () => {
    expect(pauseHint(run({ status: 'running' }))).toBe('');
    expect(pauseHint(run({ status: 'done' }))).toBe('');
  });
});

describe('进度与版本展示', () => {
  it('进度文案带上限（用户知道还有多少步可用）', () => {
    expect(runProgressText(run({ stepCount: 3 }))).toContain('3');
    expect(runProgressText(run({ stepCount: 3 }))).toContain(String(FLOW_MAX_STEPS));
  });

  it('★ 定义版本要显示：运行冻结的是当时那一版，改过定义后这个数不同（契约 §6.3）', () => {
    expect(frozenVersionText(run({ defVersion: 4 }))).toContain('v4');
  });
});

describe('runBlockReason —— 「开始新一轮」该不该拦（2026-09-17 老板实测反馈）', () => {
  const p = (stepId: string, error = '步骤「讲解」缺少必填参数：讲解主题（topic）') => ({
    stepId,
    stepLabel: '讲解',
    error,
  });

  it('没有未保存改动、参数也齐 → 不拦（null，按钮可点）', () => {
    expect(runBlockReason({ dirty: false, problems: [] })).toBeNull();
  });

  it('★ 有未保存改动时**优先**报它——此时运行跑的是库里那一版，先报参数会让人以为「改完就能跑」', () => {
    const r = runBlockReason({ dirty: true, problems: [p('s1')] });
    expect(r?.blockedReason).toContain('未保存');
  });

  it('★ 参数没填好时带上**数量与 stepId**——面板据此给出「去改这一步」', () => {
    const r = runBlockReason({ dirty: false, problems: [p('bad'), p('bad2')] });
    expect(r?.blockedReason).toContain('2 处');
    expect(r?.blockedStepId).toBe('bad');
  });

  it('未保存改动的拦法不带步骤定位（那是「先保存」的事，不是某一步填错了）', () => {
    expect(runBlockReason({ dirty: true, problems: [] })?.blockedStepId).toBeUndefined();
  });
});
