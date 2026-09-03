/**
 * 内容块协议（演进③）：LLM 流式输出 → 服务端 block-builder 切分为结构化块 →
 * SSE block 事件下发 → 前端 block-registry 按 kind 渲染。
 *
 * 新增卡片类型 = 在此登记 BlockKind + web 注册一个渲染器（不改正文解析）。
 *
 * 现状（2026-08-28）：`quiz` 走 SSE block 事件；`svg` / `chart` / `html` 由前端识别正文里的同名围栏
 * 直接渲染卡片（不占 block 通道；html 不在本应用 DOM 内渲染，只送进右侧沙箱预览面板或新标签页）。
 * 曾登记但无发射器也无渲染器的 markdown / form / code 已摘除（2026-08-28）；`actions` 已登记但尚未实现。
 */

export type BlockKind =
  | 'quiz' // [QUIZ] 协议题组（payload: QuizData）
  | 'chart' // 图表 DSL
  | 'actions' // 动作按钮组（已登记，尚未实现）
  | 'svg'; // 内联 SVG 预览（经净化）

export interface ContentBlock<K extends BlockKind = BlockKind> {
  kind: K;
  /** 会话内唯一块 id，流式追加按 blockId 聚合 */
  blockId: string;
  payload: K extends 'quiz' ? QuizPayload : GenericPayload;
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

// ── 出题题型配比（一次出题各题型各来几道，用户可配，每档 ≥0）──
export type QuizType = QuizQuestion['type'];

/** 题型顺序即出题排列顺序（提示词与裁剪都按它，改序即改行为） */
export const QUIZ_TYPES: readonly QuizType[] = ['single', 'multiple', 'fill', 'essay'];

export const QUIZ_TYPE_LABELS: Record<QuizType, string> = {
  single: '单选题',
  multiple: '多选题',
  fill: '填空题',
  essay: '解答题',
};

/** 四种题型各自的题数（0 = 本次不出该题型） */
export type QuizMix = Record<QuizType, number>;

/** 落 app_settings 的键名（server 读写，前端不直接碰库） */
export const SETTING_KEY_QUIZ_MIX = 'quiz_mix';

/** 默认配比：2 单选 + 1 填空 + 1 解答（M2 原固定行为，配出来是为了可改） */
export const DEFAULT_QUIZ_MIX: QuizMix = { single: 2, multiple: 0, fill: 1, essay: 1 };

/** 单题型上限 10：再多是强模型也难一次出齐，且输出会长到撞上下文 */
export const MAX_QUIZ_PER_TYPE = 10;
/** 总题数上限 20（只减不报错，见 normalizeQuizMix） */
export const MAX_QUIZ_TOTAL = 20;

export function mixTotal(mix: QuizMix): number {
  return QUIZ_TYPES.reduce((sum, t) => sum + mix[t], 0);
}

/** 出题结果报告：请求了什么配比、实际出了什么、是否出齐（前端据此如实告知，不静默） */
export interface QuizMixReport {
  requested: QuizMix;
  actual: QuizMix;
  /** 四类题都出够才 true；false 时 UI 如实报缺哪类（ADR-5） */
  matched: boolean;
}

/**
 * 配比归一化：非数字/负数→0，小数取整，单题型钳到 10，总超 20 从后往前削。
 * **全 0 回退默认**（一套 0 题的题组没有意义，宁可按默认出也不静默空手而归）。
 * 前端输入与服务端入参都过这一道，保证两端看到同一份配比。
 */
export function normalizeQuizMix(input: unknown): QuizMix {
  const src = (input ?? {}) as Partial<Record<QuizType, unknown>>;
  const out: QuizMix = { ...DEFAULT_QUIZ_MIX };
  for (const t of QUIZ_TYPES) {
    const n = Number(src[t]);
    out[t] = Number.isFinite(n) ? Math.min(MAX_QUIZ_PER_TYPE, Math.max(0, Math.trunc(n))) : 0;
  }
  let over = mixTotal(out) - MAX_QUIZ_TOTAL;
  for (let i = QUIZ_TYPES.length - 1; i >= 0 && over > 0; i--) {
    const t = QUIZ_TYPES[i];
    if (!t) continue;
    const cut = Math.min(out[t], over);
    out[t] -= cut;
    over -= cut;
  }
  return mixTotal(out) === 0 ? { ...DEFAULT_QUIZ_MIX } : out;
}

/**
 * 编辑态单步调整（设置页 +/− 按钮用）：加档同时受「单题型上限」与「总题数上限」两道约束。
 * 与 normalizeQuizMix 的分工：normalize 是落库兜底（超了从后往前削，可能动到别的题型），
 * 本函数是编辑期就钳住（加不进去就是加不进去，绝不动别的档位）。
 * 前端用本函数先钳住，就不会出现「配到 30 题、保存后被服务端悄悄削掉」这种无法预期的闪变；
 * 服务端 normalize 因此只作兜底而非主路径。返回新对象，不改入参。
 */
export function stepQuizMix(mix: QuizMix, type: QuizType, delta: number): QuizMix {
  if (delta === 0) return { ...mix };
  if (delta < 0) return { ...mix, [type]: Math.max(0, mix[type] + delta) };
  const step = Math.min(delta, MAX_QUIZ_PER_TYPE - mix[type], MAX_QUIZ_TOTAL - mixTotal(mix));
  return { ...mix, [type]: mix[type] + Math.max(0, step) };
}
