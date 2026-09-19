/**
 * chat/tools/budget —— tools JSON 计量锁（契约 §4.4 第 1 条）。
 * 口径锁：与 `chat/context.ts#estimateTokens` 同计数法（不另起第二套），空清单虚零。
 */
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../context.js';
import { toolDefinitionTokens } from './budget.js';
import { toolDefinitions } from './index.js';

describe('toolDefinitionTokens', () => {
  it('空清单=0（不给 baseline 虚增）', () => {
    expect(toolDefinitionTokens([])).toBe(0);
  });

  it('与 estimateTokens(JSON.stringify(...)) 严格同口径', () => {
    const defs = toolDefinitions();
    expect(toolDefinitionTokens(defs)).toBe(estimateTokens(JSON.stringify(defs)));
  });

  it('现役四工具清单是实打实的系统开销（>1k token 量级，漏计即预算恒少算这一截）', () => {
    const tokens = toolDefinitionTokens(toolDefinitions());
    expect(tokens).toBeGreaterThan(1000);
  });
});
