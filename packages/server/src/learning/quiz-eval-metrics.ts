/**
 * learning/quiz-eval-metrics — 出题评测的**打分口径**（判据抄录见 `docs/eval/quiz.md`，批次 A＝零裁判、零标注）。
 *
 * ★ 为什么住在 `packages/server/src` 而不是 `tools/eval/`：`tools/` 不在 tsconfig 覆盖内、类型检查抓不到
 *   （隔壁 `doc-rag-eval.mts` 的头注就是为这条登记过一次真漂移），而这里每一条口径都会变成对外报的数字。
 *   运行侧（真调模型、录制、写报告）全在 `tools/eval/`，本文件只算数、不发请求、不读库。
 *
 * 三条纪律：
 * ① **只吃产品事实**：JSON 抽取用产品自己那份 `extractQuizJson`，评测台不复刻正则——
 *   复刻了量的就是评测台而不是产品；
 * ② **分母如实**：量不到的记 `null`（不进除法），绝不把「没量到」算成 0；
 * ③ **一次出组四类定性互斥且穷尽**：strict / repaired / rescued / failed。
 */
import type { QuizImageReport, QuizMix, QuizMixReport, QuizPayload, QuizQuestion, QuizType } from '@sb/shared';
import { QUIZ_TYPES, mixTotal } from '@sb/shared';
import { extractQuizJson } from './quiz.js';
import { repairJsonBrackets, repairJsonEscapes } from './quiz-json-repair.js';

/**
 * 模型这次输出的 JSON「干净到什么程度」：
 * · `strict` ＝ 原样 `JSON.parse` 就通过（模型写的 JSON 本身合法＝**一次成型**）
 * · `repaired` ＝ 原样解不出，靠无损修复（漏转义/漏括号）才合法
 * · `rescued` ＝ 修复也解不出，产品靠剥 svg 值／截断逐题回退救出了题
 * · `failed` ＝ 整组没解出来（用户看到的 502）
 * ⚠️ 与产品事件流水线的 `parseTier: 1..4` **不同源**：那边的第 1 档＝「修复之后 parse 成功」，
 *    把 strict 与 repaired 合成一档。本口径刻意拆开——模型写没写合法 JSON 是**出题质量**，
 *    修复器有多能干是**工程韧性**，混进一个数就再没人知道该改提示词还是该改解析器。
 */
export type QuizParseGrade = 'strict' | 'repaired' | 'rescued' | 'failed';

export interface QuizEvalRunInput {
  caseId: string;
  topic: string;
  discipline: string;
  /** 本次是否开配图（产品侧读设置里的开关，评测台按 arm 显式设定；省略＝关图，与产品 `DEFAULT_QUIZ_IMAGE=false` 同向） */
  imageOn?: boolean;
  /** 请求配比（题级分母与逐题型请求数都由它算） */
  mix: QuizMix;
  /** 录制代理抓到的模型**原始**输出；传输失败时为空串 */
  rawText: string;
  /** 产品管道返回值（`generateBlendedQuiz` 的 quiz，已按配比裁剪） */
  delivered: QuizPayload | null;
  imageReport: QuizImageReport;
  aiMixReport: QuizMixReport;
  latencyMs: number;
  model: string;
  /** 评测台自己判的传输层失败（429/超时/连不上），与产品上报的 `failure` 是两回事 */
  transportError?: string;
}

export interface QuizQuestionScore {
  type: QuizType;
  /** 该过的体检项全过（注意：`hasExplanation` 是**观察值**、`explanationOk` 才是**判据**，二者对 essay 不同） */
  complete: boolean;
  hasExplanation: boolean;
  /** 是否给了说明（观察值，进报告用；essay 允许没有） */
  explanationOk: boolean;
  answerValid: boolean;
  optionsValid: boolean;
  /** 填空题：题干确实有空位（协议要求空位用 `____`，没空位的「填空题」没法判分） */
  blankOk: boolean;
  /** 解答题：给了完整解答 `solution` */
  solutionOk: boolean;
  svgPresent: boolean;
  stemKey: string;
}

export interface QuizRunScore {
  caseId: string;
  topic: string;
  discipline: string;
  imageOn: boolean;
  model: string;
  latencyMs: number;
  mix: QuizMix;
  grade: QuizParseGrade;
  requestedTotal: number;
  deliveredTotal: number;
  /** 交付≥1 题＝这一组对用户可用 */
  success: boolean;
  /** 按题型出齐（产品的 `matched` 且实收题数＝请求题数） */
  matched: boolean;
  truncated: boolean;
  droppedSvg: number;
  /** 模型在 JSON 里画了几张图；解不出 JSON 时为 null（不进任何分母） */
  svgInRaw: number | null;
  svgDelivered: number;
  questions: QuizQuestionScore[];
  /** 组内重复题数＝题数 − 去重后题数 */
  duplicates: number;
  /** 完美组：一次成型 ∧ 满配 ∧ 字段全齐 ∧ 零丢图 ∧ 零截断 ∧ 零重复 */
  perfect: boolean;
  /** 传输层失败原样留着：汇总要把它与「模型答得差」分开计数 */
  transportError?: string;
  /** 失败真因：优先传输层，其次产品上报的 no-model/parse，最后「解出了但一题不剩」 */
  failure?: string;
}

/** 分子/分母对（百分比只在渲染时算，账上永远留着分母） */
export interface Fraction {
  n: number;
  d: number;
}

export interface QuizTypeStat {
  requested: number;
  delivered: number;
  complete: number;
  answerInvalid: number;
}

export interface QuizEvalSummary {
  runs: number;
  byGrade: Record<QuizParseGrade, number>;
  /** 传输层失败组数（429/超时/连不上）——与「模型答得差」分开记 */
  transportErrors: number;
  /** 成功率＝交付≥1 题的组 / 总组数 */
  success: Fraction;
  /** 一次成型率＝strict 的组 / 总组数 */
  firstParse: Fraction;
  /** 完美出题率＝perfect 的组 / 总组数 */
  perfectRun: Fraction;
  /** 满配率＝出齐的组 / 有交付的组 */
  matched: Fraction;
  /** 题级交付率＝Σ交付题 / Σ请求题 */
  questionDelivery: Fraction;
  /** 字段齐全率＝体检全过的题 / 交付题 */
  completeQuestion: Fraction;
  badAnswer: number;
  duplicates: number;
  truncatedRuns: number;
  droppedSvg: number;
  /** 配图口径三项：只在该 arm 开配图时给出，否则 null（不拿关图的数据冒充开图） */
  image: {
    /** 产图率＝交付带图题 / 交付题 */
    produced: Fraction;
    /** 留图率＝交付带图题 / 模型画出的图（画了却被剥掉的即未留） */
    retained: Fraction;
    /** 出图组占比＝至少交付一张图的组 / 开配图的组 */
    groupsWithImage: Fraction;
  } | null;
  latencyMs: { p50: number; p95: number; max: number } | null;
  byType: Record<QuizType, QuizTypeStat>;
}

const JUDGE_CORRECT = '正确';
const JUDGE_WRONG = '错误';

function isText(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== '';
}

/** 归一化题干：只留汉字与字母数字，用于组内重复判定 */
export function quizStemKey(stem: string): string {
  return stem.toLowerCase().replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '');
}

function optionList(q: QuizQuestion): string[] {
  return Array.isArray(q.options) ? q.options : [];
}

function isChoice(q: QuizQuestion): boolean {
  return q.type === 'single' || q.type === 'multiple' || q.type === 'judge';
}

/**
 * 坏答案判据：下标越界、单选/判断多填、填空一道答案都没给、解答既无要点又无完整解答——
 * 这几种题面看着正常，判分必错，是「题坏了」而不是「题不好」。
 * ★ 解答题（essay）**不判分**（协议原文：「essay 不判分只给参考」），所以 `answer` 与 `solution`
 *   有其一就判得下去。这条是 108 题真机跑出来逼出来的：首版按「必须有 answer」量，
 *   把三条正常给了完整解答的 essay 记成坏答案，虚增了缺陷数。
 */
function answerValid(q: QuizQuestion): boolean {
  const options = optionList(q);
  if (isChoice(q)) {
    if (!Array.isArray(q.answer) || q.answer.length === 0) return false;
    const idx = q.answer as number[];
    if ((q.type === 'single' || q.type === 'judge') && idx.length !== 1) return false;
    return idx.every((i) => Number.isInteger(i) && i >= 0 && i < options.length);
  }
  if (q.type === 'fill') {
    return Array.isArray(q.answer) ? q.answer.length > 0 && q.answer.every(isText) : isText(q.answer);
  }
  return isText(q.answer) || isText(q.solution);
}

function optionsValid(q: QuizQuestion): boolean {
  if (!isChoice(q)) return true;
  const options = optionList(q);
  if (q.type === 'judge') {
    return options.length === 2 && options[0] === JUDGE_CORRECT && options[1] === JUDGE_WRONG;
  }
  return options.length >= 2 && options.every(isText);
}

export function scoreQuizQuestion(q: QuizQuestion): QuizQuestionScore {
  const hasExplanation = isText(q.explanation);
  // ★ essay 不强制说明：产品的 `QUIZ_PROTOCOL` 字段清单里 explanation 是通用字段，
  //   但**它的 essay 示例对象本身就没有 explanation**（只有 answer＋solution）——弱模型照示例办事，
  //   于是 108 题里 15/15 的 essay 全被判「字段不齐」，把两档的完美出题率钉死在 0。
  //   判据必须跟产品实际下发的协议对齐，否则量的是评测台自己的愿望。
  const explanationOk = q.type === 'essay' || hasExplanation;
  const answerOk = answerValid(q);
  const optionsOk = optionsValid(q);
  const blankOk = q.type === 'fill' ? (q.question.match(/_{2,}/g) ?? []).length > 0 : true;
  const solutionOk = q.type === 'essay' ? isText(q.solution) : true;
  return {
    type: q.type,
    complete: explanationOk && answerOk && optionsOk && blankOk && solutionOk,
    hasExplanation,
    explanationOk,
    answerValid: answerOk,
    optionsValid: optionsOk,
    blankOk,
    solutionOk,
    svgPresent: isText(q.svg),
    stemKey: quizStemKey(q.question),
  };
}

/** 原样解 → 修复后解。两种都解不出时 payload=null，此时只能按产品的抢救结果定性 */
function parseRaw(rawText: string): { payload: QuizPayload | null; strict: boolean } {
  const obj = extractQuizJson(rawText);
  if (!obj) return { payload: null, strict: false };
  try {
    return { payload: JSON.parse(obj) as QuizPayload, strict: true };
  } catch {
    // 转义先修，不修好它括号扫描连串边界都错（顺序与产品 parseQuizBlock 同源）
    const repaired = repairJsonBrackets(repairJsonEscapes(obj).text).text;
    try {
      return { payload: JSON.parse(repaired) as QuizPayload, strict: false };
    } catch {
      return { payload: null, strict: false };
    }
  }
}

export function scoreQuizRun(input: QuizEvalRunInput): QuizRunScore {
  const { payload, strict } = parseRaw(input.rawText);
  const grade: QuizParseGrade = strict
    ? 'strict'
    : payload
      ? 'repaired'
      : input.delivered
        ? 'rescued'
        : 'failed';

  const rawQuestions = payload && Array.isArray(payload.questions) ? payload.questions : [];
  const questions = (input.delivered?.questions ?? []).map(scoreQuizQuestion);
  const requestedTotal = mixTotal(input.mix);
  const deliveredTotal = questions.length;
  const duplicates = deliveredTotal - new Set(questions.map((q) => q.stemKey)).size;
  const success = deliveredTotal > 0;
  const matched = input.aiMixReport.matched && deliveredTotal === requestedTotal;
  const perfect =
    grade === 'strict' &&
    matched &&
    !input.imageReport.truncated &&
    input.imageReport.droppedSvg === 0 &&
    duplicates === 0 &&
    questions.every((q) => q.complete);

  return {
    caseId: input.caseId,
    topic: input.topic,
    discipline: input.discipline,
    imageOn: input.imageOn ?? false,
    model: input.model,
    latencyMs: input.latencyMs,
    mix: input.mix,
    grade,
    requestedTotal,
    deliveredTotal,
    success,
    matched,
    truncated: input.imageReport.truncated,
    droppedSvg: input.imageReport.droppedSvg,
    svgInRaw: payload ? rawQuestions.filter((q) => isText(q.svg)).length : null,
    svgDelivered: questions.filter((q) => q.svgPresent).length,
    questions,
    duplicates,
    perfect,
    transportError: input.transportError,
    failure: input.transportError ?? input.imageReport.failure ?? (success ? undefined : 'empty'),
  };
}

const frac = (n: number, d: number): Fraction => ({ n, d });

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] ?? 0;
}

/**
 * 一组（同一 arm 的）打分结果 → 一份指标。
 * ★ 调用方按 arm 分别调用，**两个 arm 的数永不合并成一个**：配图开与关是两种条件，
 *   合并了就成了「留图率里混着关图的组」那种自相矛盾的数。
 */
export function summarizeRuns(scores: QuizRunScore[]): QuizEvalSummary {
  const byGrade: Record<QuizParseGrade, number> = { strict: 0, repaired: 0, rescued: 0, failed: 0 };
  const byType = {} as Record<QuizType, QuizTypeStat>;
  for (const t of QUIZ_TYPES) byType[t] = { requested: 0, delivered: 0, complete: 0, answerInvalid: 0 };

  let success = 0,
    perfect = 0,
    matched = 0,
    deliveredQ = 0,
    requestedQ = 0,
    completeQ = 0,
    badAnswer = 0,
    duplicates = 0,
    truncatedRuns = 0,
    droppedSvg = 0,
    transportErrors = 0,
    svgInRaw = 0,
    svgDelivered = 0,
    deliveredQImg = 0,
    imgRuns = 0,
    groupsWithImage = 0;
  const lat: number[] = [];

  // ★ 防呆（隔壁评测台第一版把 7/13 读成 12/13 的那类坑）：一个 arm 内配图开关必须同源。
  //   混着传的话「留图率」的分母里会掺进关图的组——那种组一张图都不该有，却不是模型画坏了。
  if (scores.some((s) => s.imageOn) && scores.some((s) => !s.imageOn)) {
    throw new Error('summarizeRuns: 同一份指标里混了配图开与关的组——请按 arm 分开调用');
  }

  for (const s of scores) {
    byGrade[s.grade] += 1;
    if (s.transportError) transportErrors += 1;
    if (s.success) success += 1;
    if (s.perfect) perfect += 1;
    if (s.matched) matched += 1;
    if (s.truncated) truncatedRuns += 1;
    duplicates += s.duplicates;
    droppedSvg += s.droppedSvg;
    deliveredQ += s.deliveredTotal;
    requestedQ += s.requestedTotal;
    lat.push(s.latencyMs);
    for (const t of QUIZ_TYPES) byType[t].requested += s.mix[t];
    for (const q of s.questions) {
      const stat = byType[q.type];
      if (stat) {
        stat.delivered += 1;
        if (q.complete) stat.complete += 1;
        if (!q.answerValid) stat.answerInvalid += 1;
      }
      if (q.complete) completeQ += 1;
      if (!q.answerValid) badAnswer += 1;
    }
    if (s.imageOn) {
      imgRuns += 1;
      deliveredQImg += s.deliveredTotal;
      svgDelivered += s.svgDelivered;
      if (s.svgInRaw !== null) svgInRaw += s.svgInRaw;
      if (s.svgDelivered > 0) groupsWithImage += 1;
    }
  }

  const sortedLat = [...lat].sort((a, b) => a - b);
  return {
    runs: scores.length,
    byGrade,
    transportErrors,
    success: frac(success, scores.length),
    firstParse: frac(byGrade.strict, scores.length),
    perfectRun: frac(perfect, scores.length),
    matched: frac(matched, success),
    questionDelivery: frac(deliveredQ, requestedQ),
    completeQuestion: frac(completeQ, deliveredQ),
    badAnswer,
    duplicates,
    truncatedRuns,
    droppedSvg,
    image: imgRuns
      ? {
          produced: frac(svgDelivered, deliveredQImg),
          retained: frac(svgDelivered, svgInRaw),
          groupsWithImage: frac(groupsWithImage, imgRuns),
        }
      : null,
    latencyMs: lat.length
      ? { p50: percentile(sortedLat, 0.5), p95: percentile(sortedLat, 0.95), max: sortedLat[sortedLat.length - 1] ?? 0 }
      : null,
    byType,
  };
}
