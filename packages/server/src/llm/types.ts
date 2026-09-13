/**
 * llm/types — 适配器契约（port from v1 adapter/types，字段语义不变）。
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /**
   * 这条 assistant 消息的思考链原文。anthropic 适配器在「thinking + 工具循环」场景下
   * 必须把它作为 thinking 块随 assistant(tool_use) 回灌（Anthropic 契约：思考块不回传会 400）；
   * openai 适配器忽略此字段。
   */
  reasoning?: string;
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

export interface ChatRequest {
  model: string;
  apiKey: string;
  baseUrl?: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
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
