/**
 * llm/model-limits — 输出 token 上限按模型名兜底（port from v1）。
 * 中转/本地模型默认上限常仅 2048 会截断长回答；显式给安全值。
 *
 * 2026-09-13 两处更新（老板点单「模型配置优化」）：
 * ① 补入漏登型号：o3/o4、gpt-4.5、deepseek-reasoner/deepseek-r1、gemini、grok；
 *    并把 claude 档从 8192 提到 16384（Claude 3.5 起全线 ≥8192，Claude 4 支持 32k，16384 安全）。
 * ② 新增**出题专用**上限 `getQuizMaxOutputTokens`——出题一次要吐十题带解析与 SVG，比聊天更吃输出预算。
 */
const MAX_OUTPUT_OVERRIDES: Array<[RegExp, number]> = [
  [/o1|o3|o4|gpt-5/, 32000],
  [/gpt-4\.1/, 32000],
  [/deepseek-reasoner|deepseek-r1/, 32000],
  [/gpt-4o|gpt-4\.5/, 16384],
  [/gemini|grok/, 16384],
  [/claude/, 16384],
  [/deepseek|qwen|glm|kimi|agnes/, 8192],
];
const DEFAULT_MAX_OUTPUT = 8192;

export function getMaxOutputTokens(model: string): number {
  const m = (model || '').toLowerCase();
  for (const [re, v] of MAX_OUTPUT_OVERRIDES) if (re.test(m)) return v;
  return DEFAULT_MAX_OUTPUT;
}

// ── 出题专用参数（docs/QUIZ-SEARCH-SPEC.md §2.6）──

/**
 * 出题温度：低于聊天默认的 0.7（适配器 `req.temperature ?? 0.7`）。
 * 出题一次要吐一大坨严格 JSON（题干/选项/答案/解析/可选 SVG），温度越高越容易在**结构**上跑偏
 * （漏字段、漏引号）——`quiz.ts` 那套四级抢救阶梯有一半就是在为它擦屁股。降温度是收益最直接的一刀，
 * 且不改题目难度（难度归提示词管）。
 */
export const QUIZ_TEMPERATURE = 0.4;

/**
 * 出题输出上限：取「通用上限」与出题下限的较大者。
 *
 * ★ 为什么**不是**给所有模型无脑抬到 16k —— 这是本函数存在的理由，别把下面这段删了：
 *   qwen-max / glm-4 / moonshot 这类常用国产型号，`max_tokens` 上限本来就在 8k 上下；
 *   抬到 16k 会被网关以 400 拒绝，出题**整条挂掉**——比「撞顶截断」严重得多（截断至少还有逐题回退保前半组）。
 *   所以这里按家族**白名单**抬高，名单外一律沿用通用表。
 *
 * ★ 已知边界（如实记账）：8k 档模型（qwen/glm/kimi/agnes）出十题带 SVG 仍可能撞顶，
 *   此时靠 `quiz.ts` 的 `salvageTruncatedQuiz` 逐题回退保住前缀并如实报 `truncated`。
 *   要彻底避开，只能把出题角色换成支持大输出的模型（设置页 → 角色模型绑定），
 *   或在设置页把题型总配比调小——本函数不做越权的猜测性抬高。
 */
const QUIZ_OUTPUT_OVERRIDES: Array<[RegExp, number]> = [
  [/o1|o3|o4|gpt-5|gpt-4\.1|deepseek-reasoner|deepseek-r1/, 32000],
  [/gpt-4o|gpt-4\.5|gemini|grok|claude/, 16384],
];

export function getQuizMaxOutputTokens(model: string): number {
  const base = getMaxOutputTokens(model);
  const m = (model || '').toLowerCase();
  for (const [re, v] of QUIZ_OUTPUT_OVERRIDES) if (re.test(m)) return Math.max(base, v);
  return base;
}
