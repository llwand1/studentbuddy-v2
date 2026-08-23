/**
 * llm/types — 适配器契约（port from v1 adapter/types，字段语义不变）。
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
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
