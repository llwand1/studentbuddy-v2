import { describe, expect, it } from 'vitest';
import type { ScenarioPayload } from '@sb/shared';
import {
  progressSummary,
  scenarioProgress,
  validateScenarioReport,
} from './scenario-view';

const payload: ScenarioPayload = {
  title: '排序情景',
  tasks: [
    { id: 't1', prompt: '选出偶数', criteria: { kind: 'choice', answer: [0, 2] } },
    { id: 't2', prompt: '拨到 on', criteria: { kind: 'state', value: 'on' } },
  ],
};

// 「分派与形状判定」两个 describe 于 2026-09-26 随 `isScenarioItem`/`isScenarioPayload` 一起删除
// （唯一调用方 QuizBankPage 下线），删除行同批从 `docs/dev/test-plan.md` 摘除。

describe('scenario-view — validateScenarioReport（宿主白名单）', () => {
  const ids = new Set(['t1', 't2']);
  const msg = { v: 1, type: 'sb-scenario-report', demoId: 'd1', taskId: 't1', observed: [0] };

  it('type/demoId/taskId 三道全过才放行', () => {
    expect(validateScenarioReport(msg, 'd1', ids)).toEqual({ taskId: 't1', observed: [0] });
    expect(validateScenarioReport({ ...msg, demoId: 'other' }, 'd1', ids)).toBeNull();
    expect(validateScenarioReport({ ...msg, taskId: 'evil' }, 'd1', ids)).toBeNull();
    expect(validateScenarioReport({ ...msg, type: 'other' }, 'd1', ids)).toBeNull();
  });

  it('v 不是 1 / 非对象 / 缺字段一律丢弃', () => {
    expect(validateScenarioReport({ ...msg, v: 2 }, 'd1', ids)).toBeNull();
    expect(validateScenarioReport('nope', 'd1', ids)).toBeNull();
    expect(validateScenarioReport(null, 'd1', ids)).toBeNull();
    expect(validateScenarioReport({ type: 'sb-scenario-report' }, 'd1', ids)).toBeNull();
  });
});

describe('scenario-view — scenarioProgress（以服务端判分为准的完成态）', () => {
  it('无结果全 pending；部分完成计数正确；allDone 要全齐', () => {
    expect(scenarioProgress(payload, {}).allDone).toBe(false);
    const half = scenarioProgress(payload, { t1: true });
    expect(half).toMatchObject({ total: 2, doneCount: 1, allDone: false });
    expect(half.items[0]).toMatchObject({ state: 'correct' });
    expect(half.items[1]).toMatchObject({ state: 'pending' });
    expect(scenarioProgress(payload, { t1: true, t2: true }).allDone).toBe(true);
  });

  it('判错记 wrong 不算完成度里的「对」；汇总句含完成数与判对数', () => {
    const p = scenarioProgress(payload, { t1: false, t2: true });
    expect(p.items[0]?.state).toBe('wrong');
    expect(progressSummary(p)).toBe('完成 2/2 · 判对 1');
    expect(progressSummary(scenarioProgress(payload, {}))).toBe('完成 0/2 · 判对 0');
  });
});
