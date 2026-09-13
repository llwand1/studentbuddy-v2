/**
 * llm/model-limits 单测（2026-09-13 新建，随「出题专用参数」批）。
 * 本文件钉三条：
 * ① 通用表的既有取值不许被本批改坏（聊天侧的 max_tokens 是同一张表）；
 * ② 本批补入的型号（o3/o4、gpt-4.5、deepseek-reasoner、gemini、grok）命中正确档位，且
 *    `deepseek-reasoner` 不能被 `/deepseek/` 那条先吃掉（正则顺序是这里唯一的坑）；
 * ③ ★ **不越权抬高**：qwen / glm / kimi 这类国产型号的 max_tokens 上限本就在 8k 上下，
 *    出题上限必须**仍等于**通用上限——抬到 16k 会被网关 400，出题整条挂掉（比截断严重得多）。
 */
import { describe, it, expect } from 'vitest';
import { getMaxOutputTokens, getQuizMaxOutputTokens, QUIZ_TEMPERATURE } from './model-limits.js';

describe('getMaxOutputTokens — 通用表', () => {
  it('大输出档：o1/o3/o4/gpt-5/gpt-4.1 → 32000', () => {
    for (const m of ['o1-preview', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-4.1']) {
      expect(getMaxOutputTokens(m)).toBe(32000);
    }
  });

  it('推理模型档：deepseek-reasoner / deepseek-r1 → 32000（不被 /deepseek/ 的 8192 先吃掉）', () => {
    expect(getMaxOutputTokens('deepseek-reasoner')).toBe(32000);
    expect(getMaxOutputTokens('deepseek-r1')).toBe(32000);
  });

  it('中档：gpt-4o / gpt-4.5 / gemini / grok / claude → 16384（claude 本批由 8192 提上来）', () => {
    for (const m of ['gpt-4o', 'gpt-4.5', 'gemini-2.0-pro', 'grok-2', 'claude-sonnet-4-5']) {
      expect(getMaxOutputTokens(m)).toBe(16384);
    }
  });

  it('保守档：deepseek / qwen / glm / kimi / agnes → 8192（本批未动，避免网关 400）', () => {
    for (const m of ['deepseek-chat', 'qwen-max', 'glm-4-flash', 'kimi-k2', 'agnes-2.5-flash']) {
      expect(getMaxOutputTokens(m)).toBe(8192);
    }
  });

  it('不认识的新模型 → 默认 8192；空串也不崩', () => {
    expect(getMaxOutputTokens('some-brand-new-model')).toBe(8192);
    expect(getMaxOutputTokens('')).toBe(8192);
  });

  it('大小写不敏感（中转站常写成 Qwen-Max / GPT-4O）', () => {
    expect(getMaxOutputTokens('Qwen-Max')).toBe(8192);
    expect(getMaxOutputTokens('GPT-4O')).toBe(16384);
  });
});

describe('getQuizMaxOutputTokens — 出题专用上限', () => {
  it('确认支持大输出的家族按出题档抬升（gpt 系 32000 / claude 与 gpt-4o 16384）', () => {
    expect(getQuizMaxOutputTokens('gpt-4.1')).toBe(32000);
    expect(getQuizMaxOutputTokens('deepseek-reasoner')).toBe(32000);
    expect(getQuizMaxOutputTokens('claude-sonnet-4-5')).toBe(16384);
    expect(getQuizMaxOutputTokens('gpt-4o')).toBe(16384);
  });

  it('★ 国产 8k 档不被抬高：qwen / glm / kimi / agnes 的出题上限 === 通用上限', () => {
    for (const m of ['qwen-max', 'glm-4-flash', 'kimi-k2', 'agnes-2.5-flash', 'deepseek-chat']) {
      expect(getQuizMaxOutputTokens(m)).toBe(getMaxOutputTokens(m));
      expect(getQuizMaxOutputTokens(m)).toBe(8192);
    }
  });

  it('★ 出题上限永不小于通用上限（只抬不压，未知模型也不比聊天更保守）', () => {
    for (const m of ['', 'unknown-x', 'qwen-max', 'claude-sonnet-4-5', 'o3-mini']) {
      expect(getQuizMaxOutputTokens(m)).toBeGreaterThanOrEqual(getMaxOutputTokens(m));
    }
  });
});

describe('QUIZ_TEMPERATURE — 出题温度', () => {
  it('低于适配器默认的 0.7（题目与 JSON 结构都要稳，这是本批收益最直接的一刀）', () => {
    expect(QUIZ_TEMPERATURE).toBeLessThan(0.7);
    expect(QUIZ_TEMPERATURE).toBeGreaterThan(0);
  });
});
