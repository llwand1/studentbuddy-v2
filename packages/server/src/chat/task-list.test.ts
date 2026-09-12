/**
 * chat/task-list —— 任务清单工具解析/应用回归（纯函数，不触 LLM/DB/SSE）。
 * 覆盖两种入参模式（tasks 全量 / updates 增量）、三态归一、整批原子应用与自纠文案。
 */
import { describe, expect, it } from 'vitest';
import type { TaskItem } from '@sb/shared';
import {
  MAX_TASK_ITEMS,
  MAX_TASK_UPDATES,
  applyTaskPatch,
  formatTaskList,
  parseTaskArgs,
  renderTaskList,
} from './task-list.js';

/** 取 replace 结果（顺带断言模式，避免「本该替换却走了增量」这类静默跑偏） */
function asReplace(json: string): { items: TaskItem[] } {
  const r = parseTaskArgs(json);
  if (!r.ok || r.mode !== 'replace') throw new Error(`期望 replace 模式，实际：${JSON.stringify(r)}`);
  return r;
}

function asPatch(json: string): { ops: Array<{ index?: number; text?: string; status?: string }> } {
  const r = parseTaskArgs(json);
  if (!r.ok || r.mode !== 'patch') throw new Error(`期望 patch 模式，实际：${JSON.stringify(r)}`);
  return r;
}

function asError(json: string): string {
  const r = parseTaskArgs(json);
  if (r.ok) throw new Error(`期望拒绝，实际通过：${JSON.stringify(r)}`);
  return r.content;
}

describe('parseTaskArgs — 全量模式（tasks）', () => {
  it('合法清单：items 原序、三态原样', () => {
    const { items } = asReplace(
      JSON.stringify({
        tasks: [
          { text: '查资料', status: 'done' },
          { text: '写大纲', status: 'in_progress' },
          { text: '排版', status: 'pending' },
        ],
      }),
    );
    expect(items).toEqual([
      { text: '查资料', status: 'done' },
      { text: '写大纲', status: 'in_progress' },
      { text: '排版', status: 'pending' },
    ]);
  });

  it('空 text 条目丢弃、status 非法值归一 pending、超长 text 截 100 字', () => {
    const { items } = asReplace(
      JSON.stringify({
        tasks: [
          { text: '  ', status: 'done' },
          { text: '正常条目', status: 'doing' },
          { text: 'x'.repeat(300), status: 'done' },
        ],
      }),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ text: '正常条目', status: 'pending' });
    expect(items[1]?.text).toHaveLength(100);
    expect(items[1]?.status).toBe('done');
  });

  it('空数组 / 全空条目：拒绝并给「怎么改对」', () => {
    expect(asError(JSON.stringify({ tasks: [] }))).toContain('非空数组');
    expect(asError(JSON.stringify({ tasks: [{ text: '', status: 'pending' }] }))).toContain('非空');
  });

  it(`超过 ${MAX_TASK_ITEMS} 条：整单拒绝（提示收敛粒度），不截断静默通过`, () => {
    const tasks = Array.from({ length: MAX_TASK_ITEMS + 1 }, (_, i) => ({ text: `t${i}`, status: 'pending' }));
    const c = asError(JSON.stringify({ tasks }));
    expect(c).toContain(String(MAX_TASK_ITEMS));
  });
});

describe('parseTaskArgs — 增量模式（updates）', () => {
  it('按序号更新：只带改动字段，不要求 text', () => {
    const { ops } = asPatch(JSON.stringify({ updates: [{ index: 2, status: 'done' }] }));
    expect(ops).toEqual([{ index: 2, status: 'done' }]);
  });

  it('不传 index 视为追加（必须有 text），status 缺省待办', () => {
    const { ops } = asPatch(JSON.stringify({ updates: [{ text: '补一条' }] }));
    expect(ops).toEqual([{ text: '补一条' }]);
  });

  it('in_progress 是合法状态（长任务标记「正在做」）', () => {
    const { ops } = asPatch(JSON.stringify({ updates: [{ index: 1, status: 'in_progress' }] }));
    expect(ops[0]?.status).toBe('in_progress');
  });

  it('index 非整数 / < 1：拒绝并说明从 1 开始', () => {
    expect(asError(JSON.stringify({ updates: [{ index: 1.5, status: 'done' }] }))).toContain('整数');
    expect(asError(JSON.stringify({ updates: [{ index: 0, status: 'done' }] }))).toContain('整数');
  });

  it('追加却没给 text：拒绝', () => {
    expect(asError(JSON.stringify({ updates: [{ status: 'done' }] }))).toContain('追加');
  });

  it('给了 index 却没有任何改动字段：拒绝（空操作不该占一次工具轮）', () => {
    expect(asError(JSON.stringify({ updates: [{ index: 1 }] }))).toContain('没有任何改动');
  });

  it('updates 非数组或空数组：拒绝并给示例', () => {
    expect(asError(JSON.stringify({ updates: [] }))).toContain('非空数组');
    expect(asError(JSON.stringify({ updates: 'nope' }))).toContain('非空数组');
  });

  it(`一次超过 ${MAX_TASK_UPDATES} 条：拒绝并引导改用 tasks 全量`, () => {
    const updates = Array.from({ length: MAX_TASK_UPDATES + 1 }, (_, i) => ({ index: i + 1, status: 'done' }));
    const c = asError(JSON.stringify({ updates }));
    expect(c).toContain(String(MAX_TASK_UPDATES));
    expect(c).toContain('tasks');
  });
});

describe('parseTaskArgs — 模式选择与坏入参', () => {
  it('两种都给：拒绝（互斥，不静默丢弃其中一条指令）', () => {
    const c = asError(JSON.stringify({ tasks: [{ text: 'a', status: 'done' }], updates: [{ index: 1, status: 'done' }] }));
    expect(c).toContain('只能给一个');
  });

  it('两种都不给：拒绝并给两种用法示例', () => {
    const c = asError('{}');
    expect(c).toContain('tasks');
    expect(c).toContain('updates');
  });

  it('坏 JSON：不抛，回灌两种模式的口径', () => {
    const c = asError('{not json');
    expect(c).toContain('JSON');
    expect(c).toContain('updates');
  });
});

describe('applyTaskPatch — 整批原子应用', () => {
  const base: TaskItem[] = [
    { text: '查资料', status: 'in_progress' },
    { text: '写大纲', status: 'pending' },
  ];

  it('按序号改状态 / 改内容 / 追加，一次调用可混合', () => {
    const r = applyTaskPatch(base, [{ index: 1, status: 'done' }, { index: 2, text: '写详细大纲' }, { text: '排版' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.content);
    expect(r.items).toEqual([
      { text: '查资料', status: 'done' },
      { text: '写详细大纲', status: 'pending' },
      { text: '排版', status: 'pending' },
    ]);
  });

  it('追加可自带状态（直接就是进行中）', () => {
    const r = applyTaskPatch([], [{ text: '第一步', status: 'in_progress' }]);
    if (!r.ok) throw new Error(r.content);
    expect(r.items).toEqual([{ text: '第一步', status: 'in_progress' }]);
  });

  it('序号越界：整批拒绝，并把「当前清单 + 序号」回灌给模型自纠', () => {
    const r = applyTaskPatch(base, [{ index: 5, status: 'done' }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('应当拒绝');
    expect(r.content).toContain('超出范围');
    expect(r.content).toContain('1. [>] 查资料');
    expect(r.content).toContain('2. [ ] 写大纲');
  });

  it('空清单 + 按序号更新：拒绝并提示先用 tasks 列清单（增量无法凭空定位）', () => {
    const r = applyTaskPatch([], [{ index: 1, status: 'done' }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('应当拒绝');
    expect(r.content).toContain('tasks');
  });

  it(`追加后超过 ${MAX_TASK_ITEMS} 条：整批拒绝（预检在前）`, () => {
    const full: TaskItem[] = Array.from({ length: MAX_TASK_ITEMS }, (_, i) => ({ text: `t${i}`, status: 'pending' }));
    const r = applyTaskPatch(full, [{ index: 1, status: 'done' }, { text: '多出来的一条' }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('应当拒绝');
    expect(r.content).toContain(String(MAX_TASK_ITEMS));
  });

  it('整批原子：一条越界则同一批里的合法条目也不生效', () => {
    const r = applyTaskPatch(base, [{ index: 1, status: 'done' }, { index: 99, status: 'done' }]);
    expect(r.ok).toBe(false);
    expect(base[0]?.status).toBe('in_progress'); // 原数组未被改动
  });

  it('纯函数：不改动传入的数组（调用方持有的是本轮真相）', () => {
    const cur: TaskItem[] = [{ text: 'a', status: 'pending' }];
    const r = applyTaskPatch(cur, [{ index: 1, status: 'done' }]);
    if (!r.ok) throw new Error(r.content);
    expect(cur[0]?.status).toBe('pending');
    expect(r.items[0]?.status).toBe('done');
    expect(r.items).not.toBe(cur);
  });
});

describe('清单渲染与回灌文案', () => {
  it('renderTaskList：带序号 + 三态标记（序号是增量定位的锚点，必须给）', () => {
    const s = renderTaskList([
      { text: '查资料', status: 'done' },
      { text: '写大纲', status: 'in_progress' },
      { text: '排版', status: 'pending' },
    ]);
    expect(s).toBe('1. [x] 查资料\n2. [>] 写大纲\n3. [ ] 排版');
  });

  it('formatTaskList：计数含进行中，且附完整清单', () => {
    const s = formatTaskList([
      { text: '查资料', status: 'done' },
      { text: '写大纲', status: 'in_progress' },
      { text: '排版', status: 'pending' },
    ]);
    expect(s).toContain('共 3 项');
    expect(s).toContain('已完成 1 项');
    expect(s).toContain('进行中 1 项');
    expect(s).toContain('3. [ ] 排版');
  });

  it('formatTaskList：没有进行中条目时不写「进行中 0 项」（不啰嗦）', () => {
    expect(formatTaskList([{ text: 'a', status: 'done' }])).not.toContain('进行中');
  });
});
