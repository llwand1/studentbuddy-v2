/**
 * @sb/shared — 前后端契约单一事实源。
 *
 * 原则（规划 §4.1）：SSE 事件 / 内容块协议 / REST 类型 / 领域模型全部在此定义，
 * server 与 web 只引用不复制——根治 v1 前后端类型双写漂移。
 */
export * from './sse-events.js';
export * from './content-blocks.js';
export * from './answer-style.js';
export * from './doc-rag.js';
export * from './api.js';
export * from './domain.js';
