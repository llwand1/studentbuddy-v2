/**
 * process-summary —— 收口后过程区一行摘要（纯函数回归）。
 * 摘要是用户对「这轮它干了什么」的第一眼，口径钉死：同工具合并计数、思考链过千字才报字数、
 * 空过程给兜底文案（不渲染空按钮）。
 */
import { describe, expect, it } from 'vitest';
import { processSummary } from './process-summary.js';

describe('processSummary', () => {
  it('全空给兜底文案（调用方据此不渲染按钮，但函数本身不抛）', () => {
    expect(processSummary({})).toBe('查看过程');
    expect(processSummary({ reasoning: '', steps: [], tasks: [] })).toBe('查看过程');
  });

  it('只有思考链：短报「已深度思考」，过千字带字数', () => {
    expect(processSummary({ reasoning: '想了一下' })).toBe('已深度思考');
    expect(processSummary({ reasoning: 'x'.repeat(1234) })).toBe('已深度思考（1.2k 字）');
  });

  it('同工具多次调用合并计数，不同工具按出现顺序排列', () => {
    const steps = [{ tool: 'search_web' }, { tool: 'search_web' }, { tool: 'search_web' }];
    expect(processSummary({ steps })).toBe('联网搜索 ×3');
    expect(processSummary({ steps: [{ tool: 'search_web' }, { tool: 'tidy_terms' }] })).toBe(
      '联网搜索 · 整理词条库',
    );
  });

  it('未知工具名原样展示（注册表扩展后摘要不撒谎）', () => {
    expect(processSummary({ steps: [{ tool: 'run_code' }] })).toBe('run_code');
  });

  it('三类过程齐全时按 思考 · 工具 · 任务 顺序拼一行', () => {
    expect(
      processSummary({
        reasoning: '深度思考内容',
        steps: [{ tool: 'search_web' }, { tool: 'search_web' }],
        tasks: [{}, {}, {}],
      }),
    ).toBe('已深度思考 · 联网搜索 ×2 · 任务清单 3 项');
  });
});
