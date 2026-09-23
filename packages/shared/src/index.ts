/**
 * @sb/shared — 前后端契约单一事实源。
 *
 * 原则（规划 §4.1）：SSE 事件 / 内容块协议 / REST 类型 / 领域模型全部在此定义，
 * server 与 web 只引用不复制——根治 v1 前后端类型双写漂移。
 */
export * from './sse-events.js';
export * from './content-blocks.js';
export * from './quiz-source.js';
export * from './choice.js';
export * from './answer-style.js';
export * from './doc-rag.js';
export * from './api.js';
export * from './domain.js';
export * from './pk.js';
export * from './task-list.js';
export * from './quiz-weak.js';
export * from './memory.js';
export * from './study-flow.js';
export * from './study-flow-params.js';
export * from './scenario.js';
export * from './auth.js';
export * from './ebbinghaus.js';
export * from './review-goal.js';
export * from './term-highlight.js';
export * from './coach.js';
export * from './tool-ecosystem.js';
export * from './fts.js';
export * from './chat-limits.js';
export * from './speech.js';
export * from './follow-up.js';
export * from './platform-quota.js';
export * from './platform-channel.js';
export * from './demo-content.js';
