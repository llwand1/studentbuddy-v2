/**
 * learner — 评分量规（AI 判主观/填空题）与学习者模型的共享契约。
 *
 * ★ 评分：旧的填空是逐字比对（「CO2」对不上「二氧化碳」就进「待核对」），解答题只给参考答案让人
 *   自己对照。现在交给 AI 按量规判：correct / partial / wrong + 0–1 分 + 一句反馈 + **误区诊断**
 *   （错在哪个具体误解，而不只是"错了"）。误区进学习者模型，之后的对话、出题都能看见。
 * ★ 学习者模型不是另一套"画像"——它由事实派生：FSRS 的可提取度给"哪些快忘了"，答题事件给
 *   "哪类题弱"，评分诊断给"误解了什么"。只有误区需要落表（它是 AI 判出来的，别处没有）。
 */

import type { AbilityEstimate } from './adaptive.js';

export type GradeVerdict = 'correct' | 'partial' | 'wrong';

export interface GradeRequest {
  question: string;
  /** 参考答案（填空多空用「；」拼好） */
  reference: string;
  answer: string;
  qtype: 'fill' | 'essay';
  /** 题目挂在哪个词条上（有就记进学习者模型） */
  termId?: string;
  /** 题目所属主题（没有词条时误区按它归类） */
  topic?: string;
}

export interface GradeResult {
  verdict: GradeVerdict;
  /** 0–1 */
  score: number;
  /** 给学生看的一两句话：哪里对、哪里差 */
  feedback: string;
  /** 具体误区（答对时为 null） */
  misconception: string | null;
}

export const GRADE_LIMITS = { question: 2000, reference: 2000, answer: 4000, feedback: 400, misconception: 120 } as const;

const VERDICTS: readonly GradeVerdict[] = ['correct', 'partial', 'wrong'];

/**
 * 校验模型输出。★ 口径：verdict 与 score 必须一致（correct ≥0.8、wrong ≤0.3，partial 在中间），
 *   不一致就按 verdict 把分钳进区间——模型常出现「wrong, score 0.6」这种自相矛盾的输出，
 *   以 verdict 为准是因为界面按它上色，分数只是细化。
 */
export function parseGradeResult(raw: string): GradeResult | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: unknown;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const verdict = r.verdict as GradeVerdict;
  if (!VERDICTS.includes(verdict)) return null;
  const feedback = typeof r.feedback === 'string' ? r.feedback.trim().slice(0, GRADE_LIMITS.feedback) : '';
  if (!feedback) return null;
  let score = typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : verdict === 'correct' ? 1 : verdict === 'wrong' ? 0 : 0.5;
  const [lo, hi] = verdict === 'correct' ? [0.8, 1] : verdict === 'wrong' ? [0, 0.3] : [0.3, 0.8];
  score = Math.round(Math.min(Math.max(score, lo), hi) * 100) / 100;
  const mis = typeof r.misconception === 'string' ? r.misconception.trim().slice(0, GRADE_LIMITS.misconception) : '';
  return { verdict, score, feedback, misconception: verdict === 'correct' || !mis ? null : mis };
}

// ── 学习者模型（`GET /api/learning/model`）──

export interface LearnerWeakTerm {
  id: string;
  term: string;
  /** 当前还记得的概率 0–1 */
  retention: number;
  difficulty: number | null;
}

export interface LearnerMisconception {
  id: string;
  termId: string | null;
  topic: string;
  note: string;
  count: number;
  lastSeen: string;
}

export interface LearnerModel {
  weakTerms: LearnerWeakTerm[];
  misconceptions: LearnerMisconception[];
  /** 各题型近 30 天的正确率 */
  byType: Array<{ qtype: string; answers: number; correct: number }>;
  /**
   * 记忆模型校准：复习时 FSRS 预测「还记得」的平均概率 vs 实际记住比例（近 90 天）。
   * 两者接近 ⇒ 调度可信；实际明显低于预测 ⇒ 默认参数对这个人偏乐观。样本不足为 null。
   */
  calibration: { n: number; predicted: number; actual: number } | null;
  /** 自适应难度：能力估计与建议难度档（样本不足时 level 为 null） */
  ability: AbilityEstimate;
}
