/**
 * step-fold —— SSE step 帧折叠的配对锁（P1，契约 TOOL-ECOSYSTEM-SPEC §4.7）。
 * 核心回归对象是 **B-010（同名并行串卡）**：旧实现按「name + 倒扫最近一条 running」配对，
 * 两卡并跑时终态会盖到别人的卡上。现在只认 toolCallId；无 id 一律另起，绝不回退倒扫。
 */
import { describe, expect, it } from 'vitest';
import type { SseEvent } from '@sb/shared';
import { foldStepEvent, type ToolStep } from './step-fold';

type StepEvent = Extract<SseEvent, { type: 'step' }>;

let seq = 0;
const ev = (o: Omit<StepEvent, 'type' | 'seq' | 'sessionId'> & Partial<Pick<StepEvent, 'seq'>>): StepEvent => ({
  type: 'step',
  seq: ++seq,
  sessionId: 's1',
  ...o,
});

const running = (tool: string, id?: string) => ev({ tool, status: 'running', toolCallId: id });
const done = (tool: string, id?: string, extra: Partial<StepEvent> = {}) =>
  ev({ tool, status: 'done', toolCallId: id, ...extra });

describe('foldStepEvent — running 入列', () => {
  it('running 帧追加新卡，带上 toolCallId 与本地起点 startedAtMs（tick 用）', () => {
    const out = foldStepEvent([], running('search_web', 'c1'), 1000);
    expect(out).toEqual([{ tool: 'search_web', status: 'running', toolCallId: 'c1', startedAtMs: 1000 }]);
  });

  it('不改入参数组（ref 镜像模式下调用方整表替换，原地改会漏渲染）', () => {
    const base: ToolStep[] = [{ tool: 'a', status: 'running', toolCallId: 'c0', startedAtMs: 1 }];
    const snapshot = JSON.stringify(base);
    foldStepEvent(base, done('a', 'c0', { durationMs: 5 }), 2000);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe('foldStepEvent — 终态配对（B-010 锁）', () => {
  it('toolCallId 命中：原位替换那张卡，终态不带 startedAtMs（本地 tick 就此冻结）', () => {
    const steps: ToolStep[] = [
      { tool: 'search_web', status: 'done', toolCallId: 'c0', durationMs: 11 },
      { tool: 'search_web', status: 'running', toolCallId: 'c1', startedAtMs: 500 },
    ];
    const out = foldStepEvent(steps, done('search_web', 'c1', { args: '{}', result: 'R', durationMs: 4200 }), 6000);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ tool: 'search_web', status: 'done', args: '{}', result: 'R', toolCallId: 'c1', durationMs: 4200 });
    expect(out[1]?.startedAtMs).toBeUndefined();
    expect(out[0]?.durationMs).toBe(11); // 别人的卡一个字节没动
  });

  it('同名两卡并行：先起的卡后收口，也只换自己——倒扫实现会把终态盖到后起的卡上', () => {
    const steps = foldStepEvent([], running('twin', 'id-a'), 100);
    const steps2 = foldStepEvent(steps, running('twin', 'id-b'), 200);
    // b 先完成（终态后到时数组里 a 才是最近一条 running——旧倒扫的猎物）
    const steps3 = foldStepEvent(steps2, done('twin', 'id-b', { durationMs: 50 }), 250);
    expect(steps3.map((s) => [s.toolCallId, s.status])).toEqual([
      ['id-a', 'running'],
      ['id-b', 'done'],
    ]);
    const steps4 = foldStepEvent(steps3, done('twin', 'id-a', { durationMs: 150 }), 350);
    expect(steps4.map((s) => [s.toolCallId, s.status, s.durationMs])).toEqual([
      ['id-a', 'done', 150],
      ['id-b', 'done', 50],
    ]);
  });

  it('error 终态同路径：errorText 与状态原样进卡（失败原因不伪装成 result）', () => {
    const steps = foldStepEvent([], running('search_web', 'c1'), 100);
    const out = foldStepEvent(steps, ev({ tool: 'search_web', status: 'error', toolCallId: 'c1', detail: '超时 30000ms', durationMs: 30_001, errorText: '超时 30000ms' }), 40_000);
    expect(out[0]).toMatchObject({ status: 'error', errorText: '超时 30000ms', durationMs: 30_001 });
  });

  it('终态配不上任何 running（断线只回放终态）：另起一条已收口卡，过程不丢', () => {
    const out = foldStepEvent([], done('search_web', 'c9', { result: 'R', durationMs: 800 }), 5000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'done', toolCallId: 'c9', durationMs: 800 });
  });

  it('终态没有 toolCallId（手搓帧/老数据）：绝不回退倒扫，另起新卡——宁可多一张也不盖别人的', () => {
    const steps: ToolStep[] = [{ tool: 'tidy_terms', status: 'running', toolCallId: 'c1', startedAtMs: 100 }];
    const out = foldStepEvent(steps, done('tidy_terms'), 900);
    expect(out).toHaveLength(2);
    expect(out[0]?.status).toBe('running'); // 旧实现会把它判给上面那张 running
    expect(out[1]).toMatchObject({ status: 'done' });
  });
});
