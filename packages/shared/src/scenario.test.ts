import { describe, expect, it } from 'vitest';
import {
  MAX_SCENARIO_TASKS,
  SCENARIO_BRIDGE_JS,
  SCENARIO_REPORT_TYPE,
  judgeTask,
  normalizeScenarioPayload,
  normalizeScenarioTasks,
} from './scenario.js';

describe('shared/scenario — normalizeScenarioTasks（入库闸门）', () => {
  it('缺 id / 空 prompt / 缺 criteria 的评分点整条丢弃', () => {
    const out = normalizeScenarioTasks([
      { id: '', prompt: 'a', criteria: { kind: 'state', value: 'x' } },
      { id: 't2', prompt: '   ', criteria: { kind: 'state', value: 'x' } },
      { id: 't3', prompt: 'b' },
      { id: 't4', prompt: 'c', criteria: { kind: 'state', value: 'x' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('t4');
  });

  it('criteria 形状不对丢弃：choice 空答案 / state 值为对象 / order 混入非字符串 / kind 未知', () => {
    const out = normalizeScenarioTasks([
      { id: 'a', prompt: 'p', criteria: { kind: 'choice', answer: [] } },
      { id: 'b', prompt: 'p', criteria: { kind: 'choice', answer: ['x'] } },
      { id: 'c', prompt: 'p', criteria: { kind: 'state', value: { deep: true } } },
      { id: 'd', prompt: 'p', criteria: { kind: 'order', answer: ['a', 3] } },
      { id: 'e', prompt: 'p', criteria: { kind: 'match' } },
      { id: 'f', prompt: 'p', criteria: null },
    ]);
    expect(out).toHaveLength(0);
  });

  it('choice 答案去重；order 全字符串才收；state 收三种原始类型', () => {
    const out = normalizeScenarioTasks([
      { id: 'a', prompt: 'p', criteria: { kind: 'choice', answer: [2, 1, 2] } },
      { id: 'b', prompt: 'p', criteria: { kind: 'order', answer: ['B', 'A'] } },
      { id: 'c', prompt: 'p', criteria: { kind: 'state', value: 42 } },
      { id: 'd', prompt: 'p', criteria: { kind: 'state', value: true } },
    ]);
    expect(out).toHaveLength(4);
    expect(out[0]?.criteria).toEqual({ kind: 'choice', answer: [1, 2] });
    expect(out[1]?.criteria).toEqual({ kind: 'order', answer: ['B', 'A'] });
  });

  it('id 重复的后到丢弃（白名单键不允许二义）；hint 空白不落字段', () => {
    const out = normalizeScenarioTasks([
      { id: 't', prompt: 'first', criteria: { kind: 'state', value: '1' } },
      { id: 't', prompt: 'second', criteria: { kind: 'state', value: '2' } },
      { id: 'u', prompt: 'p', criteria: { kind: 'state', value: '3' }, hint: '  ' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.prompt).toBe('first');
    expect(out[1]?.hint).toBeUndefined();
  });

  it('截 MAX_SCENARIO_TASKS；非数组输入返回空', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `t${i}`,
      prompt: 'p',
      criteria: { kind: 'state', value: String(i) },
    }));
    expect(normalizeScenarioTasks(many)).toHaveLength(MAX_SCENARIO_TASKS);
    expect(normalizeScenarioTasks('nope')).toHaveLength(0);
    expect(normalizeScenarioTasks(null)).toHaveLength(0);
  });
});

describe('shared/scenario — normalizeScenarioPayload', () => {
  it('0 评分点返回 null；title 缺省兜底「情景题」；title 空白同兜底', () => {
    expect(normalizeScenarioPayload({ title: 'x', tasks: [] })).toBeNull();
    expect(normalizeScenarioPayload({ tasks: [{ id: 't', prompt: 'p', criteria: { kind: 'state', value: 1 } }] }))
      .toEqual({ title: '情景题', tasks: [{ id: 't', prompt: 'p', criteria: { kind: 'state', value: 1 } }] });
    expect(normalizeScenarioPayload({ title: '  ', tasks: [{ id: 't', prompt: 'p', criteria: { kind: 'state', value: 1 } }] })?.title)
      .toBe('情景题');
  });

  it('非对象输入返回 null', () => {
    expect(normalizeScenarioPayload('nope')).toBeNull();
    expect(normalizeScenarioPayload(42)).toBeNull();
  });
});

describe('shared/scenario — judgeTask（服务端判分，纯函数）', () => {
  it('choice：集合相等判对——顺序无关、重复剔除后比较', () => {
    expect(judgeTask({ kind: 'choice', answer: [0, 2] }, [2, 0])).toBe(true);
    expect(judgeTask({ kind: 'choice', answer: [0, 2] }, [0, 2, 2])).toBe(true);
    expect(judgeTask({ kind: 'choice', answer: [0, 2] }, [0, 1, 2])).toBe(false);
    expect(judgeTask({ kind: 'choice', answer: [0] }, [0, 1])).toBe(false);
  });

  it('choice：observed 形状不对判错不抛错', () => {
    expect(judgeTask({ kind: 'choice', answer: [0] }, '0')).toBe(false);
    expect(judgeTask({ kind: 'choice', answer: [0] }, [0.5])).toBe(false);
    expect(judgeTask({ kind: 'choice', answer: [0] }, ['0'])).toBe(false);
    expect(judgeTask({ kind: 'choice', answer: [0] }, null)).toBe(false);
  });

  it('order：逐位相等才对，长度不等即错', () => {
    expect(judgeTask({ kind: 'order', answer: ['B', 'A', 'C'] }, ['B', 'A', 'C'])).toBe(true);
    expect(judgeTask({ kind: 'order', answer: ['B', 'A', 'C'] }, ['A', 'B', 'C'])).toBe(false);
    expect(judgeTask({ kind: 'order', answer: ['B', 'A'] }, ['B', 'A', 'C'])).toBe(false);
    expect(judgeTask({ kind: 'order', answer: ['B'] }, 'B')).toBe(false);
  });

  it('state：String 化比较容忍 number/string 边界；undefined/null 恒错', () => {
    expect(judgeTask({ kind: 'state', value: 42 }, '42')).toBe(true);
    expect(judgeTask({ kind: 'state', value: 'on' }, 'on')).toBe(true);
    expect(judgeTask({ kind: 'state', value: true }, 'true')).toBe(true);
    expect(judgeTask({ kind: 'state', value: 0 }, false)).toBe(false);
    expect(judgeTask({ kind: 'state', value: 'x' }, undefined)).toBe(false);
    expect(judgeTask({ kind: 'state', value: 'x' }, null)).toBe(false);
  });
});

describe('shared/scenario — 桥接脚本常量', () => {
  it('含占位符与上报类型字面量（服务端替换依赖它，漏了注入就是死链）', () => {
    expect(SCENARIO_BRIDGE_JS).toContain('__SB_DEMO_ID__');
    expect(SCENARIO_BRIDGE_JS).toContain(SCENARIO_REPORT_TYPE);
    expect(SCENARIO_BRIDGE_JS).toContain('window.SBScenario');
    expect(SCENARIO_BRIDGE_JS).toContain('parent.postMessage');
  });
});
