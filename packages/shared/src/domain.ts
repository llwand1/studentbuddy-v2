/**
 * 领域模型：会话 / 消息 / 服务商与角色绑定（演进①）/ 词条（SRS 字段·演进④）。
 * M0 登记骨架字段，M1/M3 随实现扩容并保持与 storage 层一致。
 */
import type { QuizQuestion } from './content-blocks.js';

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

/** 学习角色（演进①）：各环节独立绑定 provider+model，未配置落默认。
 * v17 新增 'vision'：纯文本主模型借它「读图」（图→视觉模型→文字描述→塞回主模型上下文）
 * v25 新增 'coach'：复习督促小窗的陪练人格（未单独绑定时回退 explain，见 learning/coach.ts） */
export type ModelRole = 'explain' | 'quiz-generator' | 'solver' | 'analyzer' | 'summarizer' | 'judge' | 'vision' | 'coach';

export interface RoleBinding {
  role: ModelRole;
  providerId: string;
  model: string;
}

/** 一轮回答的呈现形态：stream=逐字流式（原生 AI 全过程体验）；once=思考中 UI + 整块上屏（池中 AI） */
export type StreamMode = 'stream' | 'once';

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  /** 密文（DPAPI+AES-GCM），永不出现在 API 响应中 */
  apiKeyCipher?: string;
  enabled: boolean;
  /** v13 起随 provider 落库；缺省按 type：anthropic=stream，openai=once */
  streamMode?: StreamMode;
  /**
   * 归属用户 id（M2c，契约 `docs/TENANCY-SPEC.md` §8.1）。**`null` = 平台通道**（老板出的钱，
   * 保留值语义与 §3 孤儿行一致），非 null 即 BYOK 用户自带的 key。
   *
   * ★ 为什么要出站：设置页需要据此区分「**我的**（可改可删）」与「**平台的**（只读）」——
   *   平台的 provider 对登录用户必须**可见**（否则他没法把角色绑到免费通道上，免费额度就成了摆设），
   *   但**不可改**（改掉全站模型就跟着变，正是 §8.1 要消灭的洞）。不给这个字段，UI 就只能
   *   把所有 provider 都画成可编辑，用户点下去必然撞一个服务端拒绝。
   */
  ownerId: string | null;
}

/** 词条库条目（忆域 v2：AI 自动词条库；废弃 MemorizeItem/SRS 翻卡，2026-09-01 契约） */
export interface TermItem {
  id: string;
  term: string;
  definition: string;
  domain: string;
  /** 同义词别名（AI 整理时被并入的词名，2026-09-03 契约 TERM-TIDY-SPEC） */
  aliases: string[];
  sourceSessionId?: string | null;
  importance: number;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 词条整理：同义词簇（keep 为主词条，merge 为被并入 id；TERM-TIDY-SPEC §5） */
export interface TidyCluster {
  keep: string;
  term: string;
  domain: string;
  merge: string[];
  reason: string;
}

/** 词条整理方案（[TIDY] 协议解析产物；applyTidy 前须再校验） */
export interface TidyPlan {
  clusters: TidyCluster[];
  domainRenames: Record<string, string>;
}

/** 词条整理结果摘要（tidy_terms 工具回灌给模型，由其自然语言转述） */
export interface TidySummary {
  result: 'ok' | 'noop' | 'error';
  before?: number;
  after?: number;
  mergedClusters?: Array<{ canonical: string; aliases: string[]; reason: string }>;
  domainRenames?: Record<string, string>;
  message?: string;
}

// ── 深度理解（DEEP-UNDERSTANDING-SPEC v1.1，2026-09-06 契约登记 · WBS 任务 1）──

/** [VERDICT] 协议解析产物，亦 SSE verdict block 的 payload（§6.1 / §9.1） */
export interface Verdict {
  /** 必须是本会话深度理解词条之一（服务端白名单校验，不匹配丢弃该块） */
  term: string;
  /** 本次判定后该词条应处等级，0..4 离散（normalizeVerdict 钳制） */
  level: number;
  /** 面向用户的评语（≤500 字，normalizeVerdict 截断） */
  verdict: string;
  gaps?: string[];
  /** 下一级目标（level=4 时可空） */
  nextGoal?: string | null;
  /** 留档不展示 */
  evidence?: string;
  /** v1.1 证据式判定：本轮命中的 §3 rubric 正面证据要素（≤3 条；空数组=本轮无新证据，诚实档） */
  met?: string[];
}

/** 深度理解会话里单个词条的状态（§8） */
export interface EvolutionTermState {
  id: string;
  term: string;
  domain: string;
  definition: string;
  /** 当前等级（最新判定，允许降级） */
  level: number;
  /** 历史最高（只增不减，难度档与成就展示用） */
  bestLevel: number;
}

/** GET/POST /api/evolution 响应（§8） */
export interface EvolutionState {
  active: boolean;
  terms: EvolutionTermState[];
}

// ── 刷题笔记（QUIZ-NOTES-SPEC，2026-09-13 契约）──
// 提交答案即自动落一篇结构化草稿（题目/我的作答/对错/解析为快照），心得手写补全。
// 快照字段（quizTitle/questionData）刻意冗余、不设外键：题库删除后笔记仍自洽可读。

/** 笔记列表行（GET /api/notes） */
export interface QuizNoteSummary {
  id: string;
  quizId: string;
  questionIndex: number;
  quizTitle: string;
  /** 题干快照（列表展示用，取自 questionData） */
  question: string;
  /** 最近一次作答是否正确 */
  correct: boolean;
  /** 心得是否已写（草稿态 = false） */
  hasBody: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 笔记详情（GET /api/notes/:id；questionData 为整题快照，svg 含在内） */
export interface QuizNote extends QuizNoteSummary {
  questionData: QuizQuestion;
  /** 用户作答快照：single/multiple 为选项下标数组，fill 为文本，essay 未作答为 null */
  myAnswer: number[] | string | null;
  body: string;
}

/** 理解链节点行（evolution_event 表 API 形状；termText 为抗删快照，§5/§8） */
export interface EvolutionEventRow {
  id: string;
  sessionId: string;
  termId: string;
  termText: string;
  fromLevel: number;
  toLevel: number;
  verdict: string;
  gaps: string[];
  nextGoal: string | null;
  userSay: string;
  createdAt: string;
}
