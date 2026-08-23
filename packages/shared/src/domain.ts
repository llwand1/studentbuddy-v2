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

/** 背词词条（SRS 字段：next_review_at 到期队列 / ease / interval） */
export interface MemorizeItem {
  id: string;
  term: string;
  definition: string;
  category?: string;
  difficulty: 0 | 1 | 2;
  status: 'new' | 'learning' | 'mastered';
  /** SM-2：easy factor（1.3-2.5） */
  easeFactor: number;
  /** SM-2：当前间隔天数 */
  intervalDays: number;
  nextReviewAt: string | null;
  reviewCount: number;
  lapseCount: number;
}
