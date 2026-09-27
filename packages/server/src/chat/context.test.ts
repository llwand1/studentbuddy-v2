import { describe, it, expect } from 'vitest';
import { alignToolRoundBoundary, truncateHistoryToBudget, estimateTokens, dropSummarizedHistory } from './context.js';
import type { ChatMessage } from '../llm/types.js';

describe('context 截断 — 工具轮边界对齐（v1 崩溃级 bug 回归，防拆散 tool_calls 致 API 400）', () => {
  const mk = (role: ChatMessage['role'], content = 'x'): ChatMessage => ({ role, content });

  it('截断点落在 tool 消息上 → 向旧方向吸入至来源 assistant', () => {
    const h: ChatMessage[] = [mk('user'), mk('assistant'), mk('tool'), mk('tool'), mk('user', 'q'), mk('assistant', 'a')];
    // start=2 命中 tool：应对齐到 1（assistant）
    expect(alignToolRoundBoundary(h, 2)).toBe(1);
  });

  it('同轮兄弟 tool 结果一并保留（对齐到 assistant 而非中间）', () => {
    const h: ChatMessage[] = [mk('user'), mk('assistant'), mk('tool'), mk('tool'), mk('user'), mk('assistant')];
    expect(alignToolRoundBoundary(h, 3)).toBe(1);
  });

  it('历史起点即孤儿 tool（数据缺陷）→ 丢弃头部孤儿', () => {
    const h: ChatMessage[] = [mk('tool'), mk('tool'), mk('user'), mk('assistant')];
    expect(alignToolRoundBoundary(h, 0)).toBe(2);
  });

  it('截断后序列绝不以 tool 开头（预算逐档扫掠不变式）', () => {
    const h: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      h.push(mk('user', `问题${i}`.repeat(5)), mk('assistant', `回答${i}`.repeat(5)), mk('tool', '结果'), mk('tool', '结果2'));
    }
    for (let budget = 0; budget <= 3000; budget += 150) {
      const out = truncateHistoryToBudget(h, { limit: budget, systemPromptTokens: 0 });
      expect(out[0]?.role).not.toBe('tool');
    }
  });

  it('预算极小仍保留最后一轮', () => {
    const h: ChatMessage[] = [mk('user', 'a'), mk('assistant', 'b'), mk('user', 'c'), mk('assistant', 'd')];
    const out = truncateHistoryToBudget(h, { limit: 0, systemPromptTokens: 0 });
    expect(out.length).toBeGreaterThan(0);
    expect(out[out.length - 1]?.content).toBe('d');
  });

  it('token 估算：CJK 按 1、英文按词', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('hello world')).toBe(2);
  });
});

describe('context 长期记忆 — 丢弃已被摘要覆盖的历史（MEMORY-SPEC §4.4）', () => {
  const mk = (rowid: number, role: ChatMessage['role'], content = 'x'): ChatMessage & { rowid: number } => ({
    rowid,
    role,
    content,
  });

  it('uptoRowid=0（从未压缩）→ 原样返回同一引用，不做任何过滤', () => {
    const h = [mk(1, 'user'), mk(2, 'assistant')];
    expect(dropSummarizedHistory(h, 0)).toBe(h);
  });

  it('丢弃 rowid ≤ 锚点的部分，保留之后的', () => {
    const h = [mk(1, 'user'), mk(2, 'assistant'), mk(3, 'user'), mk(4, 'assistant')];
    expect(dropSummarizedHistory(h, 2).map((m) => m.rowid)).toEqual([3, 4]);
  });

  it('过滤后若以孤儿 tool 开头 → 丢弃头部孤儿（锚点理论上已对齐，仍兜一层）', () => {
    const h = [mk(1, 'user'), mk(2, 'tool'), mk(3, 'tool'), mk(4, 'user')];
    const out = dropSummarizedHistory(h, 1);
    expect(out[0]?.role).toBe('user');
    expect(out.map((m) => m.rowid)).toEqual([4]);
  });

  it('锚点超过全部 rowid → 返空数组（不该发生，但不能崩）', () => {
    expect(dropSummarizedHistory([mk(1, 'user'), mk(2, 'assistant')], 99)).toEqual([]);
  });
});
