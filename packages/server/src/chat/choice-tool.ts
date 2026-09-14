/**
 * chat/choice-tool — `ask_choice` 工具（方案选择框的模型侧入口）。
 *
 * 单独成文件的理由（不是拆着好看）：
 * ① `tools.ts` 是「一次调用即返回」的工具集合，本工具的性质是**长时间挂起**——混在一起会让
 *    「工具都能秒回」这个隐含假设失效，单独一份便于把这个例外讲清楚。
 * ② 工具描述（何时该问 / 何时不该问）是**提示词**，会随实测反复调，与调度逻辑分开改。
 *
 * 与 `tools.ts` 的关系：本文件只导出「定义 + 执行函数」，注册动作仍在 `tools.ts` 一处完成
 * （单一注册入口，避免工具清单出现第二份事实源）。
 * 类型只做 `import type`，故不构成 tools.ts ↔ choice-tool.ts 的运行时循环依赖。
 */
import type { ToolDefinition } from '../llm/types.js';
import type { ToolContext, ToolResult } from './tools.js';
import { askChoice, choiceToolHint } from './choice.js';

export const CHOICE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'ask_choice',
    description:
      '当需要学习者在若干方案中拍板时使用：方案对比、二选一、需要人工决定的关键岔路' +
      '（例如「先补基础还是先刷题」「按概念还是按题型整理」「这次讲多深」）。' +
      '调用后界面会弹出选择框并**等待**学习者点选，返回他的选择，你据此在同一轮里继续。' +
      '不要在只需告知结论时使用；不要用它问开放式问题（要开放内容直接在回复里问即可）。' +
      '一次只问一件事，2~4 个选项，每个选项给一句话取舍说明。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要学习者拍板的问题（一句话说清分歧点）' },
        options: {
          type: 'array',
          description: '2~4 个候选方案，每个含一句话取舍说明',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '方案名（简短，一眼能分辨）' },
              description: { type: 'string', description: '一句话说明这个方案的取舍' },
            },
            required: ['label'],
          },
        },
        allowCustom: {
          type: 'boolean',
          description: '是否允许「以上都不是，我自己写」的自由输入出口（默认允许）',
        },
      },
      required: ['question', 'options'],
    },
  },
};

/**
 * 执行：挂起等待学习者点选。**本工具会阻塞整轮**（直到 answered / cancelled），
 * 因此必须同时在 `flow.ts` 的 `runToolCalls` 里登记进 `noTimeout`——
 * 否则 30s 默认超时会把等待掐断（见 tool-exec.ts 的注释）。
 */
export async function runChoiceTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.sessionId) {
    ctx.onStep('ask_choice', 'error', '缺少会话上下文');
    return { content: '当前没有会话上下文，无法弹出选择框，请直接作答。' };
  }
  ctx.onStep('ask_choice', 'running', '等待学习者选择');
  const res = await askChoice({
    sessionId: ctx.sessionId,
    question: args.question,
    options: args.options,
    allowCustom: args.allowCustom,
    multi: args.multi,
  });
  if (!res.ok) {
    // 参数不合法属模型可自纠的错：如实回灌「怎么改对」，不中断整轮（契约 §4.2 纠错口径）
    ctx.onStep('ask_choice', 'error', res.error);
    return { content: `ask_choice 参数不合法：${res.error}。请修正后重新调用，或直接作答。` };
  }
  const cancelled = res.record.status === 'cancelled';
  ctx.onStep('ask_choice', 'done', cancelled ? '学习者未选择（已作废）' : '学习者已拍板');
  return { content: choiceToolHint(res.record) };
}
