/**
 * learning/srs — SM-2 调度引擎（演进④）：算法与数据解耦的纯函数。
 * memorize 是第一个接入者；错题本/quiz 间隔复习后续复用同一引擎。
 * 参数可配（ADR-6 数据容错：调度结果可重算）。
 */
export interface SrsState {
  easeFactor: number;
  intervalDays: number;
  reviewCount: number;
  lapseCount: number;
}

export interface SrsConfig {
  minEase: number;
  maxEase: number;
  easyBonus: number;
}

export const DEFAULT_SRS_CONFIG: SrsConfig = { minEase: 1.3, maxEase: 2.5, easyBonus: 1.3 };

/** 复习质量（UI 三键映射：没记住=1 / 模糊=3 / 记住了=4 / 轻松=5） */
export type SrsQuality = 1 | 3 | 4 | 5;

/**
 * SM-2 简化版：quality → 新状态。
 * q<3 重置重复次数（interval 回 1 天）；否则 interval: 1 → 3 → prev×ease。
 */
export function schedule(state: SrsState, quality: SrsQuality, config: SrsConfig = DEFAULT_SRS_CONFIG): SrsState {
  const q = quality;
  // SM-2 标准公式：EF' = EF + (0.1 - (5-q)*(0.08 + (5-q)*0.02))
  const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  const easeFactor = Math.min(config.maxEase, Math.max(config.minEase, state.easeFactor + delta));

  if (q < 3) {
    return { easeFactor, intervalDays: 1, reviewCount: 0, lapseCount: state.lapseCount + 1 };
  }
  const reviewCount = state.reviewCount + 1;
  let intervalDays: number;
  if (reviewCount <= 1) intervalDays = 1;
  else if (reviewCount === 2) intervalDays = 3;
  else intervalDays = Math.round(state.intervalDays * easeFactor * (q === 5 ? config.easyBonus : 1));
  return { easeFactor, intervalDays: Math.min(intervalDays, 365), reviewCount, lapseCount: state.lapseCount };
}

/** 下次复习时间（ISO）；interval=0（新词）立即到期。 */
export function nextReviewAt(now: Date, intervalDays: number): string {
  return new Date(now.getTime() + intervalDays * 86_400_000).toISOString();
}

/** 到期判断：next_review_at 为空（新词）或 <= now。 */
export function isDue(nextReviewAt: string | null, now: Date): boolean {
  if (!nextReviewAt) return true;
  return new Date(nextReviewAt).getTime() <= now.getTime();
}
