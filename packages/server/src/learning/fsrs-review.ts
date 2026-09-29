/**
 * fsrs-review — 一次复习打卡的 FSRS 推进（读旧状态 → 算新 S/D 与复习时的 R）。
 *
 * ★ 从 `term-review.ts` 拆出来只是为了守住行数红线；取数、事务、事件仍在那边（`markReviewed`），
 *   这里是纯计算 + 一个"起点从哪来"的判断。
 * ★ 起点三种：① 已有 FSRS 状态 ⇒ 直接推进；② 复习过但没有 FSRS 状态（新版前的老词条）⇒
 *   按旧阶段的间隔折算（`fsrsFromLegacy`）再推进；③ 从没复习过 ⇒ `fsrsInit(grade)`。
 */
import {
  fsrsFromLegacy,
  fsrsInit,
  fsrsNext,
  fsrsRetrievability,
  localDayIndex,
  parseSqliteDate,
  reviewIntervalDays,
} from '@sb/shared';
import type { FsrsGrade, FsrsState } from '@sb/shared';

export interface FsrsRowInput {
  review_stage: number;
  last_reviewed_at: string | null;
  fsrs_stability: number | null;
  fsrs_difficulty: number | null;
}

export interface FsrsStep {
  next: FsrsState;
  /** 复习**时**的预测可提取度（首次复习为 null：没有可预测的对象） */
  retrievability: number | null;
}

export function fsrsStep(row: FsrsRowInput, grade: FsrsGrade, now: Date): FsrsStep {
  const last = parseSqliteDate(row.last_reviewed_at);
  if (!last) return { next: fsrsInit(grade), retrievability: null };
  const elapsed = Math.max(localDayIndex(now) - localDayIndex(last), 0);
  const prev: FsrsState =
    row.fsrs_stability && row.fsrs_stability > 0
      ? { stability: row.fsrs_stability, difficulty: row.fsrs_difficulty ?? 5 }
      : fsrsFromLegacy(reviewIntervalDays(row.review_stage));
  return { next: fsrsNext(prev, grade, elapsed), retrievability: fsrsRetrievability(elapsed, prev.stability) };
}
