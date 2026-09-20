/**
 * learning/review-goal — 自定义复习目标的读写（契约 `docs/EBBINGHAUS-SPEC.md` §10.2）。
 *
 * ★ 为什么单开文件而不并进 `learning/term-review.ts`：后者本批落地时实测 **328/400 行**，
 *   按 AGENTS.md「再加逻辑前必须先开新文件」处理（同 `quiz-image.ts` / `quiz-search.ts` /
 *   `quiz-weak.ts` / `quiz-record.ts` / `quiz-source-mix.ts` 五次先例）。
 * ★ 归属口径与 `loadQuizSourceMix`/`saveQuizSourceMix` **逐字同源**（`app_settings(owner_id, key)`，
 *   M2d v30 归主，主键 `(owner_id, key)`）：漏传 `ownerId` 会让 A 读到/改到 B 的目标，
 *   而**两种都不会让任何测试变红**——只能靠类型与这句注释挡。
 * ★ 归一唯一实现在 `shared/review-goal.ts`（前后端同一份）：本文件只负责「取出来 / 放回去」。
 */
import { SETTING_KEY_REVIEW_GOAL, freshDefaultReviewGoal, normalizeReviewGoal, type ReviewGoal } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

/**
 * 读目标；未配过 / 配置损坏（坏 JSON）都回退**默认（关闭）**。
 * ★ 回退关闭而不是回退某个非 0 默认值：这是 §10.2 的向后兼容承诺——
 *   不设目标 = 什么都没变（队列只放到期词条）。坏 JSON 也走同一条路：
 *   一份读不懂的配置，其可预期行为就是"当作没配"。
 */
export function loadReviewGoal(ownerId: string | null): ReviewGoal {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_REVIEW_GOAL) as { value: string } | undefined;
  if (!row) return freshDefaultReviewGoal();
  try {
    return normalizeReviewGoal(JSON.parse(row.value) as unknown);
  } catch {
    return freshDefaultReviewGoal();
  }
}

/**
 * 存目标；落库前先归一，库里永远是干净的值，且**回写归一结果**（客户端拿到的是服务端实际存的，
 * 不是它自己发上去的——同 `saveSpeechSettings` 取向）。
 */
export function saveReviewGoal(raw: unknown, ownerId: string | null): ReviewGoal {
  const clean = normalizeReviewGoal(raw);
  getDb()
    .prepare(
      // ★ 冲突目标与 `saveQuizSourceMix` 同源：v30 起 `app_settings` 主键是 `(owner_id, key)`
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_REVIEW_GOAL, JSON.stringify(clean));
  return clean;
}
