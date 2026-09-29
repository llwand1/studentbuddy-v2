/**
 * learning/quiz-verify — 出题后盲解验算(issue #71)。
 *
 * 干什么:选择类题(single/multiple/judge)入库前,solver 角色**盲解**一遍——
 * 只喂题干+选项、不喂答案(与 pk/ai-bot.ts 的 runAiAnswer 同款无泄漏设计),
 * 解出的答案与出题标注**明确不一致 → 丢弃该题**;其余情形一律放行。
 *
 * 为什么:出题模型标错答案=教错,比没题更糟(model-bench 真机实测:
 * agnes-2.5-flash 40 例出题里 answers 检查 6 例红)。验算是道保险丝。
 *
 * 三条保守纪律(验算失败不得反过来阻断出题,与 ai-bot「不乱猜」同源):
 *  ① solver 角色未绑定 → 整体跳过,零行为变化;
 *  ② solver 超时/异常/答案解析不出 → 该题放行,只记 unresolved;
 *  ③ 只拦「明确不一致」;fill/essay/scenario 无客观口径,本层不碰(记 skipped)。
 * 全部被拦 → 返回 null,走调用方既有 502 降级(与 applyQuizMix 裁到 0 题同口径)。
 *
 * 为什么开新文件:quiz.ts 已 362 行、贴近仓规红线;且验算要接 solver 角色调模型,
 * 与「出题引擎」是两种生命周期(先例:quiz-image.ts / quiz-search.ts 同理拆出)。
 */
import type { QuizPayload, QuizQuestion } from '@sb/shared';
import { stemOf } from '@sb/shared';
import { routeRole } from '../llm/router.js';
import { aiText } from '../ai/gateway.js';

/** 与 UI 选项字母同序;题目选项实际 ≤6 个,留到 F 兜边界 */
const CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

/** 盲解一次的墙钟上限:验算是保险丝不是主路径,拖慢出题不可接受 */
export const VERIFY_TIMEOUT_MS = 20_000;

/** 可验算的题型(答案有客观口径) */
const VERIFIABLE = new Set(['single', 'multiple', 'judge']);

export interface QuizVerifyReport {
  /** 送去盲解的题数(= passed + dropped + unresolved) */
  checked: number;
  /** 盲解与标注一致,放行 */
  passed: number;
  /** 明确不一致,已丢弃 */
  dropped: number;
  /** solver 没答上/解析不出/异常,保守放行 */
  unresolved: number;
  /** 无客观口径的题型(fill/essay/scenario),未验 */
  skipped: number;
}

export function emptyVerifyReport(): QuizVerifyReport {
  return { checked: 0, passed: 0, dropped: 0, unresolved: 0, skipped: 0 };
}

/** 盲解函数:返回模型原文;null=没配模型/超时/异常(调用侧记 unresolved) */
export type SolveFn = (q: QuizQuestion) => Promise<string | null>;

/** 盲解提示词:**只有题干+选项**,答案与解析绝不入内(信息面与人类答题者一致) */
export function buildSolvePrompt(q: QuizQuestion): string {
  const opts = (q.options ?? []).map((o, i) => `${CHOICE_LETTERS[i]}. ${o}`);
  const ask =
    q.type === 'multiple'
      ? '这是多选题,只输出全部正确选项的字母(如 AC),不要任何解释。'
      : '只输出正确选项的字母,不要任何解释。';
  return [ask, '', `题干：${stemOf(q)}`, ...opts].join('\n');
}

/**
 * 从 solver 回复解析答案下标集合。
 * 只认字母(提示词就要的字母;数字歧义大——ai-bot 收 0 基数字,人写 1 基,谁对赌不起):
 * 扫描全部出现过的合法字母去重;单选/判断答出多个不同字母=矛盾 → null(记 unresolved,不猜)。
 */
export function parseAnswerSet(raw: string, optionCount: number, multiple: boolean): number[] | null {
  const seen = new Set<number>();
  for (const ch of raw.toUpperCase()) {
    const idx = (CHOICE_LETTERS as readonly string[]).indexOf(ch);
    if (idx >= 0 && idx < optionCount) seen.add(idx);
  }
  if (seen.size === 0) return null;
  if (!multiple && seen.size > 1) return null;
  return [...seen].sort((a, b) => a - b);
}

/** 下标集合相等(与顺序无关) */
export function sameAnswerSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/**
 * 逐题盲解验算。solve 可注入(单测用假 solver;生产用 defaultSolver)。
 * 返回过滤后的题组;全部被拦 → null(调用方走既有降级,不返回空题组——同 applyQuizMix)。
 */
export async function verifyQuiz(
  quiz: QuizPayload,
  solve: SolveFn,
  report?: QuizVerifyReport,
): Promise<QuizPayload | null> {
  const kept: QuizQuestion[] = [];
  for (const q of quiz.questions) {
    if (!VERIFIABLE.has(q.type) || !Array.isArray(q.options) || !Array.isArray(q.answer)) {
      if (report) report.skipped += 1;
      kept.push(q);
      continue;
    }
    let raw: string | null = null;
    try {
      raw = await solve(q);
    } catch {
      raw = null; // 纪律②:验算自身的失败不惩罚题目
    }
    if (report) report.checked += 1;
    if (raw === null) {
      if (report) report.unresolved += 1;
      kept.push(q);
      continue;
    }
    const got = parseAnswerSet(raw, q.options.length, q.type === 'multiple');
    if (got === null) {
      if (report) report.unresolved += 1;
      kept.push(q);
      continue;
    }
    if (sameAnswerSet(got, q.answer as number[])) {
      if (report) report.passed += 1;
      kept.push(q);
    } else if (report) {
      report.dropped += 1; // 纪律③:只有明确不一致才走到这——丢弃,宁缺勿错
    }
  }
  return kept.length > 0 ? { title: quiz.title, questions: kept } : null;
}

/**
 * 生产盲解器:solver 角色路由(不传 fallback——纪律①:未绑定 solver 就整体跳过,
 * 返回 null 让 quiz.ts 原样放行,零行为变化;刻意不回落 quiz-generator,
 * 同一个模型自己验自己虽仍能抓「标注手滑」,但默认不替用户花这笔冤枉钱)。
 */
export function defaultSolver(ownerId?: string | null): SolveFn | null {
  const target = routeRole('solver', undefined, ownerId ?? null);
  if (!target || !target.model) return null;
  // 超时 = 放弃这题的验算(放行记 unresolved),不打断整组。超时与失败分类交给 AI 网关，每次调用记账
  return async (q) => {
    const r = await aiText({
      purpose: 'quiz.verify',
      ownerId: ownerId ?? null,
      target,
      messages: [{ role: 'user', content: buildSolvePrompt(q) }],
      temperature: 0, // 验算要的是判定不是创意
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    return r.ok ? r.text : null;
  };
}
