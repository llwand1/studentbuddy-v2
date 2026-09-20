/**
 * learning/quiz-edit — 题库题组的**事后编辑**：从题组里剔除一道题（契约 `docs/QUIZ-BLEND-SPEC.md` §8 对冲④）。
 *
 * ★ 为什么必须有这个入口：D1 拍板「真题自动进组」拆掉了既有质量对冲（RESOURCE-SPEC §2 硬约束①
 *   的「预览必经人工确认」），verbatim 锚点锁成为唯一防线。防线不是百分之百——漏进来的错题要能
 *   **事后剔除**（「事后可恢复」而非事前拦截），否则用户只能删整组（AI 题陪葬）。
 *
 * ★ 为什么单开文件：`learning/quiz.ts` 375/400 行，按 AGENTS.md「再加任何逻辑前必须先开新文件」
 *   处理——同 `quiz-source-mix.ts` / `quiz-blend.ts` 先例。
 *
 * ★ 为什么是「重写 data + 统计平移」而不是 SQL 删行：题组是**一个 JSON 整体**落 `quiz_bank.data`
 *   （saveQuiz 一次写入），没有逐题行表可删。而 `quiz_stats` 主键是 `(quiz_id, question_index)`
 *   复合键——剔除第 i 题后其后所有题的 index 前移，**旧统计若不平移就会错位到别的题上**，
 *   故同事务里先平移 `question_index > i` 的行、再删第 i 题的统计（统计随题走）。
 */
import type { QuizPayload } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

export interface RemoveQuestionResult {
  /** false ＝ 题组不存在 / data 损坏 / 下标越界（路由据此回 404，不静默装成功） */
  removed: boolean;
  /** 剔除后组内还剩几道；removed=false 且题组不存在时为 -1 */
  remaining: number;
}

/** 剔除题组 `id` 里下标 `index`（0 起）的那道题；剔到剩 0 道时整组自删（与 deleteQuiz 同口径） */
export function removeQuizQuestion(id: string, index: number, ownerId: string | null): RemoveQuestionResult {
  const owner = ownerForWrite(ownerId);
  const row = getDb()
    .prepare('SELECT data FROM quiz_bank WHERE id = ? AND owner_id = ?')
    .get(id, owner) as { data: string } | undefined;
  if (!row) return { removed: false, remaining: -1 };
  let payload: QuizPayload;
  try {
    payload = JSON.parse(row.data) as QuizPayload;
  } catch {
    return { removed: false, remaining: -1 };
  }
  const questions = payload.questions ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= questions.length) {
    return { removed: false, remaining: questions.length };
  }
  const remainingQuestions = questions.filter((_, i) => i !== index);
  getDb()
    .transaction(() => {
      if (remainingQuestions.length === 0) {
        // 剔掉最后一道＝空组没有存在意义：整组连统计一起删，与「删整组」殊途同归
        getDb().prepare('DELETE FROM quiz_bank WHERE id = ? AND owner_id = ?').run(id, owner);
        getDb().prepare('DELETE FROM quiz_stats WHERE quiz_id = ? AND owner_id = ?').run(id, owner);
        return;
      }
      getDb()
        .prepare('UPDATE quiz_bank SET data = ? WHERE id = ? AND owner_id = ?')
        .run(JSON.stringify({ ...payload, questions: remainingQuestions }), id, owner);
      // 统计随题走：**先删**被剔题自己的统计行，**再**把其后各题 index 前移一位。
      // ★ 顺序不能反：若先平移，「index 处那行属于被剔题」的前提就没了——被剔题本没有统计时
      //   （一次都没练过），后一题的统计会平移落到 index 处、再被 DELETE 误删（单测抓过这个错序）。
      getDb()
        .prepare('DELETE FROM quiz_stats WHERE quiz_id = ? AND owner_id = ? AND question_index = ?')
        .run(id, owner, index);
      getDb()
        .prepare(
          'UPDATE quiz_stats SET question_index = question_index - 1 WHERE quiz_id = ? AND owner_id = ? AND question_index > ?',
        )
        .run(id, owner, index);
    })();
  return { removed: true, remaining: remainingQuestions.length };
}
