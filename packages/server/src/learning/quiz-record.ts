/**
 * learning/quiz-record —— 逐题统计落库（quiz_stats；析环/薄弱点分析的数据源）。
 * 2026-09-19 M2d-3 从 quiz.ts 拆出（该文件加归属后触 400 行红线，按仓规拆文件不压注释）。
 *
 * ★ quiz_stats 主键是 `(quiz_id, question_index)` 复合——quiz_id 是全局 uuid，不跨用户撞键，
 *   故 M2d-3 只**加列**不重建（契约 §8.2 判据）；`owner_id` 是该题组主人的快照，
 *   读侧一律 `ownerForWrite`（聚合读形状，见 auth/ownership.ts 的判据一句话）。
 */
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

export function recordAnswer(quizId: string, index: number, correct: boolean, ownerId: string | null): void {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const cur = db
    .prepare('SELECT attempts, correct, streak, best_streak FROM quiz_stats WHERE quiz_id = ? AND question_index = ? AND owner_id = ?')
    .get(quizId, index, owner) as { attempts: number; correct: number; streak: number; best_streak: number } | undefined;
  const attempts = (cur?.attempts ?? 0) + 1;
  const correctCount = (cur?.correct ?? 0) + (correct ? 1 : 0);
  const streak = correct ? (cur?.streak ?? 0) + 1 : 0;
  const best = Math.max(cur?.best_streak ?? 0, streak);
  db.prepare(
    `INSERT INTO quiz_stats (quiz_id, question_index, attempts, correct, streak, best_streak, last_answer, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(quiz_id, question_index) DO UPDATE SET attempts=excluded.attempts, correct=excluded.correct,
       streak=excluded.streak, best_streak=excluded.best_streak, last_answer=excluded.last_answer, updated_at=datetime('now')`,
  ).run(quizId, index, attempts, correctCount, streak, best, correct ? 'correct' : 'wrong', owner);
}
