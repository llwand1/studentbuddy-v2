/**
 * 领域模型：会话 / 消息 / 服务商与角色绑定（演进①）/ 词条（SRS 字段·演进④）。
 * M0 登记骨架字段，M1/M3 随实现扩容并保持与 storage 层一致。
 */

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** fork 来源会话（析环单题深挖用） */
  forkedFromId?: string;
  pinned: boolean;
}

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  /** assistant 的原生工具调用（单轨 function-calling） */
  toolCalls?: ToolCall[];
  /** tool 角色回灌时的来源调用 id */
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 学习角色（演进①）：各环节独立绑定 provider+模型，未配置落默认 */
export type ModelRole = 'explain' | 'quiz-generator' | 'solver' | 'analyzer' | 'summarizer';

export interface RoleBinding {
  role: ModelRole;
  providerId: string;
  model: string;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  /** 密文（DPAPI+AES-GCM），永不出现在 API 响应中 */
  apiKeyCipher?: string;
  enabled: boolean;
}

/** 词条库条目（忆域 v2：AI 自动词条库；废弃 MemorizeItem/SRS 翻卡，2026-09-01 契约） */
export interface TermItem {
  id: string;
  term: string;
  definition: string;
  domain: string;
  sourceSessionId?: string | null;
  importance: number;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
