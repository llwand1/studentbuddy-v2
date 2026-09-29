/**
 * learning/fsrs-personal — 个人化 FSRS：从复习日志拟合稳定性缩放 k，存进 `fsrs_user_param`（口径见 `@sb/shared` fsrs-fit.ts）。
 *
 * ★ 何时拟合：每次 `review_completed` 看一眼「上次拟合以来新增了多少条有预测的复习」，满 20 条
 *   （或从没拟合过且总数达标）就派发后台任务 `fsrs.fit`（dedupeKey 按用户，排队中不重复入队）。
 *   拟合是纯 SQL + 一维网格，毫秒级，但仍走任务队列：失败有记录、不拖慢打卡请求。
 * ★ 怎么生效：只在**读**侧——`SELECT_REVIEW_COLS` 带出 `fsrs_scale`，`toReviewTerm` 用 k×S 算间隔与可提取度。
 *   写侧（`fsrsStep`）继续用原始 S：否则 k 会每复习一次就乘一次，越滚越大。
 *   日志里记的 R 也是默认模型的原始预测 ⇒ 下一次拟合的输入口径不随 k 漂移。
 */
import type { FsrsFitSample, FsrsPersonalization } from '@sb/shared';
import { FSRS_FIT_MIN_N, fitStabilityScale } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { subscribeEvents } from '../events/bus.js';
import { dispatchJob, registerJobHandler } from '../jobs/worker.js';

export const FSRS_FIT_JOB = 'fsrs.fit';
/** 距上次拟合新增多少条有预测的复习才重拟 */
export const FSRS_REFIT_EVERY = 20;

/** 近一年、有默认预测的复习样本（同日重复打卡那几条 R 为 NULL，天然被排除） */
export function fitSamples(ownerId: string | null): FsrsFitSample[] {
  const rows = getDb()
    .prepare(
      `SELECT f.retrievability AS r, l.remembered AS rem
         FROM term_review_fsrs f
         JOIN term_review_log l ON l.id = f.log_id
         JOIN term_library t ON t.id = f.term_id
        WHERE t.owner_id = ? AND f.retrievability IS NOT NULL AND f.reviewed_at >= datetime('now', '-365 days')`,
    )
    .all(ownerForWrite(ownerId)) as Array<{ r: number; rem: number }>;
  return rows.map((x) => ({ r: x.r, recalled: x.rem === 1 }));
}

export function personalization(ownerId: string | null): FsrsPersonalization | null {
  const row = getDb()
    .prepare('SELECT scale, n, fitted_at, loss_default, loss_fitted FROM fsrs_user_param WHERE owner_id = ?')
    .get(ownerForWrite(ownerId)) as { scale: number; n: number; fitted_at: string; loss_default: number; loss_fitted: number } | undefined;
  return row ? { scale: row.scale, n: row.n, fittedAt: row.fitted_at, lossDefault: row.loss_default, lossFitted: row.loss_fitted } : null;
}

/** 拟合并落库；样本不足返回 null 且不写（保持 k=1） */
export function fitAndSave(ownerId: string | null): FsrsPersonalization | null {
  const fit = fitStabilityScale(fitSamples(ownerId));
  if (!fit) return null;
  getDb()
    .prepare(
      `INSERT INTO fsrs_user_param (owner_id, scale, n, loss_default, loss_fitted, fitted_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(owner_id) DO UPDATE SET scale = excluded.scale, n = excluded.n, loss_default = excluded.loss_default,
         loss_fitted = excluded.loss_fitted, fitted_at = excluded.fitted_at`,
    )
    .run(ownerForWrite(ownerId), fit.scale, fit.n, fit.lossDefault, fit.lossFitted);
  return personalization(ownerId);
}

/** 该不该重拟：从没拟合过 ⇒ 总样本达标；拟合过 ⇒ 之后新增 ≥ FSRS_REFIT_EVERY */
export function shouldRefit(ownerId: string | null): boolean {
  const owner = ownerForWrite(ownerId);
  const last = personalization(ownerId);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM term_review_fsrs f JOIN term_library t ON t.id = f.term_id
        WHERE t.owner_id = ? AND f.retrievability IS NOT NULL ${last ? 'AND f.reviewed_at > ?' : ''}`,
    )
    .get(...(last ? [owner, last.fittedAt] : [owner])) as { c: number };
  return last ? row.c >= FSRS_REFIT_EVERY : row.c >= FSRS_FIT_MIN_N;
}

let wired = false;

export function wireFsrsFit(): void {
  if (wired) return;
  wired = true;
  registerJobHandler(FSRS_FIT_JOB, '记忆模型个人化', async (_payload, ctx) => {
    fitAndSave(ctx.ownerId);
  });
  subscribeEvents((ev) => {
    if (ev.type !== 'review_completed') return;
    if (!shouldRefit(ev.ownerId)) return;
    dispatchJob({ kind: FSRS_FIT_JOB, ownerId: ev.ownerId, payload: {}, dedupeKey: `fsrs.fit:${ownerForWrite(ev.ownerId)}` });
  });
}
