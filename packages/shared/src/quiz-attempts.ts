/**
 * 对话题卡的**作答记录**（契约 `docs/QUIZ-REVIEW-SPEC.md`「作答记录」节，2026-09-30）。
 *
 * ★ 要解决的事：AI 出完题，用户做了一半刷新页面，做题痕迹全没——题卡上连「这组我刷过没有、对了几道」都不留。
 *   现在每答一题就落一行到服务端（复用 `quiz_stats` 表：`quiz_id + question_index` 一行、逐题累计），
 *   题卡重开时把这组的记录读回来：顶部一行「刷过 N 遍 · 客观题正确率 X%」，每题标一枚「上次 ✓／↗／◇」。
 *
 * ★ 这里是**两端共用的纯口径**（服务端落库用它算下一行的值，前端乐观更新也用它算——同一函数，不会漂）：
 *   · `applyQuizAttempt`：一行怎么随一次作答变化（attempts +1；答对 correct +1、streak +1；答错 streak 归零；
 *     待对照（review）只计次数不动 streak——它不是错，是前端判不了）。
 *   · `summarizeQuizAttempts`：整组怎么概括。「刷过几遍」= 各题 attempts 的最大值（作答一半就刷新也算一遍，
 *     因为用户确实动过它）；正确率只算**客观题**（单选/多选/判断/填空——填空字面没对上的 review 按未对计），
 *     解答题没有对错、整个排除；一道客观题都没答过 ⇒ 正确率 `null`（不写 0%，0% 是「全错」，不是「没答」）。
 * ★ 与学习事件流（`POST /api/learning/answers` → `quiz_answered`）是两回事：那边是「学过没有」的活动流水，
 *   这边是「这组题做得怎样」的可回看记录；前者不带题号、不能还原题卡，所以才需要这一份。
 */
import type { QuizQuestion } from './content-blocks.js';
import type { QuizReviewItem } from './quiz-explanation.js';

export type QuizAttemptVerdict = QuizReviewItem['verdict'];

/** 一道题的累计记录（服务端一行 ⇄ 前端一项） */
export interface QuizAttemptRow {
  /** 题在这组里的下标（0 起） */
  index: number;
  attempts: number;
  correct: number;
  /** 连续答对次数；答错归零、待对照不动 */
  streak: number;
  bestStreak: number;
  /** 最近一次作答；服务端老行（2026-09-26 前的题库时代）没有可靠的判定 ⇒ 可能为 null */
  last: { verdict: QuizAttemptVerdict; answer: string; at: string } | null;
}

/** 一次作答 */
export interface QuizAttemptInput {
  questionIndex: number;
  verdict: QuizAttemptVerdict;
  /** 用户作答的文字（选项题是「A. …」，填空是各空以「；」相连，解答题是原文）——只回显，不判分 */
  answer: string;
}

/** 接口回包：`GET /api/quiz/:quizId/attempts` */
export interface QuizAttemptsView {
  quizId: string;
  rows: QuizAttemptRow[];
}

export const QUIZ_ATTEMPT_VERDICTS: readonly QuizAttemptVerdict[] = ['correct', 'wrong', 'review'];
/** 作答文字入库上限（回显用，不是判分材料；解答题原文可能很长，截了不影响任何判定） */
export const QUIZ_ATTEMPT_ANSWER_MAX = 500;

/** 一行随一次作答怎么变（两端同一函数） */
export function applyQuizAttempt(prev: QuizAttemptRow | undefined, input: QuizAttemptInput, at: string): QuizAttemptRow {
  const base: QuizAttemptRow = prev ?? { index: input.questionIndex, attempts: 0, correct: 0, streak: 0, bestStreak: 0, last: null };
  const hit = input.verdict === 'correct';
  const streak = hit ? base.streak + 1 : input.verdict === 'wrong' ? 0 : base.streak;
  return {
    index: input.questionIndex,
    attempts: base.attempts + 1,
    correct: base.correct + (hit ? 1 : 0),
    streak,
    bestStreak: Math.max(base.bestStreak, streak),
    last: { verdict: input.verdict, answer: input.answer.slice(0, QUIZ_ATTEMPT_ANSWER_MAX), at },
  };
}

export interface QuizAttemptSummary {
  /** 刷过几遍 = 各题 attempts 的最大值 */
  rounds: number;
  /** 客观题累计作答 / 答对次数 */
  objectiveAttempts: number;
  objectiveCorrect: number;
  /** 0–1；一道客观题都没答过 ⇒ null */
  accuracy: number | null;
  /** 最近一次作答时间（ISO / SQLite UTC 串原样），没有 ⇒ null */
  lastAt: string | null;
}

/** 解答题没有对错，不进正确率 */
export const isObjectiveType = (t: QuizQuestion['type']): boolean => t !== 'essay';

export function summarizeQuizAttempts(rows: readonly QuizAttemptRow[], types: readonly QuizQuestion['type'][]): QuizAttemptSummary {
  let rounds = 0;
  let objectiveAttempts = 0;
  let objectiveCorrect = 0;
  let lastAt: string | null = null;
  for (const r of rows) {
    rounds = Math.max(rounds, r.attempts);
    const t = types[r.index];
    if (t && isObjectiveType(t)) {
      objectiveAttempts += r.attempts;
      objectiveCorrect += r.correct;
    }
    if (r.last && (!lastAt || r.last.at > lastAt)) lastAt = r.last.at;
  }
  return {
    rounds,
    objectiveAttempts,
    objectiveCorrect,
    accuracy: objectiveAttempts > 0 ? objectiveCorrect / objectiveAttempts : null,
    lastAt,
  };
}

/** 题卡顶部那一行（前端直接念）：「刷过 2 遍 · 客观题正确率 75%（6/8）」；没刷过 ⇒ 空串（不渲染） */
export function quizAttemptLine(s: QuizAttemptSummary): string {
  if (s.rounds === 0) return '';
  const acc = s.accuracy === null ? '' : ` · 客观题正确率 ${Math.round(s.accuracy * 100)}%（${s.objectiveCorrect}/${s.objectiveAttempts}）`;
  return `刷过 ${s.rounds} 遍${acc}`;
}

/** 每题那枚小标的文案：上次 ✓ / ↗ / ◇（与题卡反馈行的三个符号同一套） */
export const QUIZ_ATTEMPT_MARK: Record<QuizAttemptVerdict, string> = { correct: '✓', wrong: '↗', review: '◇' };
