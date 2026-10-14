/** content-reports: split domain module; compatible exports remain at content-blocks.ts. */
import type { QuizPayload } from './content-blocks.js';
import type { ExamScopeReport } from './exam-scope.js';
import type { QuizQuestion } from './content-blocks.js';

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
  preparation?: import('./question-seeds.js').QuestionPreparation;
  /**
   * 出题失败的**真因**（2026-09-13）：`'no-model'`＝出题角色没绑模型（怎么重试都没用，要去设置页）；
   * `'parse'`＝模型给了输出但解不出题组；`'ungrounded'`＝本次联网题全缺少有效引用。
   * 由**确实知道原因的一方**（出题引擎）填写，
   * 路由只据此选文案——不靠反向探测「模型配没配」来猜，那种猜法在被 mock 的测试里、在角色绑定
   * 存在但 provider 被停用的边缘态里都会判错。
   */
  failure?: 'no-model' | 'parse' | 'incomplete' | 'ungrounded';
  /** 自包含审查报告（契约 QUIZ-COMPLETE-SPEC §4）。可选：没跑审查的调用方不填。 */
  completeness?: QuizCompletenessReport;
}

/**
 * 自包含审查报告（契约 `docs/QUIZ-COMPLETE-SPEC.md` §4，ADR-5 不静默）：
 * 「这组题里几道是无头题、怎么处理的」如实上报，前端据此说「已剔除 N 道依赖缺失材料的题」。
 */
export interface QuizCompletenessReport {
  /** 送审题数 */
  checked: number;
  /** 检出悬空引用（题干指向不存在的材料/图/表）的题数 */
  dangling: number;
  /** 改写补全：把材料写进 material 后放行 */
  repaired: number;
  /** 找图补全：搬来真实图片（essential）后放行 */
  imaged: number;
  /** 补不全，整题剔除 */
  dropped: number;
  /** 被剔除题的一句话原因（最多 5 条，给前端/日志） */
  reasons: string[];
}

export function emptyQuizCompletenessReport(): QuizCompletenessReport {
  return { checked: 0, dangling: 0, repaired: 0, imaged: 0, dropped: 0, reasons: [] };
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

// ── 出题联网检索（契约 docs/QUIZ-SEARCH-SPEC.md v1.1）──

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
  /** 应试模式范围账（EXAM-1004）：范围内命中几条、范围外滤掉几条、走过哪几个站内直达。关着无此键 */
  scope?: ExamScopeReport;
}

/** 零值报告：出题前先建好，传给 generateQuiz 当出参（避开 undefined 分支） */
export function emptyQuizSearchReport(on = false): QuizSearchReport {
  return { on, count: 0, providers: [], failed: [], refs: [] };
}

// ── 现场搜集题目（契约 docs/RESOURCE-SPEC.md v0.2）──

/** 一页的逐页记录：抓没抓到、没抓到为什么（契约 §3.1，ADR-5——跳过要能说清，不静默） */
export interface CollectPageRecord {
  url: string;
  title: string;
  fetched: boolean;
  /** fetched=false 时的真因（HTTP 状态 / 非 HTML / 正文过短 / 超时 / SSRF 拦截） */
  reason?: string;
  /** 判为「考试真题页」（契约 QUIZ-TIER-SPEC §3：≥2 个考试信号；可选，历史记录无此键） */
  exam?: boolean;
  /** 命中的考试信号（如「高考」「2023年」「题源:组卷网」），供报告回显 */
  signals?: string[];
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
  /** 自包含审查（契约 QUIZ-COMPLETE-SPEC §5）：摘到几道带材料的题、搬了几张原图、拒了几道无头题 */
  completeness?: CollectCompletenessReport;
  /** 应试模式范围账（EXAM-1004）：真题侧同样要能报「范围内未取到真题」 */
  scope?: ExamScopeReport;
}

export interface CollectCompletenessReport {
  /** 页面里识别到的候选配图张数（标记 `[图N]`） */
  figuresSeen: number;
  /** 成功搬进本站缓存并挂到题上的原图张数 */
  figuresAttached: number;
  /** 图下载/核验失败的张数 */
  figuresFailed: number;
  /** 带着材料原文摘下来的题数 */
  withMaterial: number;
  /** 因「题干依赖材料/图/表但没取到」被拒的题数 */
  rejectedIncomplete: number;
}

export function emptyCollectCompleteness(): CollectCompletenessReport {
  return { figuresSeen: 0, figuresAttached: 0, figuresFailed: 0, withMaterial: 0, rejectedIncomplete: 0 };
}

/** 零值报告：preview 路由先建好传给域层 */
export function emptyCollectReport(): CollectReport {
  return {
    queries: [], providers: [], failed: [], pages: [], total: 0, accepted: 0, rejected: 0,
    completeness: emptyCollectCompleteness(),
  };
}
