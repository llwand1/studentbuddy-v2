/**
 * learning/study-flow + flow-registry 单测：步骤参数校验、提示词构造、定义 CRUD 与校验。
 * 全部零 LLM（`buildStepPrompt` 是纯函数；定义层只碰 DB）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb } from '../storage/db.js';
import { buildStepPrompt, validateStepParams } from './flow-registry.js';
import { cloneDef, createDef, getDef, listDefs, removeDef, updateDef, validateDefInput } from './study-flow.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-studyflow-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('flow-registry — 步骤参数校验（按注册表声明）', () => {
  it('未知步骤类型被拒，且错误里列出可用类型', () => {
    const r = validateStepParams('teleport', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('teleport');
      expect(r.error).toContain('explain');
    }
  });

  it('必填缺失 ⇒ 拒绝（不静默落默认值）', () => {
    const r = validateStepParams('explain', { depth: 'deep' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('topic');
  });

  it('选填缺失 ⇒ 落声明的默认值', () => {
    const r = validateStepParams('quiz', { topic: '虚拟语气' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.topic).toBe('虚拟语气');
      expect(r.params.count).toBe(3);
      expect(r.params.online).toBe(true);
    }
  });

  it('数值越界 ⇒ 钳到区间而非报错（同 normalizeTerms 手法）', () => {
    const r = validateStepParams('quiz', { topic: 'x', count: 999 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.count).toBe(10);
  });

  it('select 非法值 ⇒ 拒绝', () => {
    const r = validateStepParams('explain', { topic: 'x', depth: 'ultra' });
    expect(r.ok).toBe(false);
  });

  it('布尔参数接受 "true"/"false" 字符串（前端表单常见形态）', () => {
    const r = validateStepParams('explain', { topic: 'x', withExample: 'false' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.withExample).toBe(false);
  });
});

describe('flow-registry — 步骤提示词构造', () => {
  it('quiz 步声明「跑完要停下等用户」，并给出停等说明', () => {
    const p = buildStepPrompt('quiz', { topic: '虚拟语气', count: 3, online: true });
    expect(p.awaitUser).toBe(true);
    expect(p.pauseReason).toBeTruthy();
    expect(p.text).toContain('虚拟语气');
    expect(p.text).toContain('3 道题');
  });

  it('explain 步不停等，且把深度写进提问', () => {
    const p = buildStepPrompt('explain', { topic: '闭包', depth: 'deep', withExample: true });
    expect(p.awaitUser).toBe(false);
    expect(p.pauseReason).toBeNull();
    expect(p.text).toContain('闭包');
    expect(p.text).toContain('反例');
  });

  it('六种对话式步骤都能构造出非空提问（注册表与翻译表不漏项）', () => {
    // scenario 刻意不在列：它走专用执行器（generateScenario），不走脚本化提问（SCENARIO-SPEC §8 M4），
    // 翻译表对它会抛哨兵错误——下面单独断言这一契约
    const kinds = ['explain', 'quiz', 'grade', 'review', 'digest', 'summary'] as const;
    for (const k of kinds) {
      const params = validateStepParams(k, { topic: 't', domain: 'math' });
      // explain/quiz 需要 topic；其余不强制。此处只断言能拿到合法参数并翻译成功
      if (!params.ok) continue;
      const p = buildStepPrompt(k, params.params);
      expect(p.text.length).toBeGreaterThan(0);
    }
    expect(() => buildStepPrompt('scenario', {})).toThrow(/专用执行器/);
  });
});

describe('study-flow — 定义校验', () => {
  it('空步骤被拒（一条学习流至少要有 1 步）', () => {
    const r = validateDefInput({ name: 'x', steps: [], edges: [] });
    expect(r.ok).toBe(false);
  });

  it('悬空边被拒，且错误里点出不存在的那个步骤', () => {
    const r = validateDefInput({
      name: 'x',
      steps: [{ id: 'a', kind: 'explain', params: { topic: 't' } }],
      edges: [{ fromStepId: 'a', toStepId: 'ghost' }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ghost');
  });

  it('步骤 id 重复被拒', () => {
    const r = validateDefInput({
      name: 'x',
      steps: [
        { id: 'dup', kind: 'explain', params: { topic: 'a' } },
        { id: 'dup', kind: 'explain', params: { topic: 'b' } },
      ],
      edges: [],
    });
    expect(r.ok).toBe(false);
  });

  it('缺省坐标按顺序自动铺开（用户只拖了节点没定位也能落库）', () => {
    const r = validateDefInput({
      name: 'x',
      steps: [
        { id: 'a', kind: 'explain', params: { topic: 'a' } },
        { id: 'b', kind: 'explain', params: { topic: 'b' } },
      ],
      edges: [],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps[0]!.positionX).toBe(80);
      expect(r.steps[1]!.positionX).toBe(280);
    }
  });
});

describe('study-flow — 定义 CRUD', () => {
  const sample = {
    name: '精读一条词条',
    description: '讲解 → 出题 → 判分 → 沉淀',
    steps: [
      { id: 's1', kind: 'explain' as const, params: { topic: '虚拟语气', depth: 'normal' } },
      { id: 's2', kind: 'quiz' as const, params: { topic: '虚拟语气', count: 3 } },
      { id: 's3', kind: 'grade' as const, params: {} },
      { id: 's4', kind: 'digest' as const, params: { domain: 'english' } },
    ],
    edges: [
      { fromStepId: 's1', toStepId: 's2' },
      { fromStepId: 's2', toStepId: 's3', fromPort: 'correct' as const },
      { fromStepId: 's3', toStepId: 's4' },
    ],
  };

  it('创建后可原样读回（步骤参数、边、端口都落库）', () => {
    const r = createDef(sample);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = getDef(r.def.id);
    expect(got).not.toBeNull();
    expect(got!.steps).toHaveLength(4);
    expect(got!.edges).toHaveLength(3);
    expect(got!.steps[0]!.params.topic).toBe('虚拟语气');
    expect(got!.steps[1]!.params.count).toBe(3);
    expect(got!.edges.find((e) => e.fromStepId === 's2')!.fromPort).toBe('correct');
    expect(got!.version).toBe(1);
  });

  it('更新递增版本号（运行快照据此区分新旧定义）', () => {
    const r = createDef(sample);
    if (!r.ok) return;
    const r2 = updateDef(r.def.id, { ...sample, name: '改过的名字' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.def.version).toBe(2);
    expect(r2.def.name).toBe('改过的名字');
  });

  it('更新是整体替换：删掉的步骤不会残留', () => {
    const r = createDef(sample);
    if (!r.ok) return;
    const r2 = updateDef(r.def.id, {
      name: '只剩两步',
      steps: [
        { id: 's1', kind: 'explain', params: { topic: 'a' } },
        { id: 's2', kind: 'summary', params: {} },
      ],
      edges: [{ fromStepId: 's1', toStepId: 's2' }],
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.def.steps).toHaveLength(2);
    expect(r2.def.edges).toHaveLength(1);
  });

  it('校验失败时**不写半截**（库里不留残行）', () => {
    const r = createDef({ name: '坏的', steps: [{ kind: 'explain', params: {} }], edges: [] });
    expect(r.ok).toBe(false);
    expect(listDefs()).toHaveLength(0);
  });

  it('克隆出一份独立新流（id 不同、步骤边一致）', () => {
    const r = createDef(sample);
    if (!r.ok) return;
    const c = cloneDef(r.def.id);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.def.id).not.toBe(r.def.id);
    expect(c.def.name).toBe('精读一条词条 副本');
    expect(c.def.steps).toHaveLength(4);
  });

  it('删除时把步骤与边一并清掉（不留孤儿行）', () => {
    const r = createDef(sample);
    if (!r.ok) return;
    expect(removeDef(r.def.id)).toBe(true);
    expect(getDef(r.def.id)).toBeNull();
    expect(listDefs()).toHaveLength(0);
  });
});
