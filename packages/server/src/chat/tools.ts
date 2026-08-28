/**
 * chat/tools — 原生工具注册表（单轨 function-calling，G3）。
 * 每工具一函数；新增工具=在此注册，flow 循环零改动。
 */
import type { ToolDefinition } from '../llm/types.js';
import { searchWeb, resultsToContext } from '../search/index.js';

export interface ToolContext {
  /** 工具步骤回调（step 事件上屏） */
  onStep: (tool: string, status: 'running' | 'done' | 'error', detail?: string) => void;
}

export interface ToolResult {
  /** 回灌给模型的 tool 消息内容 */
  content: string;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const registry = new Map<string, RegisteredTool>();

registry.set('search_web', {
  definition: {
    type: 'function',
    function: {
      name: 'search_web',
      description: '联网搜索。用于：概念查证、时效性问题、找资料/找题。返回带来源的搜索结果。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词（中文即可）' } },
        required: ['query'],
      },
    },
  },
  async run(args, ctx) {
    const query = String(args.query ?? '').trim().slice(0, 100);
    if (!query) {
      ctx.onStep('search_web', 'error', '搜索词为空');
      return { content: '搜索词为空，请带 query 重新调用 search_web。' };
    }
    ctx.onStep('search_web', 'running', query);
    const { results, providers, failed } = await searchWeb(query);
    if (results.length === 0) {
      ctx.onStep('search_web', 'error', failed.join('; ') || '无结果');
      return { content: `搜索失败或无结果：${failed.join('; ') || '无结果'}。请基于已有知识回答并说明未联网核实。` };
    }
    const from = providers.filter((p) => p !== 'cache');
    ctx.onStep('search_web', 'done', `${results.length} 条结果${from.length > 0 ? `（来源 ${from.join('、')}）` : '（缓存）'}`);
    return { content: resultsToContext(results) };
  },
});

export function toolDefinitions(): ToolDefinition[] {
  return [...registry.values()].map((t) => t.definition);
}

export function toolNames(): string[] {
  return [...registry.keys()];
}

export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    ctx.onStep(name, 'error', '未知工具');
    return { content: `未知工具：${name}` };
  }
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    ctx.onStep(name, 'error', '参数 JSON 解析失败');
    return { content: '工具参数 JSON 解析失败' };
  }
  try {
    return await tool.run(args, ctx);
  } catch (err) {
    ctx.onStep(name, 'error', err instanceof Error ? err.message : String(err));
    return { content: `工具执行失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
