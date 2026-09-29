/**
 * learning/learning-events — **学习事件流**（`learning_event`，v46）：写入方 + 投影读口。
 *
 * ★ 为什么在 `daily_activity`（连签/XP）和 `term_review_log`（复习曲线）之外再加一张表：
 *   那两本账各自只存一种"结论"——前者只知道"今天有没有学"，后者只知道"复习记没记住"。
 *   之后要做的记忆模型（FSRS）、学习者画像、成就，需要的是**同一条时间线上的全部原始行为**
 *   （这一题是什么题型、花了多久、是哪个词条、同一天还做了什么）。事件流只追加、不改写，
 *   各种投影都从它现算——加一种玩法不再需要再开一本账。
 * ★ 写入**只经总线**：发布方（复习、词条入库、答题、对话结束）照旧 `publishEvent`，
 *   本文件订阅后落库（与 `activity.ts`／`obs.ts` 同一套分工，发布方对它零感知）。
 */
import { localDayKey } from '@sb/shared';
import type { LearningEventKind, LearningSummary, LearningTimelineItem } from '@sb/shared';
import { subscribeEvents, type DomainEvent } from '../events/bus.js';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

export interface LearningEventInput {
  ownerId: string | null;
  kind: LearningEventKind;
  subjectId?: string | null;
  payload?: Record<string, unknown> | null;
  at?: Date;
}

export function recordLearningEvent(ev: LearningEventInput): void {
  const at = ev.at ?? new Date();
  getDb()
    .prepare('INSERT INTO learning_event (owner_id, kind, subject_id, payload, day) VALUES (?, ?, ?, ?, ?)')
    .run(ownerForWrite(ev.ownerId), ev.kind, ev.subjectId ?? null, ev.payload ? JSON.stringify(ev.payload) : null, localDayKey(at));
}

/** 总线事件 → 学习事件（纯函数，便于单测；不是学习行为的事件返回空数组） */
export function toLearningEvents(ev: DomainEvent): LearningEventInput[] {
  switch (ev.type) {
    case 'review_completed':
      return [{
        ownerId: ev.ownerId, kind: 'term.reviewed', subjectId: ev.termId,
        payload: { remembered: ev.remembered ?? null, stageBefore: ev.stageBefore ?? null, stageAfter: ev.stageAfter ?? null },
      }];
    case 'term_added':
      return ev.termIds && ev.termIds.length > 0
        ? ev.termIds.map((id) => ({ ownerId: ev.ownerId, kind: 'term.added' as const, subjectId: id }))
        : [{ ownerId: ev.ownerId, kind: 'term.added', payload: { count: ev.count } }];
    case 'quiz_answered':
      return [{
        ownerId: ev.ownerId, kind: 'quiz.answered', subjectId: ev.termId ?? null,
        payload: { quizId: ev.quizId, correct: ev.correct, qtype: ev.qtype ?? null, ms: ev.ms ?? null, source: ev.source ?? null },
      }];
    case 'quiz_generated':
      return [{ ownerId: ev.ownerId, kind: 'quiz.generated', subjectId: ev.quizId }];
    case 'chat_done':
      return [{ ownerId: ev.ownerId, kind: 'chat.turn', subjectId: ev.sessionId }];
    default:
      return [];
  }
}

let wired = false;
export function wireLearningEvents(): void {
  if (wired) return;
  wired = true;
  subscribeEvents((ev) => {
    for (const e of toLearningEvents(ev)) recordLearningEvent(e);
  });
}

// ── 投影（读口） ─────────────────────────────────────────────────────────────────

interface EvRow {
  id: number;
  kind: LearningEventKind;
  subject_id: string | null;
  payload: string | null;
  created_at: string;
  day: string;
}

function parse(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 最近 N 天的学习概况：每天各类行为次数、复习记住率、答题正确率、连续学习天数。
 * ★ 连续天数按**本地日历日**从今天往回数（今天还没学不算断：从昨天起数），与 `activity.ts` 的连签同口径。
 */
export function learningSummary(ownerId: string | null, days = 14, now = new Date()): LearningSummary {
  const span = Math.min(Math.max(Math.trunc(days) || 14, 1), 90);
  const from = new Date(now.getTime() - (span - 1) * 86_400_000);
  const rows = getDb()
    .prepare('SELECT id, kind, subject_id, payload, created_at, day FROM learning_event WHERE owner_id = ? AND day >= ? ORDER BY id')
    .all(ownerForWrite(ownerId), localDayKey(from)) as EvRow[];
  const daysOut: LearningSummary['days'] = [];
  for (let i = 0; i < span; i += 1) {
    const key = localDayKey(new Date(from.getTime() + i * 86_400_000));
    daysOut.push({ day: key, reviews: 0, remembered: 0, answers: 0, correct: 0, termsAdded: 0, chats: 0 });
  }
  const at = new Map(daysOut.map((d) => [d.day, d]));
  for (const r of rows) {
    const d = at.get(r.day);
    if (!d) continue;
    const p = parse(r.payload);
    if (r.kind === 'term.reviewed') {
      d.reviews += 1;
      if (p?.remembered === true) d.remembered += 1;
    } else if (r.kind === 'quiz.answered') {
      d.answers += 1;
      if (p?.correct === true) d.correct += 1;
    } else if (r.kind === 'term.added') d.termsAdded += typeof p?.count === 'number' ? p.count : 1;
    else if (r.kind === 'chat.turn') d.chats += 1;
  }
  const active = (d: LearningSummary['days'][number]) => d.reviews + d.answers + d.termsAdded + d.chats > 0;
  let streak = 0;
  for (let i = daysOut.length - 1; i >= 0; i -= 1) {
    const d = daysOut[i]!;
    if (active(d)) streak += 1;
    else if (i === daysOut.length - 1) continue; // 今天还没学：不算断
    else break;
  }
  const sum = (f: (d: LearningSummary['days'][number]) => number) => daysOut.reduce((s, d) => s + f(d), 0);
  const reviews = sum((d) => d.reviews);
  const answers = sum((d) => d.answers);
  return {
    days: daysOut,
    streak,
    totals: {
      reviews,
      rememberRate: reviews > 0 ? sum((d) => d.remembered) / reviews : null,
      answers,
      accuracy: answers > 0 ? sum((d) => d.correct) / answers : null,
      termsAdded: sum((d) => d.termsAdded),
      chats: sum((d) => d.chats),
    },
  };
}

/** 某个词条的完整学习时间线（新增 → 每次复习 → 每次被考到），最新在前 */
export function termTimeline(ownerId: string | null, termId: string, limit = 50): LearningTimelineItem[] {
  const rows = getDb()
    .prepare('SELECT id, kind, subject_id, payload, created_at, day FROM learning_event WHERE owner_id = ? AND subject_id = ? ORDER BY id DESC LIMIT ?')
    .all(ownerForWrite(ownerId), termId, Math.min(Math.max(limit, 1), 200)) as EvRow[];
  return rows.map((r) => ({ kind: r.kind, at: r.created_at, day: r.day, payload: parse(r.payload) }));
}
