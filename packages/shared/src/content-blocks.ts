/**
 * 内容块协议（演进③）：LLM 流式输出 → 服务端 block-builder 切分为结构化块 →
 * SSE block 事件下发 → 前端 block-registry 按 kind 渲染。
 *
 * 新增卡片类型 = 在此登记 BlockKind + web 注册一个渲染器（不改正文解析）。
 *
 * 现状（2026-08-28）：`quiz` 走 SSE block 事件；`svg` / `chart` / `html` 由前端识别正文里的同名围栏
 * 直接渲染卡片（不占 block 通道；html 不在本应用 DOM 内渲染，只送进右侧沙箱预览面板或新标签页）。
 * BlockKind 里的 markdown / form / code 既无发射器也无渲染器，登记未实现。
 */

export type BlockKind =
  | 'markdown' // 纯 markdown 段落
  | 'quiz' // [QUIZ] 协议题组（payload: QuizData）
  | 'chart' // 图表 DSL
  | 'form' // 可输入表单
  | 'actions' // 动作按钮组
  | 'code' // 代码块（可带运行标记，第二批沙箱用）
  | 'svg'; // 内联 SVG 预览（经净化）

export interface ContentBlock<K extends BlockKind = BlockKind> {
  kind: K;
  /** 会话内唯一块 id，流式追加按 blockId 聚合 */
  blockId: string;
  payload: K extends 'quiz' ? QuizPayload : K extends 'markdown' | 'code' ? TextPayload : GenericPayload;
}

export interface TextPayload {
  text: string;
  language?: string;
  /** code 块的可运行标记（第二批沙箱） */
  runnable?: false;
}

export interface QuizQuestion {
  type: 'single' | 'multiple' | 'fill' | 'essay';
  question: string;
  options?: string[];
  /** single/multiple: 正确选项下标（multiple 多选）；fill: 按空位顺序的答案数组；essay: 参考要点 */
  answer?: number[] | string[] | string;
  explanation?: string;
  solution?: string;
  source?: { kind: 'web' | 'ai'; title: string; url?: string };
}

export interface QuizPayload {
  title?: string;
  questions: QuizQuestion[];
}

export interface GenericPayload {
  [key: string]: unknown;
}
