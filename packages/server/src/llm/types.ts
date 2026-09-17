/**
 * llm/types — 适配器契约（port from v1 adapter/types，字段语义不变）。
 */
/**
 * 多模态 content-part（v17 看图功能）：文本段或图片段。
 * 视觉模型（如 qwen-vl-plus / gpt-4o / glm-4v）通过 `image_url` 接收图片，
 * 纯文本主模型不会收到图片 part——图在 `chat/vision.ts` 里被蒸馏成文字后再进主模型上下文。
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 纯文本，或多模态段数组（视觉调用传图时用；主模型仍收纯文本） */
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /**
   * 这条 assistant 消息的思考链原文。anthropic 适配器在「thinking + 工具循环」场景下
   * 必须把它作为 thinking 块随 assistant(tool_use) 回灌（Anthropic 契约：思考块不回传会 400）；
   * openai 适配器忽略此字段。
   */
  reasoning?: string;
}

/** 前端上传的图片（base64 dataURL 内联，零新依赖、零静态服务） */
export interface UploadedImage {
  dataUrl: string;
  name?: string;
}

/**
 * 把 `ChatMessage.content` 收敛成纯文本：算 token、拼日志、回灌工具结果都只认文本。
 * 图片段在这里**丢弃**（像素不进纯文本上下文）——图片只在视觉调用那一跳有意义。
 */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 上游配额优先级（2026-09-17 并发闸门 `upstream-gate.ts`）：
 * - `main`（默认）：用户在等的主链请求（对话 / 出题 / 判题 / 看图蒸馏…）
 * - `background`：为下一轮备料的后台任务（词条抽取、会话内压缩）——排队时给主链让路
 */
export type UpstreamPurpose = 'main' | 'background';

export interface ChatRequest {
  model: string;
  apiKey: string;
  baseUrl?: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
  /** 上游配额优先级，缺省 `main`（见 UpstreamPurpose） */
  purpose?: UpstreamPurpose;
  tools?: ToolDefinition[];
  maxTokens?: number;
  /**
   * 回答呈现形态（v13）：'stream' 逐字流式（默认，行为不变）；'once' 一次性回答——
   * 适配器内部改发非流式请求，把完整答案作为单个 chunk 吐出。
   * 前端对此形态自然呈现「思考中 → 整块上屏」（首 token 前的空窗即思考中 UI）。
   */
  streamMode?: 'stream' | 'once';
  /** 原生思考链开关（仅 anthropic 适配器生效）：开启后 reasoning 以 thinking_delta 增量吐出 */
  thinking?: boolean;
  /**
   * 工具选择策略（v18 grill-me，2026-09-16）：`'auto'`＝模型自己决定（默认，行为不变）；
   * `{ type:'function', name }`＝**强绑**指定工具，本轮模型必须调它。
   *
   * 为什么需要：系统提示里写「遇到岔路时先问一句」属于原则性描述，模型在 `auto` 下
   * 的出厂倾向是**直接把答案讲完**，于是 `ask_choice` 几乎不被调用（`choice-nudge.ts`
   * 的词表增强只提高倾向，不保证）。强绑把「模型自己判断要不要问」升级成
   * 「工程保证必问」——这是 grill-me 模式存在的前提。
   */
  toolChoice?: 'auto' | 'none' | { type: 'function'; name: string };
}

export interface TokenChunk {
  content: string;
  done: boolean;
  finishReason?: string;
  reasoning?: string;
  usage?: { promptTokens: number; completionTokens: number };
  toolCalls?: ToolCall[];
}

export interface ModelListRequest {
  baseUrl?: string;
  apiKey?: string;
}

export interface LLMAdapter {
  type: 'openai' | 'anthropic';
  chat(req: ChatRequest): AsyncIterable<TokenChunk>;
  listModels(config?: ModelListRequest): Promise<string[]>;
}
