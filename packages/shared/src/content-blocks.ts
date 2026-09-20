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

import type { Verdict } from './domain.js';
import type { QuizSourceMix } from './quiz-source.js';

export type BlockKind =
  | 'quiz' // [QUIZ] 协议题组（payload: QuizData）
  | 'scenario' // 情景题卡片（payload: ScenarioPayload；blockId=scenario-<demoId>，SCENARIO-SPEC §8 M3）
  | 'chart' // 图表 DSL
  | 'actions' // 动作按钮组（已登记，尚未实现）
  | 'svg' // 内联 SVG 预览（经净化）
  | 'verdict'; // 深度理解判定（payload: Verdict；DEEP-UNDERSTANDING-SPEC §9.1，2026-09-06 登记，渲染器随任务 7）

export interface ContentBlock<K extends BlockKind = BlockKind> {
  kind: K;
  /** 会话内唯一块 id，流式追加按 blockId 聚合 */
  blockId: string;
  payload: K extends 'quiz' ? QuizPayload : K extends 'scenario' ? import('./scenario.js').ScenarioPayload : K extends 'verdict' ? Verdict : GenericPayload;
}

export interface QuizQuestion {
  type: 'single' | 'multiple' | 'fill' | 'essay';
  question: string;
  options?: string[];
  /** single/multiple: 正确选项下标（multiple 多选）；fill: 按空位顺序的答案数组；essay: 参考要点 */
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

/** 默认配比：2 单选 + 1 填空 + 1 解答，情景题默认关（0；老用户升级后行为零变化） */
export const DEFAULT_QUIZ_MIX: QuizMix = { single: 2, multiple: 0, fill: 1, essay: 1, scenario: 0 };

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
  /**
   * 出题联网检索报告（2026-09-13 新增）。**可选**：没要求联网的调用方不填。
   * 挂在同一份出题报告上而不是给 `generateQuiz` 开第 7 个参数——两份报告同族、同生共死，
   * 分开传只会让签名继续膨胀。
   */
  search?: QuizSearchReport;
  /**
   * 出题失败的**真因**（2026-09-13）：`'no-model'`＝出题角色没绑模型（怎么重试都没用，要去设置页）；
   * `'parse'`＝模型给了输出但解不出题组（可重试/换模型）。由**确实知道原因的一方**（出题引擎）填写，
   * 路由只据此选文案——不靠反向探测「模型配没配」来猜，那种猜法在被 mock 的测试里、在角色绑定
   * 存在但 provider 被停用的边缘态里都会判错。
   */
  failure?: 'no-model' | 'parse';
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

// ── 出题联网检索（契约 docs/QUIZ-SEARCH-SPEC.md v1.1；2026-09-13 老板点单）──

/**
 * 一条联网参考来源（契约 `docs/QUIZ-SEARCH-SPEC.md` §2.8）。
 * **URL 只由服务端填，来自真实检索结果**；`n` 与注入提示词里的 `[n]` 一一对应，
 * 前端据此渲染可点击的来源清单，模型给的题目级编号也靠它翻译成 `source`。
 */
export interface QuizRef {
  /** 1 基编号，与注入段的 `[n]` 一致 */
  n: number;
  /** 标题；检索源没给标题时回退成 URL */
  title: string;
  /** 真实网址（空串表示该条无链接，前端只显示标题文本） */
  url: string;
  /** 来自哪家检索源（exa / tavily / zhipu / bing…） */
  provider: string;
}

/**
 * 出题检索报告：本次是否联网、命中几条、哪几家出的、谁失败了。
 * 与 QuizImageReport 同族——都是「缺了什么就说什么」的出参，前端只念不判（ADR-5）。
 * 没有它的话，「没开联网」与「开了但一条也没搜到」在界面上长得一模一样，等于静默。
 */
export interface QuizSearchReport {
  /** 本次请求是否要求联网（false 时 count/providers 恒空，不算失败） */
  on: boolean;
  /** 真正进了提示词的参考条数（去重后） */
  count: number;
  /** 真正产出结果的来源（exa / tavily / zhipu / bing / bing-html 等；缓存命中时为 cache） */
  providers: string[];
  /** 失败的来源摘要；联网开着却一条没拿到时，这是唯一的解释 */
  failed: string[];
  /**
   * 本次参考来源清单（可点击 URL，前端渲染用；模型给的题目级编号也由它翻译）。
   * 条数与 `count` 一致——`count` 是「几条」，它是「哪几条」。
   */
  refs: QuizRef[];
}

/** 零值报告：出题前先建好，传给 generateQuiz 当出参（避开 undefined 分支） */
export function emptyQuizSearchReport(on = false): QuizSearchReport {
  return { on, count: 0, providers: [], failed: [], refs: [] };
}

// ── 现场搜集题目（契约 docs/RESOURCE-SPEC.md v0.2；2026-09-18 老板点单「让产品能现场搜集」）──

/** 一页的逐页记账：抓没抓到、没抓到为什么（契约 §3.1，ADR-5——跳过要能说清，不静默） */
export interface CollectPageRecord {
  url: string;
  title: string;
  fetched: boolean;
  /** fetched=false 时的真因（HTTP 状态 / 非 HTML / 正文过短 / 超时 / SSRF 拦截） */
  reason?: string;
}

/** 一道搜集候选题。ok=false 的 question 只是模型草稿，前端不得当可用题展示 */
export interface CollectCandidate {
  question: QuizQuestion;
  ok: boolean;
  /** ok=false 的逐题拒绝真因（verbatim 未命中 / 答案缺失……） */
  reason?: string;
}

/** 一次搜集的全程报告：搜了什么、检索源成没成、抓到哪几页、摘了几题拒了几题 */
export interface CollectReport {
  /** 实际使用的搜集词（派生结果如实回显——用户看得见搜了什么） */
  queries: string[];
  providers: string[];
  failed: string[];
  pages: CollectPageRecord[];
  total: number;
  accepted: number;
  rejected: number;
  /** 与 QuizImageReport.failure 同族：搜集模型没配 / 输出整段解不出，路由据此选文案不反推 */
  failure?: 'no-model' | 'parse';
}

/** 零值报告：preview 路由先建好传给域层 */
export function emptyCollectReport(): CollectReport {
  return { queries: [], providers: [], failed: [], pages: [], total: 0, accepted: 0, rejected: 0 };
}
