/**
 * chat/task-list —— 任务清单工具解析与校验回归（不触 LLM/DB/SSE）。
 * 覆盖：合法解析（status 归一）/ 坏 JSON / 空 tasks / 超上限 / 空条目丢弃。
 */
import { describe, expect, it } from 'vitest';
import { MAX_TASK_ITEMS, parseTaskList } from './task-list.js';

describe('parseTaskList', () => {
  it('合法清单：返回 items 原序，content 带完成计数', () => {
    const r = parseTaskList(
      JSON.stringify({
        tasks: [
          { text: '查资料', status: 'done' },
          { text: '写大纲', status: 'pending' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.items).toEqual([
      { text: '查资料', status: 'done' },
      { text: '写大纲', status: 'pending' },
    ]);
    expect(r.content).toContain('2 项');
    expect(r.content).toContain('1 项');
  });

  it('坏 JSON：不抛，回灌「怎么改对」的指示', () => {
    const r = parseTaskList('{not json');
    expect(r.ok).toBe(false);
    expect(r.items).toEqual([]);
    expect(r.content).toContain('JSON');
  });

  it('tasks 缺失或为空数组：拒绝并给示例', () => {
    expect(parseTaskList('{}').ok).toBe(false);
    expect(parseTaskList(JSON.stringify({ tasks: [] })).ok).toBe(false);
    expect(parseTaskList(JSON.stringify({ tasks: [] })).content).toContain('非空数组');
  });

  it(`超过 ${MAX_TASK_ITEMS} 条：整单拒绝（提示收敛粒度），不截断静默通过`, () => {
    const tasks = Array.from({ length: MAX_TASK_ITEMS + 1 }, (_, i) => ({ text: `t${i}`, status: 'pending' }));
    const r = parseTaskList(JSON.stringify({ tasks }));
    expect(r.ok).toBe(false);
    expect(r.content).toContain(String(MAX_TASK_ITEMS));
  });

  it('空 text 条目丢弃、status 非法值归一为 pending、超长 text 截 100 字', () => {
    const r = parseTaskList(
      JSON.stringify({
        tasks: [
          { text: '  ', status: 'done' },
          { text: '正常条目', status: 'doing' },
          { text: 'x'.repeat(300), status: 'done' },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual({ text: '正常条目', status: 'pending' });
    expect(r.items[1]?.text).toHaveLength(100);
    expect(r.items[1]?.status).toBe('done');
  });

  it('全是空条目：等效空清单，拒绝', () => {
    const r = parseTaskList(JSON.stringify({ tasks: [{ text: '', status: 'pending' }] }));
    expect(r.ok).toBe(false);
    expect(r.content).toContain('非空');
  });
});
