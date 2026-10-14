/** content-blocks: split domain module; compatible exports remain at content-blocks.ts. */
import type { QuizSourceMix } from './quiz-source.js';

export type BlockKind =
  | 'quiz' // [QUIZ] 协议题组（payload: QuizData）
  | 'scenario' // 情景题卡片（payload: ScenarioPayload；blockId=scenario-<demoId>，SCENARIO-SPEC §8 M3）
  | 'chart' // 图表 DSL
  | 'actions' // 动作按钮组（已登记，尚未实现）
  | 'svg';

// 内联 SVG 预览（经净化）

export interface ContentBlock<K extends BlockKind = BlockKind> {
  kind: K;
  /** 会话内唯一块 id，流式追加按 blockId 聚合 */
  blockId: string;
  payload: K extends 'quiz' ? QuizPayload : K extends 'scenario' ? import('./scenario.js').ScenarioPayload : GenericPayload;
}

export interface QuizQuestion {
  /**
   * 题型（PK-SPEC §15 B2）：`judge` 是 `single` 的特例——
   * options 恒两项（`['正确','错误']`）、answer 是正确项下标 → **一切按选项判分的链路
   * （对战判分/题库/对话答题）零特判**。题型清单见 `QUIZ_TYPES`，追加在末位（顺序即出题排列序，
   * 中插会改「从后往前削」的既有语义，刻意不动）。
   */
  type: 'single' | 'multiple' | 'fill' | 'essay' | 'judge';
  question: string;
  options?: string[];
  /** single/multiple/judge: 正确选项下标（multiple 多选）；fill: 按空位顺序的答案数组；essay: 参考要点 */
  answer?: number[] | string[] | string;
  explanation?: string;
  solution?: string;
  /**
   * 该题的来源（契约 `docs/QUIZ-SEARCH-SPEC.md` §2.8；`'collect'` 见 `docs/RESOURCE-SPEC.md` §3.1）。
   * **服务端按模型给的编号映射后回填，URL 永远来自真实检索结果**：模型只许给编号、
   * 不许写网址（幻觉 URL 是弱模型常态，"来源写错"比"没有来源"更糟）。
   * 模型没给编号或编号越界 → 不填此字段，由套题级来源清单兜底。历史题无此键 → 不渲染。
   * `'collect'`＝现场搜集摘录的题，title/url 由 verbatim 锚点命中的那个页面回填。
   */
  source?: { kind: 'web' | 'ai' | 'collect'; title: string; url?: string };
  /**
   * 分级（契约 `docs/QUIZ-TIER-SPEC.md`）：real 真题·必刷 / simulated 模拟题·建议做 / basic 基础题·可选做。
   * **服务端按来源事实推导**（模型自报不算数）。可选字段：历史题无此键 → 前端用 `tierOf(q)` 按 `source.kind` 兜底。
   * 判分/对战/复习一律不读它。
   */
  tier?: import('./quiz-tier.js').QuizTier;
  /**
   * 配图：SVG 源码（契约 docs/QUIZ-IMAGE-SPEC.md）。模型自决——需要示意图才给，看得懂文字就不给。
   * 可选字段：历史题无此键 → undefined → 不渲染，**不做数据迁移**；判分逻辑不读它，图只作附加展示。
   */
  svg?: string;
  /**
   * 网络配图（2026-09-29，`learning/quiz-photo.ts`）：从 Commons/Bing 找来、经看图核验且不泄露答案的真实图片。
   * 与 `svg` 并存（那是模型手绘的示意图）。可选字段：历史题无此键 → 不渲染；判分不读它，题目不看图也能答。
   */
  photo?: QuizPhoto;
  /**
   * 题干所依赖的**材料原文**（2026-09-29，契约 `docs/QUIZ-COMPLETE-SPEC.md`）：阅读文段、材料一二、表格数据。
   * 题干里出现「根据材料 / 如下表」时，被引用的东西必须在这里（或 `svg` / `photo`）——**每道题自包含**。
   * 可选字段：历史题无此键 → 不渲染。判分不读它，但**盲解验算、AI 阅卷、对战出题**都要用 `stemOf(q)` 取全文。
   */
  material?: string;
  /** Owned scenario task snapshot, attached by the round endpoint rather than model output. */
  scenarioTask?: { id: string; demoId: string; criteria: import('./scenario.js').ScenarioCriteria };
}

/** material 字段上限（字符）：一篇阅读理解约 1500–2500 字，留足余量又防把整页倒进来 */
export const MAX_QUIZ_MATERIAL_CHARS = 4000;

/** 题目的完整题干＝材料＋题干。所有「把题干交给别的模型 / 别的界面」的地方都该走它，不要直接读 `q.question`。 */
export function stemOf(q: Pick<QuizQuestion, 'question' | 'material'>): string {
  const m = (q.material ?? '').trim();
  return m ? `【材料】\n${m}\n\n【题目】${q.question}` : q.question;
}

export interface QuizPhoto {
  /** 站内地址 `/api/images/<hash>.<ext>` */
  src: string;
  alt: string;
  /** 署名：来源 · 作者 · 许可（纯文本） */
  credit: string;
  pageUrl?: string;
  /**
   * 题目**依赖**这张图（题干写着「如图」）。与普通配图的区别：普通配图不看也能答、找不到就算了；
   * essential 的图找不到，这道题就不该出（契约 QUIZ-COMPLETE-SPEC §3）。
   */
  essential?: boolean;
}

export interface QuizPayload {
  title?: string;
  questions: QuizQuestion[];
  /** 基于用户评价生成的新题；随题卡保存，刷新仍可对照这次调整。 */
  feedback?: { comment: string; adjustment: string };
}

export interface GenericPayload {
  [key: string]: unknown;
}

// ── 出题题型配比（一次出题各题型各来几道，用户可配，每档 ≥0）──
export type QuizType = QuizQuestion['type'];

/** 题型顺序即出题排列顺序（提示词与裁剪都按它，改序即改行为） */
/** 题型顺序即出题排列顺序（提示词与裁剪都按它，改序即改行为）；judge 追加在末位（B2，见 QuizQuestion.type 注） */
export const QUIZ_TYPES: readonly QuizType[] = ['single', 'multiple', 'fill', 'essay', 'judge'];

export const QUIZ_TYPE_LABELS: Record<QuizType, string> = {
  single: '单选题',
  multiple: '多选题',
  fill: '填空题',
  essay: '解答题',
  judge: '判断题',
};

/** 四种题型各自的题数（0 = 本次不出该题型） */
export type QuizMix = Record<QuizMixKind, number>;

// ── 配比档位（第 5 档情景题，SCENARIO-SPEC §6.1）：配比是「档位」概念——
// scenario 不是 QuizQuestion 形状（情景题走独立引擎、一套=一个可玩 demo），不能混进 QuizType，
// 但用户在设置页要的是同一张配比卡统一调，所以配比层把它并成第 5 档。
export type QuizMixKind = QuizType | 'scenario';

/** 档位顺序 = 出题执行顺序：传统四类走一道引擎出完，情景题排末位逐套生成（贵，砍单先砍它） */
export const MIX_KINDS: readonly QuizMixKind[] = [...QUIZ_TYPES, 'scenario'];

export const MIX_KIND_LABELS: Record<QuizMixKind, string> = { ...QUIZ_TYPE_LABELS, scenario: '情景题' };

/** 情景题单档上限：一套 = 一次整页 demo 的 LLM 生成（比一道普通题贵一个量级），钳 3 */
export const MAX_SCENARIO_PER_MIX = 3;

/** 单档上限按档取：情景题用更紧的上限，其余题型维持 10 */
export function mixKindCap(kind: QuizMixKind): number {
  return kind === 'scenario' ? MAX_SCENARIO_PER_MIX : MAX_QUIZ_PER_TYPE;
}

/** 落 app_settings 的键名（server 读写，前端不直接碰库） */
export const SETTING_KEY_QUIZ_MIX = 'quiz_mix';

/** 默认配比：2 单选 + 1 填空 + 1 解答，判断题/情景题默认关（0；老用户升级后行为零变化） */
export const DEFAULT_QUIZ_MIX: QuizMix = { single: 2, multiple: 0, fill: 1, essay: 1, judge: 0, scenario: 0 };

/** 单题型上限 10：再多是强模型也难一次出齐，且输出会长到撞上下文 */
export const MAX_QUIZ_PER_TYPE = 10;

/** 总题数上限 20（只减不报错，见 normalizeQuizMix） */
export const MAX_QUIZ_TOTAL = 20;

export function mixTotal(mix: QuizMix): number {
  return MIX_KINDS.reduce((sum, t) => sum + mix[t], 0);
}

/** 出题结果报告：请求了什么配比、实际出了什么、是否出齐（前端据此如实告知，不静默） */
export interface QuizMixReport {
  requested: QuizMix;
  actual: QuizMix;
  /** 四类题都出够才 true；false 时 UI 如实报缺哪类（ADR-5） */
  matched: boolean;
}

/** 一次出题里情景题的逐套结果（SCENARIO-SPEC §6.1）：部分失败如实报，不静默、不整体作废 */
export interface ScenarioMixResult {
  ok: boolean;
  quizId?: string;
  demoId?: string;
  /** 失败真因透传引擎 report（no-model / parse），UI 据此给不同指引 */
  failure?: string;
}

/**
 * 配比归一化：非数字/负数→0，小数取整，单题型钳到 10，总超 20 从后往前削。
 * **全 0 回退默认**（一套 0 题的题组没有意义，宁可按默认出也不静默空手而归）。
 * 前端输入与服务端入参都过这一道，保证两端看到同一份配比。
 */
/**
 * 配比归一化：非数字/负数→0，小数取整，单题型钳到 10，总超 20 从后往前削。
 * **全 0 回退默认**（一套 0 题的题组没有意义，宁可按默认出也不静默空手而归）——
 * ★ 但**纯真题组例外**：`realMix` 有题时，AI 侧全 0 是合法配置（用户就要这一套全真题），
 *   此时不回退默认（契约 `docs/QUIZ-BLEND-SPEC.md` §3.3 的「AI 侧 0 则跳过 AI 出题」正是靠这条成立）。
 *   `realMix` 是可选尾参：省略即旧行为，既有调用点与测试零改动。
 * 前端输入与服务端入参都过这一道，保证两端看到同一份配比。
 */
export function normalizeQuizMix(input: unknown, realMix?: QuizSourceMix): QuizMix {
  const src = (input ?? {}) as Partial<Record<QuizMixKind, unknown>>;
  const out: QuizMix = { ...DEFAULT_QUIZ_MIX };
  for (const t of MIX_KINDS) {
    const n = Number(src[t]);
    out[t] = Number.isFinite(n) ? Math.min(mixKindCap(t), Math.max(0, Math.trunc(n))) : 0;
  }
  let over = mixTotal(out) - MAX_QUIZ_TOTAL;
  for (let i = MIX_KINDS.length - 1; i >= 0 && over > 0; i--) {
    const t = MIX_KINDS[i];
    if (!t) continue;
    const cut = Math.min(out[t], over);
    out[t] -= cut;
    over -= cut;
  }
  // 真题侧的求和就地算，**不 import `sourceMixTotal`**——那会让 content-blocks ↔ quiz-source 变成
  // 运行时循环依赖（两边都值引用对方），本仓明令避让。
  const realTotal = realMix ? MIX_KINDS.reduce((sum, t) => sum + realMix[t], 0) : 0;
  return mixTotal(out) === 0 && realTotal === 0 ? { ...DEFAULT_QUIZ_MIX } : out;
}

/**
 * 编辑态单步调整（设置页 +/− 按钮用）：加档同时受「单题型上限」与「总题数上限」两道约束。
 * 与 normalizeQuizMix 的分工：normalize 是落库兜底（超了从后往前削，可能动到别的题型），
 * 本函数是编辑期就钳住（加不进去就是加不进去，绝不动别的档位）。
 * 前端用本函数先钳住，就不会出现「配到 30 题、保存后被服务端悄悄削掉」这种无法预期的闪变；
 * 服务端 normalize 因此只作兜底而非主路径。返回新对象，不改入参。
 */
export function stepQuizMix(mix: QuizMix, type: QuizMixKind, delta: number, realMix?: QuizSourceMix): QuizMix {
  if (delta === 0) return { ...mix };
  if (delta < 0) return { ...mix, [type]: Math.max(0, mix[type] + delta) };
  // `realMix` 是可选尾参（契约 QUIZ-BLEND-SPEC §3.2 的**联合钳位**）：真题已占的额度必须从 AI 侧扣掉，
  // 否则两侧各自钳到 20、合起来就超。省略＝旧行为，老调用点零改动。
  const used = mixTotal(mix) + (realMix ? mixTotal(realMix) : 0);
  const step = Math.min(delta, mixKindCap(type) - mix[type], MAX_QUIZ_TOTAL - used);
  return { ...mix, [type]: mix[type] + Math.max(0, step) };
}

/**
 * 编辑态直输（设置页数字输入框用）：把某档直接设为指定值（替代连点 +）。
 * 约束与 stepQuizMix 同源——单档 [0, 10]；总值 ≤ 20：若输入值会顶破总值上限，
 * 只给到「其他档占用后剩余额度」（恒 ≥ 0），不牵连别的档位。
 * 非数字/NaN → 0；小数取整。返回新对象，不改入参。
 */
export function setQuizMix(mix: QuizMix, type: QuizMixKind, value: number, realMix?: QuizSourceMix): QuizMix {
  const others = mixTotal(mix) - mix[type];
  // 同 stepQuizMix：真题占掉的额度要从 AI 侧的可配空间里扣（联合钳位，契约 §3.2）
  const cap = Math.min(mixKindCap(type), MAX_QUIZ_TOTAL - others - (realMix ? mixTotal(realMix) : 0));
  const v = Number.isFinite(value) ? Math.trunc(value) : 0;
  return { ...mix, [type]: Math.min(Math.max(0, v), Math.max(0, cap)) };
}

export { SETTING_KEY_QUIZ_IMAGE } from './content-reports.js';
export { DEFAULT_QUIZ_IMAGE } from './content-reports.js';
export { MAX_QUIZ_SVG_CHARS } from './content-reports.js';
export { normalizeQuizSvg } from './content-reports.js';
export type { QuizImageReport } from './content-reports.js';
export type { QuizCompletenessReport } from './content-reports.js';
export { emptyQuizCompletenessReport } from './content-reports.js';
export { emptyQuizImageReport } from './content-reports.js';
export { countQuizImages } from './content-reports.js';
export type { QuizRef } from './content-reports.js';
export type { QuizSearchReport } from './content-reports.js';
export { emptyQuizSearchReport } from './content-reports.js';
export type { CollectPageRecord } from './content-reports.js';
export type { CollectCandidate } from './content-reports.js';
export type { CollectReport } from './content-reports.js';
export type { CollectCompletenessReport } from './content-reports.js';
export { emptyCollectCompleteness } from './content-reports.js';
export { emptyCollectReport } from './content-reports.js';
