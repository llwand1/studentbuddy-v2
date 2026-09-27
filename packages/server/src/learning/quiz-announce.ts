/**
 * learning/quiz-announce — 题组**进会话**的唯一出口（出卡门面）。
 *
 * ★ 为什么单开文件（2026-09-23 出题工具化批）：这段「SSE `block` 帧 + 一行 `[QUIZ]` 登记文本」
 *   原先只写在 `routes/quiz.ts` 里。现在聊天模型的 `generate_quiz` 工具要出**同一张卡**，
 *   抄第二份就是三处漂移点（blockId 形状、登记行 content、前端历史还原的解析口径），
 *   而这三处互相不校验、错了只表现为「刷新后卡片变成一坨 JSON」。
 *   与同族的 `announceScenarioToSession`（`learning/scenario.ts`）逐字同形。
 *
 * ★ `quizId` 从 2026-09-23 起随登记行一起落（`{...quiz, quizId}` 顶层键）。情景题从第一天就带这两个
 *   登记键（`quizId` / `demoId`），quiz 补齐后即与它同构。老行没这键＝还原出的卡片无 quizId，
 *   与改前行为一致（不炸、只是不记账）。
 * ⚠️ 2026-09-26 题库整族下线：这一段原本的立项理由（「题卡要判分、要写 `quiz_stats`，前端只能从
 *   `blockId` 反解 quizId ⇒ 历史还原后是张不记账的死卡」）**已随逐题统计一起失效**——
 *   现在作答只由题卡当场判分，没有任何持久统计可记。键本身保留，理由换成注释里那一条
 *   （blockId 形状与 `quiz_generated` 事件都带它，删键属 SSE 契约两侧同改，另批走）。
 * ★★ **2026-09-27 这条理由变了（issue #56）**：同一个 `quizId` 现在是 `quiz_block` 的**主键**，
 *   也就是「前端只许回传 `{quizId,index}`、对错由服务端复判」这条拍板能够成立的全部依托——
 *   没有这把键，服务端拿到作答请求时不知道该跟哪道题比。所以它从"两个附带用途的键"
 *   升级成了判分链路的**必要键**，别按上面那段 09-26 的注释判它可删。
 */
import type { QuizPayload } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { publish } from '../chat/sse-bus.js';
import { recordQuizBlock } from './quiz-answer.js';

/** 登记行的 content（`[QUIZ]…[/QUIZ]`）：payload 顶层 + `quizId` 登记键，前端 `restoreQuizBlock` 读它 */
export function quizRowContent(quiz: QuizPayload, quizId?: string): string {
  return `[QUIZ]${JSON.stringify(quizId ? { ...quiz, quizId } : quiz)}[/QUIZ]`;
}

/**
 * 把一组题送进某个会话：先 `block` 帧（在流的学习者立刻看见题卡），再落一行登记文本（重开会话可还原）。
 * `publish` 无订阅者是安全空转（见 sse-bus），所以本函数不关心订阅状态。
 */
export function announceQuizToSession(sessionId: string, quiz: QuizPayload, quizId?: string): void {
  // blockId 只算一次：原先 `quiz-${quizId ?? Date.now()}` 在同一处写了**两遍**（帧与 payload 各一份），
  // 未落库时两次 Date.now() 可以不同 ⇒ 前端反解出的 quizId 与实际不符。门面收敛后这类错只剩一种。
  const effectiveQuizId = quizId ?? String(Date.now());
  const blockId = `quiz-${effectiveQuizId}`;
  publish(sessionId, {
    type: 'block',
    sessionId,
    blockId,
    done: true,
    payload: { kind: 'quiz', blockId, payload: quiz },
  } satisfies Parameters<typeof publish>[1]);
  getDb()
    .prepare(`INSERT INTO messages (id, session_id, role, content, tokens) VALUES (?, ?, 'assistant', ?, ?)`)
    // ★ 登记行用的是**同一个** `effectiveQuizId`（2026-09-27 issue #56）：原先这里传的是可能为
    //   undefined 的 `quizId` 原值，而 blockId 用的是兜过底的值 ⇒ 未显式给 id 的那批卡，
    //   帧上有 id（当场作答能记账）、刷新后从登记行还原出来的卡没有 id（从此不记账）。
    //   同一个"这道题是哪道题"的问题不该有两种答案——三份产物（帧 / 登记行 / `quiz_block`）现在同源。
    .run(`m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sessionId, quizRowContent(quiz, effectiveQuizId), 0);
  // ★ 答案钥匙登记（issue #56）：与上面那行 `[QUIZ]` 登记文本同物，只是换成主键可查的一行，
  //   让「服务端复判」不必去正则抠消息。挂在这一处而不是各调用点，是因为出题的两条入口
  //   （REST 与聊天工具）本来就只有这一个门面 ⇒ 漏一处的表现是"那一类卡答了不记账"。
  //   ⚠️ 它排在 publish 与 messages 之后、且**不与它们同事务**：这三步里任何一步抛错，
  //   表现是"卡片少了一半"而不是"静默无痕迹"——现网三条 INSERT 都无外层 try，本行不发明第四种坏法。
  recordQuizBlock(sessionId, effectiveQuizId, quiz.questions);
}
