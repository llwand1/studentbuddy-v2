/**
 * llm/model-limits — 输出 token 上限按模型名兜底（port from v1）。
 * 中转/本地模型默认上限常仅 2048 会截断长回答；显式给安全值。
 */
const MAX_OUTPUT_OVERRIDES: Array<[RegExp, number]> = [
  [/o1|gpt-5/, 32000],
  [/gpt-4\.1/, 32000],
  [/gpt-4o/, 16384],
  [/deepseek|qwen|glm|kimi|agnes/, 8192],
  [/claude/, 8192],
];
const DEFAULT_MAX_OUTPUT = 8192;

export function getMaxOutputTokens(model: string): number {
  const m = (model || '').toLowerCase();
  for (const [re, v] of MAX_OUTPUT_OVERRIDES) if (re.test(m)) return v;
  return DEFAULT_MAX_OUTPUT;
}
