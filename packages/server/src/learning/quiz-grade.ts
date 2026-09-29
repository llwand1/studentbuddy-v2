/**
 * learning/quiz-grade — 按量规给填空/解答题打分，并诊断误区（契约见 `@sb/shared` learner.ts 头注）。
 *
 * ★ 为什么交给模型：旧的填空是逐字比对（「CO2」≠「二氧化碳」只能进"待核对"），解答题干脆
 *   让学生自己对照参考。这两类恰恰是最能暴露误解的题型，却一条学习信号都没留下。
 * ★ 模型看得到参考答案，它的任务是**判等价 + 找误区**而不是自己解题——这比让它从零解题稳得多，
 *   也不需要盲解那一套（盲解是用来验证"题目本身对不对"的，见 quiz-verify）。
 * ★ 判完这里负责两件事后效：发 `quiz_answered`（进学习事件流）与记/消误区（进学习者模型）。
 *   前端对这类题**不再自己上报**，免得一题记两次。
 */
import type { GradeRequest, GradeResult } from '@sb/shared';
import { GRADE_LIMITS, parseGradeResult } from '@sb/shared';
import { aiJson } from '../ai/gateway.js';
import { publishEvent } from '../events/bus.js';
import { recordMisconception, resolveMisconceptions } from './learner-model.js';

const SYSTEM = `你是严谨而友善的阅卷老师。给你一道题、参考答案和学生的作答，请判断学生答得对不对。
规则：
1. 判的是**意思是否等价**，不是字面：同义说法、等价式、单位换算、中英文名、合理的简写都算对。
2. 解答题按要点给分：要点齐全且无错误 ⇒ correct；抓住了部分要点或有小错 ⇒ partial；核心错误或答非所问 ⇒ wrong。
3. 答错或部分对时，用一句话点出**具体的误区**（学生误以为什么），而不是笼统地说"概念不清"。答对时 misconception 为 null。
4. feedback 写给学生看，一两句，先肯定对的部分，再指出差在哪；不要复述整道题。
只输出一个 JSON 对象：{"verdict":"correct|partial|wrong","score":0到1的小数,"feedback":"…","misconception":"…或 null"}`;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function buildGradeMessages(req: GradeRequest) {
  const kind = req.qtype === 'fill' ? '填空题（多个空用「；」分隔）' : '解答题';
  return [
    { role: 'system' as const, content: SYSTEM },
    {
      role: 'user' as const,
      content: `【题型】${kind}\n【题目】${clip(req.question, GRADE_LIMITS.question)}\n【参考答案】${clip(req.reference, GRADE_LIMITS.reference)}\n【学生作答】${clip(req.answer, GRADE_LIMITS.answer)}`,
    },
  ];
}

export type GradeOutcome = { ok: true; result: GradeResult } | { ok: false; reason: string; error: string };

export async function gradeAnswer(req: GradeRequest, ownerId: string | null, signal?: AbortSignal): Promise<GradeOutcome> {
  const r = await aiJson({
    purpose: 'quiz.grade',
    ownerId,
    messages: buildGradeMessages(req),
    parse: parseGradeResult,
    repairHint: '只输出那一个 JSON 对象，verdict 只能是 correct / partial / wrong。',
    ...(signal ? { signal } : {}),
  });
  if (!r.ok) return { ok: false, reason: r.reason, error: r.error };
  const result = r.value;
  const topic = (req.topic ?? '').slice(0, 80);
  if (result.misconception) {
    recordMisconception(ownerId, { termId: req.termId ?? null, topic, note: result.misconception });
  } else if (result.verdict === 'correct' && req.termId) {
    resolveMisconceptions(ownerId, req.termId);
  }
  publishEvent({
    type: 'quiz_answered',
    quizId: '',
    correct: result.verdict === 'correct',
    ownerId,
    qtype: req.qtype === 'fill' ? 'fill' : 'short',
    ...(req.termId ? { termId: req.termId } : {}),
    source: 'chat-quiz',
  });
  return { ok: true, result };
}
