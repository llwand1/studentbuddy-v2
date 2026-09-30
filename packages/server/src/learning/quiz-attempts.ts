/**
 * learning/quiz-attempts — 对话题卡的作答记录落库（契约 `docs/QUIZ-REVIEW-SPEC.md`「作答记录」节，2026-09-30）。
 *
 * ★ 复用 `quiz_stats`（v2 建表、v33 加 `owner_id`），**零迁移**。它自 2026-09-26 题库下线起是「有表、零写者」
 *   的活化石（`docs/QUIZ-WEAK-SPEC.md` 墓碑）；本文件让它重新有写者，但语义收窄为「对话题卡一题一行的累计」：
 *   `attempts / correct / streak / best_streak` 四列按 shared `applyQuizAttempt` 的口径走（两端同一函数）；
 *   `last_answer` 从今起存 JSON `{"v":判定,"a":作答文字}`——列是 TEXT 且已无其它读者；老行（题库时代的裸文本）
 *   读回来时判定按 `streak > 0 ⇒ correct、否则 wrong` 推，作答原样回显。
 * ★ 归属：`quiz_*` 是归主表 ⇒ 读写都用 `ownerForWrite`（未登录 = `''` 无主行，只看无主行；
 *   `auth/ownership.ts` 头注讲了为什么这组表不能用「null 就豁免」）。主键是 `(quiz_id, question_index)` 不含
 *   owner：quizId 是每次出题的随机 UUID、只进一个会话，正常不会跨用户撞；真撞了（别人的 quizId 被猜到）
 *   **不覆盖、不报 403**，返回 null 让路由回 404（与会话归属的口径一致：不泄露「这个 id 存在」）。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { applyQuizAttempt, type QuizAttemptInput, type QuizAttemptRow, type QuizAttemptVerdict, QUIZ_ATTEMPT_VERDICTS } from '@sb/shared';

interface StatRow {
  question_index: number;
  attempts: number;
  correct: number;
  streak: number;
  best_streak: number;
  last_answer: string | null;
  updated_at: string;
  owner_id: string;
}

/** 库行 → 契约行；`last_answer` 老格式（裸文本）按 streak 推判定 */
function toRow(r: StatRow): QuizAttemptRow {
  let last: QuizAttemptRow['last'] = null;
  if (r.last_answer !== null) {
    let verdict: QuizAttemptVerdict = r.streak > 0 ? 'correct' : 'wrong';
    let answer = r.last_answer;
    try {
      const o = JSON.parse(r.last_answer) as { v?: unknown; a?: unknown };
      if (o && typeof o === 'object' && (QUIZ_ATTEMPT_VERDICTS as readonly string[]).includes(String(o.v))) {
        verdict = o.v as QuizAttemptVerdict;
        answer = typeof o.a === 'string' ? o.a : '';
      }
    } catch {
      /* 老行：裸文本 */
    }
    last = { verdict, answer, at: r.updated_at };
  }
  return { index: r.question_index, attempts: r.attempts, correct: r.correct, streak: r.streak, bestStreak: r.best_streak, last };
}

const SELECT = `SELECT question_index, attempts, correct, streak, best_streak, last_answer, updated_at, owner_id FROM quiz_stats`;

/** 这组题的全部记录（按题号升序；没有 ⇒ 空数组） */
export function listQuizAttempts(quizId: string, ownerId: string | null): QuizAttemptRow[] {
  const rows = getDb()
    .prepare(`${SELECT} WHERE quiz_id = ? AND owner_id = ? ORDER BY question_index`)
    .all(quizId, ownerForWrite(ownerId)) as StatRow[];
  return rows.map(toRow);
}

/**
 * 记一次作答，返回更新后的那一行；主键被**别人**占着 ⇒ null（路由回 404）。
 * `at` 用 ISO 串写进 `updated_at`（列默认是 SQLite 的 `datetime('now')` 格式，两种都是 UTC、可比较；
 * 前端只拿它显示「最近一次」，不参与任何判定）。
 */
export function recordQuizAttempt(quizId: string, input: QuizAttemptInput, ownerId: string | null, at = new Date().toISOString()): QuizAttemptRow | null {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const existing = db.prepare(`${SELECT} WHERE quiz_id = ? AND question_index = ?`).get(quizId, input.questionIndex) as StatRow | undefined;
  if (existing && existing.owner_id !== owner) return null;
  const next = applyQuizAttempt(existing ? toRow(existing) : undefined, input, at);
  const lastAnswer = JSON.stringify({ v: next.last?.verdict, a: next.last?.answer ?? '' });
  db.prepare(
    `INSERT INTO quiz_stats (quiz_id, question_index, attempts, correct, streak, best_streak, last_answer, updated_at, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(quiz_id, question_index) DO UPDATE SET
       attempts = excluded.attempts, correct = excluded.correct, streak = excluded.streak, best_streak = excluded.best_streak,
       last_answer = excluded.last_answer, updated_at = excluded.updated_at`,
  ).run(quizId, input.questionIndex, next.attempts, next.correct, next.streak, next.bestStreak, lastAnswer, at, owner);
  return next;
}

/** 路由入参闸门：题号 0–199 的整数、判定在三档内、作答是字符串（超长在 shared 里截）；不合法 ⇒ null */
export function parseQuizAttemptInput(body: unknown): QuizAttemptInput | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const idx = typeof b.questionIndex === 'number' ? b.questionIndex : Number.NaN;
  if (!Number.isInteger(idx) || idx < 0 || idx > 199) return null;
  if (!(QUIZ_ATTEMPT_VERDICTS as readonly string[]).includes(String(b.verdict))) return null;
  return { questionIndex: idx, verdict: b.verdict as QuizAttemptVerdict, answer: typeof b.answer === 'string' ? b.answer : '' };
}

/** quizId 只认 UUID / 短 id 字符集（它进 SQL 参数，不拼接；这一层挡的是把整段 JSON 塞进路径的滥用） */
export const isQuizIdLike = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{1,80}$/.test(s);
