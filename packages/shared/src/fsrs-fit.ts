/**
 * fsrs-fit — 按个人复习记录拟合 FSRS（AI 深度 Step 4）。
 *
 * ★ 拟合什么：不是 FSRS 的 19 个参数（官方优化器要几千条复习才稳，本产品一个用户一年也就几百条），
 *   而是**一个**「稳定性缩放」k：个人有效稳定性 = k × 默认模型算出的稳定性。
 *   k>1 ⇒ 你比默认模型以为的记得牢（间隔拉长）；k<1 ⇒ 忘得快（间隔提前）。一个参数、几十条样本就能稳。
 * ★ 为什么能从日志直接拟：每次复习都记下了**默认模型**当时预测的可提取度 R（`term_review_fsrs.retrievability`）。
 *   FSRS-5 的遗忘曲线 R = (1 + F·t/S)^-0.5 ⇒ F·t/S = R^-2 − 1，于是缩放后的预测
 *   R_k = (1 + (R^-2 − 1)/k)^-0.5 只需要 R 本身，不必回查间隔天数。
 * ★ 防过拟合：MAP 估计，对 ln k 加 N(0, 0.5²) 先验（样本少时贴近 1），k 钳在 [0.25, 4]；少于 30 条不拟合。
 *   只有拟合后的对数损失**确实更低**才采用（否则 k=1）。
 */

export const FSRS_FIT_MIN_N = 30;
export const FSRS_SCALE_MIN = 0.25;
export const FSRS_SCALE_MAX = 4;
const PRIOR_SD = 0.5;

export interface FsrsFitSample {
  /** 默认模型复习时预测的可提取度 */
  r: number;
  recalled: boolean;
}

export interface FsrsFitResult {
  scale: number;
  n: number;
  /** 平均对数损失：默认模型 / 个人化后 */
  lossDefault: number;
  lossFitted: number;
  /** 平均预测记住率：默认 / 个人化后；实际记住率 */
  predictedDefault: number;
  predictedFitted: number;
  actual: number;
}

const clampR = (r: number) => Math.min(Math.max(r, 0.01), 0.99);

/** 用缩放 k 修正一次默认预测 */
export function scaleRetrievability(r: number, k: number): number {
  const x = Math.pow(clampR(r), -2) - 1;
  return Math.pow(1 + x / k, -0.5);
}

function meanLogLoss(samples: readonly FsrsFitSample[], k: number): number {
  let s = 0;
  for (const x of samples) {
    const p = clampR(scaleRetrievability(x.r, k));
    s -= x.recalled ? Math.log(p) : Math.log(1 - p);
  }
  return s / samples.length;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function fitStabilityScale(samples: readonly FsrsFitSample[]): FsrsFitResult | null {
  const valid = samples.filter((x) => Number.isFinite(x.r) && x.r > 0 && x.r <= 1);
  const n = valid.length;
  if (n < FSRS_FIT_MIN_N) return null;
  const penalty = (lnk: number) => (lnk * lnk) / (2 * PRIOR_SD * PRIOR_SD) / n;
  // 在 ln k 上网格搜索（121 点，步长约 0.023）：一维、凸性好，网格比梯度法更不会出意外
  const lo = Math.log(FSRS_SCALE_MIN);
  const hi = Math.log(FSRS_SCALE_MAX);
  let best = 0;
  let bestObj = meanLogLoss(valid, 1);
  for (let i = 0; i <= 120; i += 1) {
    const lnk = lo + ((hi - lo) * i) / 120;
    const obj = meanLogLoss(valid, Math.exp(lnk)) + penalty(lnk);
    if (obj < bestObj - 1e-12) {
      bestObj = obj;
      best = lnk;
    }
  }
  const lossDefault = meanLogLoss(valid, 1);
  let scale = Math.round(Math.exp(best) * 100) / 100;
  let lossFitted = meanLogLoss(valid, scale);
  if (!(lossFitted < lossDefault)) {
    scale = 1;
    lossFitted = lossDefault;
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    scale,
    n,
    lossDefault: r3(lossDefault),
    lossFitted: r3(lossFitted),
    predictedDefault: r3(mean(valid.map((x) => x.r))),
    predictedFitted: r3(mean(valid.map((x) => scaleRetrievability(x.r, scale)))),
    actual: r3(mean(valid.map((x) => (x.recalled ? 1 : 0)))),
  };
}

/** 学习者模型里给人看的那一份 */
export interface FsrsPersonalization {
  scale: number;
  n: number;
  fittedAt: string;
  lossDefault: number;
  lossFitted: number;
}
