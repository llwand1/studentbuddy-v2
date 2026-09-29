/**
 * adaptive — 自适应难度：由答题历史估学习者能力 θ（Elo 式在线更新的 Rasch/1PL 模型），
 * 再反推"让他答对率落在 70–85%"的题目难度档。
 *
 * ★ 为什么是这个区间：太容易（>85%）学不到东西，太难（<70%）挫败且猜多于想——教育心理学里常说的
 *   "期望困难"区。取中点 77.5% 作目标：P(答对) = σ(θ − b) ⇒ b* = θ − logit(0.775)。
 * ★ 题目难度 b 目前只按题型给先验（判断最易、解答最难）；等每道题都有作答统计后可换成逐题拟合。
 * ★ 样本少于 `ADAPTIVE_MIN_N` 不给建议：几道题的对错决定不了什么，出题提示词保持原样。
 */

/** 各题型的先验难度（logit 标度，0 ＝ 中等） */
export const QTYPE_DIFFICULTY: Readonly<Record<string, number>> = {
  judge: -0.8,
  choice: -0.3,
  match: 0.2,
  multi: 0.3,
  fill: 0.5,
  scene: 0.8,
  short: 1.0,
};

export const ADAPTIVE_TARGET = 0.775;
export const ADAPTIVE_BAND: readonly [number, number] = [0.7, 0.85];
export const ADAPTIVE_MIN_N = 8;
/** Elo 步长：前几题大步收敛，之后稳定在 0.2 */
const kFor = (n: number) => Math.max(0.2, 0.8 / Math.sqrt(n + 1));

export const DIFFICULTY_LEVELS = ['入门', '基础', '标准', '进阶', '挑战'] as const;
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];

export interface AnswerSample {
  qtype?: string | null;
  correct: boolean;
}

export interface AbilityEstimate {
  theta: number;
  n: number;
  /** 最近 20 题的实际正确率 */
  recentAccuracy: number | null;
  /** 建议的题目难度（logit）与档位；样本不足为 null */
  targetB: number | null;
  level: DifficultyLevel | null;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));

export function expectedCorrect(theta: number, b: number): number {
  return sigmoid(theta - b);
}

export function levelFor(b: number): DifficultyLevel {
  if (b < -1) return '入门';
  if (b < -0.25) return '基础';
  if (b < 0.5) return '标准';
  if (b < 1.25) return '进阶';
  return '挑战';
}

/** 按时间顺序（旧 → 新）喂答题记录 */
export function estimateAbility(samples: readonly AnswerSample[]): AbilityEstimate {
  let theta = 0;
  samples.forEach((s, i) => {
    const b = QTYPE_DIFFICULTY[s.qtype ?? ''] ?? 0;
    theta += kFor(i) * ((s.correct ? 1 : 0) - expectedCorrect(theta, b));
  });
  theta = Math.min(Math.max(theta, -4), 4);
  const recent = samples.slice(-20);
  const recentAccuracy = recent.length > 0 ? recent.filter((s) => s.correct).length / recent.length : null;
  if (samples.length < ADAPTIVE_MIN_N) return { theta, n: samples.length, recentAccuracy, targetB: null, level: null };
  const targetB = theta - logit(ADAPTIVE_TARGET);
  return { theta: round2(theta), n: samples.length, recentAccuracy, targetB: round2(targetB), level: levelFor(targetB) };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

const LEVEL_HINT: Record<DifficultyLevel, string> = {
  入门: '以识记与直接判断为主，题干短、干扰项明显，一道题只考一个点',
  基础: '以理解为主：换个说法问定义、简单应用，干扰项有一定迷惑性',
  标准: '理解与应用各半，可以出需要两步推理的题',
  进阶: '以应用与分析为主：多步推理、情境迁移，干扰项针对常见误解',
  挑战: '以分析与综合为主：跨概念综合、反例辨析、开放解答，接近竞赛/高阶考试',
};

/** 出题提示词里的一段；样本不足返回 ''（提示词与旧版逐字一致） */
export function difficultyInstruction(est: AbilityEstimate): string {
  if (!est.level) return '';
  const acc = est.recentAccuracy === null ? '' : `（近期正确率约 ${Math.round(est.recentAccuracy * 100)}%）`;
  return `\n难度要求：这位学生的整体水平${acc}适合「${est.level}」档——${LEVEL_HINT[est.level]}。目标是让他大约答对七到八成：太简单学不到东西，太难只会猜。\n`;
}
