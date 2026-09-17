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
import { askChoice, offerChoice, choiceToolHint } from './choice.js';

export const CHOICE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'ask_choice',
    description:
      '提出方案让学习者拍板，并**等待**他的选择——界面会弹出选择框，他点哪个你就拿到哪个，据此在同一轮继续。' +
      '适用：方案对比、二选一、讲多深/按什么顺序、学习计划这类「存在多条合理路线、选错会浪费他时间」的岔路。' +
      '示例：用户说「想学动态规划」→ 调本工具问「① 从背包入手 ② 从线性 DP 入手 ③ 直接刷题」，他选完你再开讲。' +
      '要求：2~4 个选项，每个配一句取舍说明；**本轮第一个动作就是它**（先写一段正文再问，他会以为已经讲完了）。' +
      '可以**多轮连问**：每次只聚焦一个分歧点，拿到答复后若出现新岔路（方向→深度→形式），就再次调用本工具接着问，' +
      '不要把多个分歧塞进同一个选择框。界面会自动附一个「自己写」的自由输入选项，你不必为开放式回答留口。' +
      '不适用的情况：只是要你讲解某个概念、答案唯一确定——这些直接在回复里处理。',
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

/** 执行模式（v18）：默认挂起等待；`offerOnly` 用于 grill-me 收尾——只提问不等待 */
export interface ChoiceToolMode {
  offerOnly?: boolean;
}

/**
 * 执行：挂起等待学习者点选。**本工具会阻塞整轮**（直到 answered / cancelled），
 * 因此必须同时在 `flow.ts` 的 `runToolCalls` 里登记进 `noTimeout`——
 * 否则 30s 默认超时会把等待掐断（见 tool-exec.ts 的注释）。
 *
 * v18 `mode.offerOnly`：走 `offerChoice` 只提问不等待（grill-me 收尾用）。
 * 那时本轮回答已给完，再挂起会把这一轮钉在 busy 上，用户「不点就跳不过去」。
 */
export async function runChoiceTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
  mode?: ChoiceToolMode,
): Promise<ToolResult> {
  if (!ctx.sessionId) {
    ctx.onStep('ask_choice', 'error', '缺少会话上下文');
    return { content: '当前没有会话上下文，无法弹出选择框，请直接作答。' };
  }
  ctx.onStep('ask_choice', 'running', mode?.offerOnly ? '给出下一步选项' : '等待学习者选择');
  const ask = mode?.offerOnly ? offerChoice : askChoice;
  const res = await ask({
    sessionId: ctx.sessionId,
    question: args.question,
    options: args.options,
    allowCustom: args.allowCustom,
    multi: args.multi,
    grillPhase: ctx.grillPhase,
  } as Parameters<typeof askChoice>[0]);
  if (!res.ok) {
    // 参数不合法属模型可自纠的错：如实回灌「怎么改对」，不中断整轮（契约 §4.2 纠错口径）
    ctx.onStep('ask_choice', 'error', res.error);
    return { content: `ask_choice 参数不合法：${res.error}。请修正后重新调用，或直接作答。` };
  }
  if (mode?.offerOnly) {
    ctx.onStep('ask_choice', 'done', '已给出下一步选项（不等选择）');
    return { content: '已向学习者列出下一步选项，本轮到此结束。' };
  }
  const cancelled = res.record.status === 'cancelled';
  ctx.onStep('ask_choice', 'done', cancelled ? '学习者未选择（已作废）' : '学习者已拍板');
  return { content: choiceToolHint(res.record) };
}
