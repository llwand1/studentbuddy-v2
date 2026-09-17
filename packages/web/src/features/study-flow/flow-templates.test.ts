/**
 * flow-templates.test.ts —— 模板库的**自检**（契约 docs/STUDY-FLOW-SPEC.md §2.3）。
 *
 * ★ 这个文件存在的唯一理由：把「模板开箱可跑」从一句承诺变成**机器可验的事实**。
 *   模板是给用户照抄的起点——某条模板参数填漏、或连线指向一个不存在的步骤，
 *   用户点「新建」就直接拿到一条坏的流，比没有模板更糟，且极难归因。
 *
 * ★ 用的是 `shared` 的 `validateStepParams`（与保存、与服务端执行期**同一份**代码），
 *   所以"模板能过这里的校验"等价于"服务端不会因为参数问题拒绝这条流"。
 */
import { describe, expect, it } from 'vitest';
import { validateStepParams } from '@sb/shared';
import { FLOW_TEMPLATES, buildTemplateDef, findTemplate, templatePosition } from './flow-templates';
import type { FlowTemplate } from './flow-templates';
import { STEP_BOX } from './flow-layout';
import { collectParamProblems } from './flow-form';

let seq = 0;
const fakeId = () => `t-${++seq}`;

describe('模板库自检', () => {
  it('key 唯一，名字与说明都不为空（列表里要能认出来）', () => {
    const keys = FLOW_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of FLOW_TEMPLATES) {
      expect(t.name.trim().length, `${t.key} 缺名字`).toBeGreaterThan(0);
      expect(t.summary.trim().length, `${t.key} 缺一句话说明`).toBeGreaterThan(0);
      expect(t.why.trim().length, `${t.key} 缺"为什么这么连"`).toBeGreaterThan(0);
    }
  });

  it('★ 恰好有一个推荐模板（新建时第一眼要有落点，多于一个等于没推荐）', () => {
    expect(FLOW_TEMPLATES.filter((t) => t.recommended)).toHaveLength(1);
  });

  it('步骤的局部 id 在模板内唯一（连线靠它引用，重了就连错步骤）', () => {
    for (const t of FLOW_TEMPLATES) {
      const ids = t.steps.map((s) => s.id);
      expect(new Set(ids).size, `${t.key} 的步骤 id 有重复`).toBe(ids.length);
    }
  });

  it('连线两端都指向模板内真实存在的步骤', () => {
    for (const t of FLOW_TEMPLATES) {
      const ids = new Set(t.steps.map((s) => s.id));
      for (const e of t.edges) {
        expect(ids.has(e.from), `${t.key}：边起点 ${e.from} 不存在`).toBe(true);
        expect(ids.has(e.to), `${t.key}：边终点 ${e.to} 不存在`).toBe(true);
      }
    }
  });

  it('同一步骤的同一出口只有一条边（与前端 setEdge 的语义一致，服务端也据此解释）', () => {
    for (const t of FLOW_TEMPLATES) {
      const seen = t.edges.map((e) => `${e.from}::${e.port}`);
      expect(new Set(seen).size, `${t.key} 有重复出口`).toBe(seen.length);
    }
  });

  it('分支目标的步骤下沉一排（与主线撞同一格会让线糊在一起）', () => {
    const lesson = findTemplate('lesson');
    expect(lesson).toBeDefined();
    if (!lesson) return;
    // 「答错」的目标必须与主线不在同一排
    const wrongEdge = lesson.edges.find((e) => e.port === 'wrong');
    expect(wrongEdge).toBeDefined();
    if (!wrongEdge) return;
    const byId = new Map(lesson.steps.map((s) => [s.id, s]));
    expect(byId.get(wrongEdge.to)?.row).toBe(1);
  });

  it('模板里的步骤类型都是注册表认识的（未知类型在服务端会被直接拒）', () => {
    for (const t of FLOW_TEMPLATES) {
      for (const s of t.steps) {
        const r = validateStepParams(s.kind, s.params);
        // 只要不是「未知步骤类型」这一种错，就说明 kind 本身是认识的
        if (!r.ok) expect(r.error, `${t.key}/${s.id}`).not.toContain('未知步骤类型');
      }
    }
  });

  it('★ 每个模板的每一步都能过 shared 的参数校验（= 开箱就能跑，保存不会被服务端 400）', () => {
    for (const t of FLOW_TEMPLATES) {
      for (const s of t.steps) {
        const r = validateStepParams(s.kind, s.params);
        expect(r.ok, `模板 ${t.key} 的步骤 ${s.id} 参数不合规：${r.ok ? '' : r.error}`).toBe(true);
      }
    }
  });

  it('★ 没有任何模板是"缺必填的空壳"——起点必须存得下、跑得动', () => {
    for (const t of FLOW_TEMPLATES) {
      const problems = collectParamProblems(
        t.steps.map((s, i) => ({ id: `s${i}`, kind: s.kind, label: '', params: s.params })),
      );
      expect(problems, `模板 ${t.key} 带着没填的必填：${problems[0]?.error ?? ''}`).toEqual([]);
    }
  });

  it('不存在「空白起步」这类模板（历史上给过：点完新建立刻吃"缺少必填参数"）', () => {
    expect(findTemplate('blank')).toBeUndefined();
  });
});

describe('buildTemplateDef —— 模板 → 提交形状', () => {
  it('步骤数与模板一致，id 全部是新生成的且唯一', () => {
    const tpl = findTemplate('lesson');
    expect(tpl).toBeDefined();
    if (!tpl) return;
    const def = buildTemplateDef(tpl, fakeId);
    expect(def.steps).toHaveLength(tpl.steps.length);
    const ids = def.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => tpl.steps.some((s) => s.id === id))).toBe(false);
  });

  it('边的两端指向新生成的 id（不是模板里的局部 id）', () => {
    const tpl = findTemplate('lesson');
    expect(tpl).toBeDefined();
    if (!tpl) return;
    const def = buildTemplateDef(tpl, fakeId);
    const ids = def.steps.map((s) => s.id);
    expect(def.edges).toHaveLength(tpl.edges.length);
    for (const e of def.edges) {
      expect(ids).toContain(e.fromStepId);
      expect(ids).toContain(e.toStepId);
    }
  });

  it('★ 参数是浅拷出来的：改新建出来的流不会污染模板常量', () => {
    const tpl = findTemplate('cram');
    expect(tpl).toBeDefined();
    if (!tpl) return;
    const before = JSON.stringify(tpl.steps[0]?.params);
    const def = buildTemplateDef(tpl, fakeId);
    const first = def.steps[0];
    expect(first?.params).toBeDefined();
    if (first?.params) first.params.topic = '被改过的主题';
    expect(JSON.stringify(tpl.steps[0]?.params)).toBe(before);
  });

  it('连线引用不存在的步骤 → 抛错（不静默给个空 id 让服务端 400）', () => {
    const bad: FlowTemplate = {
      key: 'bad',
      name: '坏模板',
      summary: '用于测试',
      why: '用于测试',
      steps: [{ id: 'a', kind: 'explain', params: { topic: 'x' } }],
      edges: [{ from: 'a', port: 'next', to: 'nope' }],
    };
    expect(() => buildTemplateDef(bad, fakeId)).toThrow(/不存在的步骤/);
  });

  it('名字与说明带上（新建出来的流在列表里就能认出是哪一个模板）', () => {
    const tpl = findTemplate('drill');
    expect(tpl).toBeDefined();
    if (!tpl) return;
    const def = buildTemplateDef(tpl, fakeId);
    expect(def.name).toBe(tpl.name);
    expect(def.description).toBe(tpl.summary);
  });
});

describe('findTemplate / templatePosition', () => {
  it('未知 key 返回 undefined（调用方负责报错，不静默落到某个模板）', () => {
    expect(findTemplate('nope')).toBeUndefined();
    expect(findTemplate('lesson')?.name).toBe('四步课堂');
  });

  it('按列/排铺开：横向间距大于卡片宽（不重叠），纵向同列下沉一排', () => {
    const c00 = templatePosition(0, 0);
    const c10 = templatePosition(1, 0);
    const c01 = templatePosition(0, 1);
    expect(c10.x - c00.x).toBeGreaterThan(STEP_BOX.w);
    expect(c01.y - c00.y).toBeGreaterThan(STEP_BOX.h);
    expect(c01.x).toBe(c00.x);
  });
});
