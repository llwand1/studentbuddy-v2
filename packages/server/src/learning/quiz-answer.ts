/**
 * learning/quiz-answer — 答题留痕的**域层**（issue #56，2026-09-27）。
 *
 * ★ 为什么单开文件而不在 `routes/quiz.ts` 里写：本仓的规矩是判定逻辑留纯函数／域层，
 *   路由只接线（`routes/quiz.ts` 现在 176 行、离 400 红线还有余量，但判分这段有六条分支，
 *   全塞进路由就再也数不清哪条分支被用例覆盖了）。`/api/scenario/report` 就是这个形状
 *   （路由薄、判分在 `learning/scenario.ts::reportScenario`）。
 *
 * ★★ 这里**不判分**，判分在 `shared/quiz-judge.ts`——前后端共用同一份，
 *   所以「屏幕上打了勾、流水里记了错」这类漂移在结构上不可能发生（那份文件头写了为什么）。
 *   本文件负责的是三件 shared 管不了的事：取答案钥匙、验归属、落流水。
 *
 * ⚠️ **不做的事，按老板 2026-09-27 的拍板列在这儿**（别"顺手补上"）：
 *   · 不记作答内容（`picked`/`text` 判完就丢，落库的只有对错）——留痕是为了统计，不是为了回放；
 *     要回放得另开列，而那一列会把"答错了什么"这种个人信息永久留在库里。
 *   · 不做薄弱点聚合：`quiz-weak` 域层随 `a087e67` 已删，用这张流水重写出题面级聚合是下一批。
 *   · 不给开放题判分：essay 免检沿用 `collect.ts:92` 的既有口径。
 */
import { randomUUID } from 'node:crypto';
import { judgeQuizAnswer, localDayKey, type QuizAnswerInput, type QuizQuestion } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { publishEvent } from '../events/bus.js';
import { ownerFilter } from '../auth/ownership.js';

/**
 * 一次上报的结果。
 *
 * ★ `recorded:false` 与 `ok:false` 是**两件事**，别合并：前者是"这题今天已经记过首答了，
 *   这次不重复记"，它对用户是完全正常的操作（刷新页面重答），必须回 200 且带上复判结果，
 *   否则题卡会显示"上报失败"而用户其实答得好好的。
 * ★ `correct:null` = **不判**（essay／题面缺答案钥匙）。不判就**不落流水**，
 *   折成 `false` 等于往正确率里灌假负样本。
 */
export type QuizReportResult =
  | { ok: false; reason: 'not-found' | 'bad-index' }
  | { ok: true; correct: null; recorded: false }
  | { ok: true; correct: boolean; recorded: boolean };

/**
 * 出卡时登记答案钥匙——由**唯一出卡门面** `announceQuizToSession` 调用，路由不许直接调。
 *
 * ★★ 挂在这一处而不是各调用点：出题有两条入口（REST `/api/quiz/generate` 与聊天模型的
 *   `generate_quiz` 工具），它们本来就共用这个门面，正是为了「两处各写一份就是三口径漂移」
 *   （见 `quiz-announce.ts` 头注）。登记钥匙同理——漏一处就是那一类卡永远答不判。
 *   ⚠️ PK 对战的题**不走这个门面**，所以对战不产生答题流水，这是本批的**已知边界**不是遗漏：
 *   对战有自己的判分与历史表（`pk/match.ts:274`），硬并进来会让两套判分互相打脸。
 *
 * ★ `quizId` 用调用方传进来的**那一个**（即 `blockId.slice('quiz-'.length)` 用的同一个值），
 *   不在这里再 `Date.now()` 一次——原先 blockId 就是因为在两处各算了一次 `Date.now()`
 *   才可能与前端反解出的 id 不符（`quiz-announce.ts::announceQuizToSession` 里那条注释记的就是这次收口）。
 */
export function recordQuizBlock(sessionId: string, quizId: string, questions: QuizQuestion[]): void {
  getDb()
    .prepare(`INSERT INTO quiz_block (quiz_id, session_id, questions) VALUES (?, ?, ?)`)
    .run(quizId, sessionId, JSON.stringify(questions));
}

/**
 * 服务端复判 + 落流水 + 发 `quiz_answered`。
 *
 * ★ 归属走 `sessions` 的 `ownerFilter`（读形状是"按 id 取一行" ⇒ 该用 `ownerFilter` 而不是
 *   `ownerForWrite`，判据见 `auth/ownership.ts:27` 那一段）。
 *   ⇒ `quiz_answer_log` **没有 owner 列**：归属经 `quiz_id → quiz_block.session_id → sessions.user_id`
 *   带出来，与 `term_review_log`（无 owner 列，见 `term-review.ts:34`）同一条判据——
 *   归属只有一处可表达，两处都存迟早分叉。
 * ★ 别人的卡与不存在的卡**回同一个 `not-found`**：区分它们等于给了一张
 *   「猜 quizId 探别人的答题记录」的探针（quizId 是 UUID 所以现实上猜不到，但路由不该假设这层保护）。
 *   与 `/api/scenario/demo/:id`「别人的 demo → 404」同一口径。
 */
export function reportQuizAnswer(
  quizId: string,
  index: number,
  input: QuizAnswerInput,
  ownerId: string | null,
): QuizReportResult {
  const db = getDb();
  const f = ownerFilter(ownerId);
  const row = db
    .prepare(
      `SELECT b.questions AS questions FROM quiz_block b
         JOIN sessions s ON s.id = b.session_id
        WHERE b.quiz_id = ?${f.sql}`,
    )
    .get(quizId, ...f.params) as { questions: string } | undefined;
  if (!row) return { ok: false, reason: 'not-found' };

  let questions: QuizQuestion[];
  try {
    const parsed = JSON.parse(row.questions) as unknown;
    questions = Array.isArray(parsed) ? (parsed as QuizQuestion[]) : [];
  } catch {
    // 钥匙行是 `recordQuizBlock` 自己 `JSON.stringify` 出来的，解不出来只能是库被外部改过。
    // 这里不 500 也不猜"大概答错了"：按不判处理，把这次复判的缺口留给断言去发现。
    return { ok: true, correct: null, recorded: false };
  }

  const q = questions[index];
  if (!q) return { ok: false, reason: 'bad-index' };

  const correct = judgeQuizAnswer(q, input);
  if (correct === null) return { ok: true, correct: null, recorded: false };

  // ★ 首答唯一（`ux_quiz_answer_once`）。用 `ON CONFLICT DO NOTHING` 而不是 catch 唯一约束异常：
  //   后者会把"已记过"和"库锁了/磁盘满了"混成同一种失败，而这两件事对用户的说法完全不同。
  const info = db
    .prepare(
      `INSERT INTO quiz_answer_log (id, quiz_id, question_index, qtype, correct, answered_day, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(quiz_id, question_index) DO NOTHING`,
    )
    .run(randomUUID(), quizId, index, q.type, correct ? 1 : 0, localDayKey(new Date()));

  const recorded = info.changes > 0;
  // ★ 只有**真记上**才发事件：`quiz_answered` 在 `learning/activity.ts:23` 是 XP=3 的一档，
  //   重答再发一遍就是刷新刷分。这也是本仓**第一个** `quiz_answered` 发布者（issue #56 的原始症状）。
  if (recorded) publishEvent({ type: 'quiz_answered', quizId, correct, ownerId });
  return { ok: true, correct, recorded };
}
