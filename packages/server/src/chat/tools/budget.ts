/**
 * chat/tools/budget —— tools JSON 的 token 计量（契约 `docs/TOOL-ECOSYSTEM-SPEC.md` §4.4 第 1 条）。
 *
 * 为什么单列：工具定义随每轮请求全量下发，是系统侧开销的一部分，原先**不进任何预算**——
 * v1 漂移过一次（工具清单变长 ⇒ 历史被多砍），S1 把它计入 `systemPromptTokens` 同口径。
 * 估算复用 `chat/context.ts#estimateTokens`（CJK 1/字、其余按词），不另起第二套计数法。
 */
import type { ToolDefinition } from '../../llm/types.js';
import { estimateTokens } from '../context.js';

/** 下发工具清单的 JSON 序列化开销（空清单=0，不给 baseline 虚增） */
export function toolDefinitionTokens(tools: ToolDefinition[]): number {
  if (tools.length === 0) return 0;
  return estimateTokens(JSON.stringify(tools));
}
