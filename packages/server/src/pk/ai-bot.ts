/**
 * pk/ai-bot — PVE 的 AI 对手（2026-09-12 老板拍板三口子：与 P0-2 一体做／
 * AI 与人**完全同口径**答题／人机**对称**出题）。
 *
 * 两条路径，最终都落回 match.ts 的同一套计分：
 * ① 出题：CD 到点（1s ticker 调 `runAiQuiz`）→ AI 自选主题（或建房指定方向）→
 *    复用 `generateQuiz` 管道出一道单选 → `pushGeneratedQuestion`（+1，与人一致）。
 *    失败不计 CD 不扣分，AI_RETRY_DELAY_MS 后重试。
 * ② 答题：人出题成功 → `runAiAnswer` 用**独立** LLM 调用只喂题干+选项
 *    （答案不在上下文里，与人同信息面，无泄漏）→ 解析选项字母 →
 *    `submitAnswer` 判分（+2/−1/超时 −1 全同人）。模型没配/太慢/解析不出 →
 *    不乱猜，交给 ticker 按超时判罚——AI 没有特权。
 */
import { PK_QUIZ_MIX, isAiUserId } from '@sb/shared';
import type { QuizPayload } from '@sb/shared';
import { generateQuiz } from '../learning/quiz.js';
import { routeRole } from '../llm/router.js';
import { pushGeneratedQuestion, scheduleNextAiQuiz, submitAnswer } from './match.js';
import { requireRoomInternal, type PkRoomQuestion, type Room } from './room.js';

/** AI 自选主题池（建房未指定「主题方向」时轮换；覆盖通用知识面） */
const AI_TOPICS = ['科学常识', '世界历史', '地理', '文学名著', '信息技术', '数学基础', '生物', '天文', '语言文字', '生活百科'];

const CHOICE_LETTERS = ['A', 'B', 'C', 'D'];

/** 从模型回答里解析选项：优先首个 A-D 字母，其次 0-3 数字；解析不出返回 null（不乱猜） */
export function parseChoice(raw: string, optionCount: number): number | null {
  const text = raw.trim().toUpperCase();
  for (let i = 0; i < CHOICE_LETTERS.length && i < optionCount; i += 1) {
    const letter = CHOICE_LETTERS[i];
    if (letter && text.includes(letter)) return i;
  }
  const digit = text.match(/[0-9]/);
  if (digit && Number(digit[0]) < optionCount) return Number(digit[0]);
  return null;
}

/** AI 出题（ticker 到点调用；房已被回收/结算时静默退出） */
export async function runAiQuiz(roomId: string): Promise<void> {
  let room: Room;
  try {
    room = requireRoomInternal(roomId);
  } catch {
    return;
  }
  if (room.status !== 'active') return;
  const author = room.players.find((p) => isAiUserId(p.userId));
  const opponent = room.players.find((p) => !isAiUserId(p.userId));
  const now = Date.now();
  if (!author || !opponent) {
    scheduleNextAiQuiz(room, false, now);
    return;
  }
  // P0-7：AI 出题也按「当前轮次主题」——人出题要贴合它，AI 不贴合就成了双重标准。
  // 轮转由 match 侧统一推进（AI 出题成功同样走 advanceTopic），此处只读不写。
  const topic = room.currentTopic || room.aiTopic || AI_TOPICS[room.aiTopicIdx % AI_TOPICS.length] || '通用知识';
  room.aiTopicIdx += 1;

  let payload: QuizPayload | null = null;
  try {
    // 末参 online=true（2026-09-13 老板拍板）：AI 出题也联网，与人出题同口径（match.ts 那侧同样开了）。
    // 失败不阻断：搜不到就退回模型知识，AI 出题失败本就按 CD 不变、可免费重试处理，计分不受影响。
    payload = await generateQuiz(topic, undefined, PK_QUIZ_MIX, undefined, undefined, true);
  } catch {
    payload = null;
  }
  // LLM 在途期间对局可能已结束：结算后的房间不再收题
  if (room.status !== 'active') return;
  const generated = payload?.questions.find((x) => x.type === 'single');
  const ok = pushGeneratedQuestion(room, author.userId, opponent.userId, `主题：${topic}`, generated, Date.now(), topic);
  scheduleNextAiQuiz(room, ok, Date.now());
}

/** AI 答题（人出题成功后调用；独立 LLM 调用，只喂题干+选项） */
export async function runAiAnswer(roomId: string, q: PkRoomQuestion): Promise<void> {
  const target = routeRole('solver');
  // 没配任何模型：AI 不作答，ticker 按超时判罚（与人同规则，不静默造分）
  if (!target) return;
  const prompt = [
    '请做下面这道单选题。只输出正确选项的字母（A/B/C/D），不要任何解释。',
    '',
    `题干：${q.stem}`,
    ...q.options.map((o, i) => `${CHOICE_LETTERS[i]}. ${o}`),
  ].join('\n');
  let acc = '';
  try {
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages: [{ role: 'user', content: prompt }],
    })) {
      acc += chunk.content;
      if (chunk.done) break;
      // 流式超过答题时限即放弃：分数交给服务端超时判罚，AI 不占时限便宜
      if (Date.now() >= q.deadlineAt) return;
    }
  } catch {
    return;
  }
  if (Date.now() >= q.deadlineAt) return;
  const idx = parseChoice(acc, q.options.length);
  if (idx === null) return;
  try {
    submitAnswer(roomId, q.toUserId, q.id, idx, Date.now());
  } catch {
    return; // 房已结束/题已被判：静默放弃，不与 ticker 竞争
  }
}
