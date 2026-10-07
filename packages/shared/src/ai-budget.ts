/** 交互式短 JSON：修复也包含在总预算里；客户端多留 5 秒传输余量。 */
export const INTERACTIVE_AI_BUDGET = {
  totalMs: 40_000,
  clientMs: 45_000,
  maxTokens: 2048,
  repairMaxTokens: 4096,
} as const;
