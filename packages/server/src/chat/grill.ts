/**
 * chat/grill —— grill-me 模式（v18，2026-09-16）。
 *
 * 【这个模式要解决什么】
 * `ask_choice`（方案选择框）工程链路早就全通：工具已注册、SSE 三帧完整、卡片与逃生口齐全。
 * 但真机几乎见不到——根因是**触发权在模型手里**。系统提示那句「遇到岔路时先问一句」是
 * 原则性描述，模型在 `tool_choice='auto'` 下的出厂倾向是**直接把答案讲完**；
 * `choice-nudge.ts` 的词表增强只提高倾向、不保证，且它的排除表（是什么/为什么/怎么用/报错…）
 * 恰好覆盖了学习场景 90% 的真实提问。
 *
 * 结论：**「要不要问」不该是模型的概率判断，该是用户的显式开关。**
 * grill-me 就是这个开关——打开后，每一轮必定出现选择框（开场问方向 + 收尾问下一步），
 * 靠 `tool_choice` 强绑 `ask_choice` 由工程保证，不依赖模型自觉。
 *
 * 【两段提问的语义是相反的，别搞混】
 * - `pre`（开场）：答复**要回灌**给模型——模型据此决定这一轮讲什么。=> 必须挂起等待。
 * - `post`（收尾）：本轮回答已给完，答复**不回灌**——用户点选后由前端作为**新一轮提问**发出。
 *   => 绝不挂起（`offerChoice`）。挂起会把这一轮钉在 busy 上，「可以跳过」就成假承诺。
 *
 * 【为什么单独成文件】
 * `flow.ts` 已 376 行、门禁 400，本模式的指令文本与收尾编排塞进去会顶破；
 * 且指令是会随实测反复调的**提示词**，与调度逻辑分开改更稳（先例 `choice-nudge.ts`）。
 */
import type { ChatMessage, LLMAdapter, ToolCall, ToolDefinition } from '../llm/types.js';
import { runToolCalls } from './tool-exec.js';
import { runChoiceTool } from './choice-tool.js';
import { type ToolContext, type ToolResult } from './tools/index.js';
import { aiText } from '../ai/gateway.js';

/**
 * 开场硬指令（pre）：强制模型第一个动作就是 ask_choice。
 *
 * 与 `CHOICE_NUDGE` 的区别：那条是「你**应该**问」（软），这条是「你**必须**问」（硬），
 * 且配套 `tool_choice` 强绑，模型没有不调的自由度。
 */
export const GRILL_PRE =
  '（GrillMe 本轮需要先确定学习路线。）' +
  '你的**第一个动作必须是调用 ask_choice**，一次只问一个尚未解决的问题，给出 2~4 个具体方向让他选。' +
  '先利用对话和范围中已有的信息，不重复询问已经选择的方向；选项写清会学什么，说明简短，不用泛泛的深入/举例。' +
  '拿到他的选择后再展开正文；除非缺少影响正确回答的必要条件，不再接连询问深度和形式。';

/**
 * 收尾硬指令（post）：回答给完之后，问「下一步」。
 * 刻意强调「不要再重复刚讲过的内容」——否则模型收尾时容易把正文摘要一遍再问。
 */
export const GRILL_POST =
  '（grill-me 收尾）本轮回答已完成。现在调用 ask_choice 抛出 2~4 个**下一步**选项。' +
  '根据本次回答预判具体的疑问、容易误解之处、适合的小练习；一次只聚焦一个知识缺口。' +
  'label 是可直接发给 AI 的完整、具体、简短问题（最好 24 字以内）；description 最多一句说明学习收获。' +
  '不得使用泛泛的「继续深入」「举个例子」代替具体主题，不提供刚讲过的重复路线，不提前泄露练习答案。' +
  '不要总结刚讲过的内容，只给选项。';

/** 两段指令的纯函数出口：便于单测与日后按模型能力分档下发 */
export function grillInstruction(phase: 'pre' | 'post'): string {
  return phase === 'pre' ? GRILL_PRE : GRILL_POST;
}

/** pre 轮强绑的工具选择（OpenAI 口径 `{type:'function',name}`，适配器负责转 Anthropic 口径） */
export const GRILL_TOOL_CHOICE = { type: 'function', name: 'ask_choice' } as const;

export interface GrillClosingDeps {
  sessionId: string;
  adapter: LLMAdapter;
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** 本轮已有 messages（会被 push 一条 GRILL_POST；调用点位于落库之后，不污染历史） */
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  onStep: (tool: string, status: 'running' | 'done' | 'error', detail?: string) => void;
  /** 归属用户 id：收尾这轮工具里若发起 LLM 调用（tidy_terms auto），记在发起者头上 */
  /** ★ **必填**：工具里可能读写词条库（归属操作），漏传即静默串台/丢写 */
  ownerId: string | null;
}

/**
 * 收尾提问（post 段）：让模型产出「下一步」选项，**不等用户选择**。
 *
 * 为什么单独跑一次调用：正文那一轮已经结束（`for` 循环因无工具调用而 break），
 * 收尾提问是**额外的一轮**，且这一轮只要 tool_call、不要正文——
 * 故 `tool_choice` 强绑 `ask_choice`，模型不会多吐一个字的讲解。
 *
 * 失败一律静默：收尾问不出来不该让整轮回答失败（`ok:false` 会把已上屏的回答标成出错）。
 */
export async function runGrillClosing(deps: GrillClosingDeps): Promise<void> {
  const { sessionId, adapter, model, apiKey, baseUrl, messages, tools, signal, onStep, ownerId } = deps;

  // 只问下一步，不需要会话历史之外的东西；push 到 messages 尾部即「最后一轮」
  messages.push({ role: 'user', content: GRILL_POST });

  const choiceTools = tools.filter(t => t.function.name === 'ask_choice');
  const result = await aiText({ purpose: 'chat.grill', ownerId,
    target: { adapter, type: adapter.type, streamMode: 'once', model, apiKey, baseUrl: baseUrl ?? '', quota: { platform: false, ownerId } }, messages,
    toolChoice: GRILL_TOOL_CHOICE, tools: choiceTools, maxTokens: 2048, streamMode: 'once', signal });
  const calls: ToolCall[] | undefined = result.ok ? result.toolCalls?.filter(c => c.name === 'ask_choice').slice(0, 1) : undefined;
  if (!calls || calls.length === 0) return;

  // offerOnly：落库 + 广播后立即返回，本函数不挂起（见文件头 post 段说明）
  const exec = (name: string, argsJson: string, ctx: ToolContext): Promise<ToolResult> => {
    if (name !== 'ask_choice') return Promise.resolve({ content: '收尾仅提供学习路线。' });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      parsed = {}; // 解析失败交给 runChoiceTool 的校验去回灌「参数不合法」
    }
    return runChoiceTool(parsed, { ...ctx, grillPhase: 'post' }, { offerOnly: true });
  };

  try {
    await runToolCalls(calls, { onStep }, { sessionId, signal, exec, noTimeout: ['ask_choice'], ownerId });
  } catch {
    return; // 同上：收尾不是主链路
  }
}
