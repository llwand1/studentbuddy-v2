/**
 * learning/quiz-blend — 出题**来源合流**（契约 `docs/QUIZ-BLEND-SPEC.md` §3.3）。
 *
 * 把仓库里既有的**两条管道**在配比层接起来：
 *   · AI 侧 `generateQuiz`（按题型配比出题）
 *   · 真题侧 `collectQuiz`（检索 → 抓页 → 逐字摘录 → verbatim 锚点锁）
 * 按用户配的「每题型的 AI 道数 / 真题道数」拼成**一个题组**后交给路由落库
 * （`quiz_bank.source = 'blend'`，拍板 D5）。
 *
 * 三条铁律（与上游两条契约同源）：
 * ① **真题侧尽力而为、失败不阻断**（ADR-4）：检索挂 / 抓页挂 / 一道都摘不出，一律记进
 *    `CollectReport` 之后照常返回，AI 题不受影响——真题是**增益**，不是依赖。
 * ② **报缺不补**（老板拍板 D3）：真题没摘够就如实报 `missing[]`，**绝不用 AI 顶替**。
 *    顶替会让「真题」这个词失去意义，而用户从题面上根本分辨不出来。
 * ③ **不静默**（ADR-5）：要了几道、摘到几道、逐页抓取结果、逐题拒绝真因，全部原样透传。
 *
 * ★ 为什么单开文件：`learning/quiz.ts` 实测 **375/400 行**（只剩 25 行），按 AGENTS.md
 *   「再加任何逻辑前必须先开新文件」处理——同 `quiz-search.ts` / `quiz-image.ts` /
 *   `quiz-weak.ts` / `quiz-record.ts` / `quiz-source-mix.ts` 六次先例。
 */
import type {
  AnswerStyle,
  BlendMissing,
  CollectCandidate,
  QuizBlendReport,
  QuizImageReport,
  QuizMix,
  QuizMixKind,
  QuizMixReport,
  QuizPayload,
  QuizQuestion,
  QuizSourceMix,
} from '@sb/shared';
import {
  DEFAULT_QUIZ_SOURCE_MIX,
  MIX_KINDS,
  MIX_KIND_LABELS,
  emptyCollectReport,
  mixTotal,
  sourceMixTotal,
} from '@sb/shared';
import { applyQuizMix, generateQuiz } from './quiz.js';
import { collectQuiz } from './collect.js';

// ★ `BlendMissing` / `QuizBlendReport` 类型定义在 `@sb/shared`（`quiz-source.ts`）——
//   它们是**前后端契约**（服务端填、前端 `mix-report.ts` 念），放服务端会让前端只能自己抄一份。
//   本文件只 import 来用，不重复定义、也不 re-export（re-export 会造出两条等价的导入路径）。

export interface BlendResult {
  /** null ＝ 两侧都没产出（路由据此走既有 502 降级） */
  quiz: QuizPayload | null;
  report: QuizBlendReport;
}

function zeroMix(): QuizMix {
  return { single: 0, multiple: 0, fill: 0, essay: 0, scenario: 0 };
}

function zeroSourceMix(): QuizSourceMix {
  return { ...DEFAULT_QUIZ_SOURCE_MIX };
}

/** 某侧没出题时的空报告（`matched: true`——没要就不存在「没出齐」） */
function emptyMixReport(requested: QuizMix): QuizMixReport {
  return { requested, actual: zeroMix(), matched: true };
}

/**
 * 按题型配额挑真题（**纯函数，可单测**）：只收 `ok:true` 的候选，逐档封顶 `quota[type]`。
 * ★ 顺序即搜集结果的返回顺序（模型摘录顺序），不额外排序——用户的预期是「摘到什么就是什么」。
 * ★ 摘不到的档**就是摘不到**：函数只如实返回 `actual`，缺口由 `blendMissing` 算，
 *   **不做任何 AI 补位**（拍板 D3）。
 */
export function pickByQuota(
  candidates: CollectCandidate[],
  quota: QuizSourceMix,
): { questions: QuizQuestion[]; actual: QuizSourceMix } {
  const actual: QuizSourceMix = zeroSourceMix();
  const questions: QuizQuestion[] = [];
  for (const c of candidates) {
    if (!c.ok) continue;
    const t = c.question.type as QuizMixKind;
    if (!MIX_KINDS.includes(t)) continue;
    if (actual[t] >= quota[t]) continue;
    actual[t] += 1;
    questions.push(c.question);
  }
  return { questions, actual };
}

/** 逐题型缺口（只列没摘够的档，按档位序——与设置页的排列一致，便于对照） */
export function blendMissing(quota: QuizSourceMix, actual: QuizSourceMix): BlendMissing[] {
  return MIX_KINDS.filter((t) => actual[t] < quota[t]).map((t) => ({
    type: t,
    want: quota[t],
    got: actual[t],
    label: MIX_KIND_LABELS[t],
  }));
}

/**
 * 合流出题：AI 侧 + 真题侧各自尽力，拼成一个题组返回（不落库——落库归路由）。
 *
 * `imageReport` 是可选出参，**原样透传给 `generateQuiz`**：配图开关、丢图数、真实失败原因
 * 都记在它上面，路由据此选 502 文案（`no-model` 与 `parse` 是两条不同的行动指引）。
 *
 * AI 侧配比为 0 时整段跳过——省一次本仓最贵的 LLM 调用（纯真题组，契约 §3.3 第 1 条）。
 * 注意 `normalizeQuizMix` 的「全 0 回退默认」已为这个场景开了例外（见 shared 该函数注释）。
 */
export async function generateBlendedQuiz(
  topic: string,
  material: string | undefined,
  aiMix: QuizMix,
  realMix: QuizSourceMix,
  imageReport: QuizImageReport,
  styleArg: AnswerStyle | undefined,
  online: boolean,
  ownerId: string | null,
): Promise<BlendResult> {
  const realRequested = { ...realMix };
  const report: QuizBlendReport = {
    ai: emptyMixReport(aiMix),
    real: { requested: realRequested, actual: zeroSourceMix(), missing: [] },
  };

  // ── ① AI 侧 ──
  let aiQuiz: QuizPayload | null = null;
  if (mixTotal(aiMix) > 0) {
    const raw = await generateQuiz(topic, material, aiMix, imageReport, styleArg, online, ownerId);
    if (raw) {
      // 裁剪仍用既有 `applyQuizMix`（多出裁掉、少出如实记）——真题不参与裁剪（契约 §5 E3）：
      // 真题已按配额筛过，再裁一次就是重复计数。
      const applied = applyQuizMix(raw, aiMix);
      aiQuiz = applied.quiz;
      report.ai = applied.report;
    }
  }

  // ── ② 真题侧 ──
  let realQuestions: QuizQuestion[] = [];
  if (sourceMixTotal(realRequested) > 0) {
    const collectReport = emptyCollectReport();
    report.collect = collectReport;
    try {
      // `quota` 进搜集提示词（契约 §3.3 第 2 条）：不告诉模型要哪几类题，它会按自己的偏好全摘选择题
      const { candidates } = await collectQuiz(topic, collectReport, { ownerId, quota: realRequested });
      const picked = pickByQuota(candidates, realRequested);
      realQuestions = picked.questions;
      report.real.actual = picked.actual;
      report.real.missing = blendMissing(realRequested, picked.actual);
    } catch (err) {
      // 上游 `collectQuiz` 内部已逐层记账，能抛到这里的是更外层的意外——**照样不阻断出题**
      collectReport.failed.push(err instanceof Error ? err.message : String(err));
      report.real.missing = blendMissing(realRequested, report.real.actual);
    }
  }

  // ── ③ 拼装：AI 题在前、真题在后（按来源分组，用户一眼能分辨） ──
  const questions = [...(aiQuiz?.questions ?? []), ...realQuestions];
  if (questions.length === 0) return { quiz: null, report };
  return {
    quiz: { title: aiQuiz?.title ?? `${topic || '综合'}（现场搜集）`, questions },
    report,
  };
}
