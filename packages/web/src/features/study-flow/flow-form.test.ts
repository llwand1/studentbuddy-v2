/**
 * flow-form —— 参数表单派生逻辑的回归锁。
 *
 * 锁两件事：
 * ① **不影响用户输入手感**：初值必须让受控组件有确定值（`undefined` 会让 input 在受控/非受控间跳变），
 *    数值即时钳制只在越界时发生，清空重打时不能被强行填回去；
 * ② **与服务端同一份校验**：提交前拦人的是 `shared` 的 `validateStepParams`，
 *    这里锁住它给用户看的那句错误里**带着参数名**（否则用户看到「缺少必填参数」不知道是哪个）。
 */
import { describe, it, expect } from 'vitest';
import { findFlowStepMeta, validateStepParams, type FlowStepKind, type FlowStepMeta } from '@sb/shared';
import {
  clampOnInput,
  collectParamProblems,
  displayStepLabel,
  initStepParams,
  paramRangeHint,
  stepParamsSummary,
} from './flow-form';

const explain = findFlowStepMeta('explain') as FlowStepMeta;
const quiz = findFlowStepMeta('quiz') as FlowStepMeta;

describe('initStepParams —— 表单初值', () => {
  it('无已存值：取声明里的默认值（不填也能跑）', () => {
    const v = initStepParams(explain);
    expect(v.depth).toBe('normal');
    expect(v.withExample).toBe(true);
    expect(v.topic).toBe('');
  });

  it('有已存值：以已存值为准，不被默认值覆盖', () => {
    const v = initStepParams(explain, { topic: '虚拟语气', depth: 'deep', withExample: false });
    expect(v.topic).toBe('虚拟语气');
    expect(v.depth).toBe('deep');
    expect(v.withExample).toBe(false);
  });

  it('★ 没有默认值的参数给「类型零值」而不是 undefined（受控组件必须有确定值）', () => {
    const meta: FlowStepMeta = {
      kind: 'explain',
      label: '测试',
      description: '',
      typeVersion: 1,
      produces: [],
      awaitsUser: false,
      params: [
        { key: 'a', label: 'A', type: 'string', required: false },
        { key: 'b', label: 'B', type: 'number', required: false, min: 3 },
        { key: 'c', label: 'C', type: 'boolean', required: false },
        { key: 'd', label: 'D', type: 'select', required: false, options: ['x', 'y'] },
      ],
    };
    const v = initStepParams(meta);
    expect(v.a).toBe('');
    expect(v.b).toBe(3); // 有 min 时给下界，那是它最合理的起点
    expect(v.c).toBe(false);
    expect(v.d).toBe('x');
    expect(Object.values(v).every((x) => x !== undefined)).toBe(true);
  });
});

describe('clampOnInput —— 输入即时钳制', () => {
  const count = quiz.params.find((p) => p.key === 'count')!;

  it('超过上界：当场回到上界（与服务端钳制口径一致）', () => {
    expect(clampOnInput(count, '999')).toBe(10);
  });

  it('低于下界：回到下界', () => {
    expect(clampOnInput(count, '0')).toBe(1);
  });

  it('★ 清空输入框：保留空串，不许强行填回下界', () => {
    expect(clampOnInput(count, '')).toBe('');
  });

  it('非数字内容：给空串（让用户接着改），不产生 NaN', () => {
    expect(clampOnInput(count, 'abc')).toBe('');
  });

  it('区间内原样保留', () => {
    expect(clampOnInput(count, '5')).toBe(5);
  });

  it('布尔参数：转成真布尔（checkbox 传的是布尔）', () => {
    const flag = explain.params.find((p) => p.key === 'withExample')!;
    expect(clampOnInput(flag, true)).toBe(true);
    expect(clampOnInput(flag, false)).toBe(false);
  });

  it('字符串参数：原样转字符串（trim 留给提交校验做）', () => {
    const topic = explain.params.find((p) => p.key === 'topic')!;
    expect(clampOnInput(topic, ' 虚 拟 ')).toBe(' 虚 拟 ');
  });
});

describe('paramRangeHint —— 区间提示', () => {
  it('上下界都有：显示区间', () => {
    expect(paramRangeHint(quiz.params.find((p) => p.key === 'count')!)).toBe('1–10');
  });

  it('只有下界 / 只有上界', () => {
    expect(paramRangeHint({ key: 'k', label: 'K', type: 'number', required: false, min: 2 })).toBe('≥ 2');
    expect(paramRangeHint({ key: 'k', label: 'K', type: 'number', required: false, max: 8 })).toBe('≤ 8');
  });

  it('非数值参数无提示', () => {
    expect(paramRangeHint(explain.params.find((p) => p.key === 'topic')!)).toBe('');
  });
});

describe('stepParamsSummary —— 卡片上的一行摘要', () => {
  it('拼接已填参数，布尔显示开/关', () => {
    const s = stepParamsSummary(explain, { topic: '虚拟语气', depth: 'deep', withExample: false });
    expect(s).toContain('讲解主题 虚拟语气');
    expect(s).toContain('深度 deep');
    expect(s).toContain('附例子关');
  });

  it('★ 空值不参与拼接（卡片上写「讲解主题：」比不写更难看）', () => {
    const s = stepParamsSummary(explain, { topic: '', depth: '', withExample: true });
    expect(s).not.toContain('讲解主题');
    expect(s).not.toContain('深度');
    expect(s).toBe('附例子开');
  });
});

describe('displayStepLabel —— 节点显示名', () => {
  it('用户改过就用用户的', () => {
    expect(displayStepLabel('第一轮讲解', 'explain', '讲解')).toBe('第一轮讲解');
  });

  it('没改则回落注册表默认名', () => {
    expect(displayStepLabel('', 'explain', '讲解')).toBe('讲解');
    expect(displayStepLabel('   ', 'explain', '讲解')).toBe('讲解');
  });

  it('注册表也查不到时回落 kind 原文（不显示空白）', () => {
    expect(displayStepLabel('', 'mystery', undefined)).toBe('mystery');
  });
});

describe('★ 提交前校验用的就是 shared 那一份（前后端同源）', () => {
  it('必填缺失：错误文案里带参数名，用户知道该填哪个', () => {
    const r = validateStepParams('explain', {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('讲解主题');
      expect(r.error).toContain('topic');
    }
  });

  it('数值越界不会走到报错分支——它被钳制掉了（表单即时钳制与服务端口径同源）', () => {
    const r = validateStepParams('quiz', { topic: '虚拟语气', count: 999 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.count).toBe(10);
  });
});

describe('collectParamProblems —— 保存前的一次性体检', () => {
  it('全部合规 → 没有问题', () => {
    expect(collectParamProblems([{ id: 'a', kind: 'explain', params: { topic: '虚拟语气' } }])).toEqual([]);
  });

  it('★ 收集**全部**问题而不是遇到第一个就返回（改一个存一次最烦）', () => {
    const problems = collectParamProblems([
      { id: 's1', kind: 'explain', params: {} },
      { id: 's2', kind: 'quiz', params: {} },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]?.error).toContain('讲解主题');
    expect(problems[1]?.error).toContain('出题主题');
  });

  it('★ 每个问题都带 stepId —— 保存/开跑才能自动跳到出问题的那一步', () => {
    const problems = collectParamProblems([
      { id: 'ok', kind: 'explain', params: { topic: '虚拟语气' } },
      { id: 'bad-step', kind: 'quiz', params: {} },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.stepId).toBe('bad-step');
    // 用户没改过显示名时，回落注册表默认名（"跳到「出题」那一步"要说得出是哪个）
    expect(problems[0]?.stepLabel).toBe('出题');
  });

  it('用户改过显示名 → 定位文案用用户起的名字', () => {
    const problems = collectParamProblems([{ id: 's', kind: 'quiz', label: '第三题测一测', params: {} }]);
    expect(problems[0]?.stepLabel).toBe('第三题测一测');
  });

  it('未知步骤类型也会被点出来（不是静默跳过）', () => {
    const problems = collectParamProblems([{ id: 'x', kind: 'mystery' as FlowStepKind, params: {} }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.error).toContain('未知步骤类型');
  });

  it('空步骤列表 → 没有问题（服务端另有「至少 1 步」的拒绝，不在这里重复）', () => {
    expect(collectParamProblems([])).toEqual([]);
  });
});
