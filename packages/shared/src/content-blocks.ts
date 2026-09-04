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
  /**
   * 配图：SVG 源码（契约 docs/QUIZ-IMAGE-SPEC.md）。模型自决——需要示意图才给，看得懂文字就不给。
   * 可选字段：历史题无此键 → undefined → 不渲染，**不做数据迁移**；判分逻辑不读它，图只作附加展示。
   */
  svg?: string;
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

/**
 * 编辑态直输（设置页数字输入框用）：把某档直接设为指定值（替代连点 +）。
 * 约束与 stepQuizMix 同源——单档 [0, 10]；总值 ≤ 20：若输入值会顶破总值上限，
 * 只给到「其他档占用后剩余额度」（恒 ≥ 0），不牵连别的档位。
 * 非数字/NaN → 0；小数取整。返回新对象，不改入参。
 */
export function setQuizMix(mix: QuizMix, type: QuizType, value: number): QuizMix {
  const others = mixTotal(mix) - mix[type];
  const cap = Math.min(MAX_QUIZ_PER_TYPE, MAX_QUIZ_TOTAL - others);
  const v = Number.isFinite(value) ? Math.trunc(value) : 0;
  return { ...mix, [type]: Math.min(Math.max(0, v), Math.max(0, cap)) };
}

// ── 出题配图开关（契约 docs/QUIZ-IMAGE-SPEC.md §2.2 / §2.3）──

/** 落 app_settings 的键名（server 读写，前端不直接碰库） */
export const SETTING_KEY_QUIZ_IMAGE = 'quiz_image';

/** 默认关：配图显著拉长输出，弱模型先不背这个包袱；要图去设置页开 */
export const DEFAULT_QUIZ_IMAGE = false;

/** 单张 SVG 字符上限：超长基本是模型跑飞了（几百个元素的怪物图） */
export const MAX_QUIZ_SVG_CHARS = 8000;

/**
 * SVG 校验：**只返回「能用的图」或 undefined，绝不抛错** —— 图挂了题必须还在（丢图保题）。
 * 丢弃规则（详见契约 §2.3）：非字符串/空白 → 丢；不含 `<svg` 根标记 → 丢；
 * 缺 `</svg>` 闭合 → 丢（宁可不给，也不给半张残缺图——学习软件里残缺的几何图会教错）；
 * 超 MAX_QUIZ_SVG_CHARS → 丢。
 */
export function normalizeQuizSvg(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const s = input.trim();
  if (!s || s.length > MAX_QUIZ_SVG_CHARS) return undefined;
  const open = s.match(/<svg\b[^>]*>/i);
  if (!open) return undefined;
  // 截断裂据是「有开标记但两种终止写法都没有」：成对 </svg> 或自闭合 <svg .../> 都算收尾完整
  const selfClosed = /\/>\s*$/.test(open[0] ?? '');
  if (!selfClosed && !/<\/svg\s*>/i.test(s)) return undefined;
  return s;
}

/**
 * 配图结果报告（v1.1，契约 §2.4）：开关状态 + 交付几张 + 丢了几张 + 是否撞顶截断过。
 * 与 QuizMixReport 同族：都是「缺了就说什么」的出参，前端只念不判。
 * 不加这个的话，「模型画了但图坏了被丢」与「开关本来关着」在前端长得一模一样——静默，违反 ADR-5。
 */
export interface QuizImageReport {
  /** 本次出题时总开关是否为开（关时 delivered/droppedSvg 恒 0，不算失败） */
  on: boolean;
  /** 最终题组里带可用 svg 的题数（由路由在配比裁剪**后**重算，不报被裁掉的图） */
  delivered: number;
  /** 模型给了 svg 但**最终没交付**的题数：未通过校验（残缺/非源码/超长），或解析救援时被剥掉 */
  droppedSvg: number;
  /** 输出撞 token 上限、靠逐题回退才保住前缀：尾部不完整题已丢弃，题组可用但不全 */
  truncated: boolean;
}

/** 零值报告：路由出题前先建好，传给 generateQuiz 当出参（避开 undefined 分支） */
export function emptyQuizImageReport(on = false): QuizImageReport {
  return { on, delivered: 0, droppedSvg: 0, truncated: false };
}

/**
 * 数题组里实际带可用图的题数。须在配比裁剪**后**调用：
 * 模型画了 3 张、裁剪后只剩 1 张带图的题，就只该报 1，不然前端与题库会对不上数。
 */
export function countQuizImages(quiz: QuizPayload | null | undefined): number {
  return quiz ? quiz.questions.filter((q) => q.svg).length : 0;
}
