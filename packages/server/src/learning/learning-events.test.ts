/**
 * learning/learning-events.test — 学习事件流：总线映射（纯函数）+ 落库 + 投影口径。
 * 锁：① 复习/新词条/答题/对话都进同一条时间线，词条按 id 逐条记；② 连续天数"今天还没学不算断"；
 *     ③ 没复习过时记住率是 null 不是 0；④ 只看得到自己的；⑤ 词条时间线最新在前。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { publishEvent } from '../events/bus.js';
import { learningSummary, recordLearningEvent, termTimeline, toLearningEvents, wireLearningEvents } from './learning-events.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-learnev-'));
  openIsolated(dir);
  wireLearningEvents();
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date(2026, 8, 29, 12, 0, 0);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('toLearningEvents（总线 → 学习事件）', () => {
  it('复习带上记住与否和阶段变化', () => {
    expect(toLearningEvents({ type: 'review_completed', termId: 't1', ownerId: 'u', remembered: false, stageBefore: 3, stageAfter: 0 })).toEqual([
      { ownerId: 'u', kind: 'term.reviewed', subjectId: 't1', payload: { remembered: false, stageBefore: 3, stageAfter: 0 } },
    ]);
  });
  it('新词条按 id 逐条记；老发布方只给 count 时记一条带数量的', () => {
    expect(toLearningEvents({ type: 'term_added', count: 2, ownerId: 'u', termIds: ['a', 'b'] }).map((e) => e.subjectId)).toEqual(['a', 'b']);
    expect(toLearningEvents({ type: 'term_added', count: 3, ownerId: 'u' })[0]?.payload).toEqual({ count: 3 });
  });
  it('答题带题型、用时、来源；非学习事件不映射', () => {
    const [e] = toLearningEvents({ type: 'quiz_answered', quizId: 'q', correct: true, ownerId: 'u', qtype: 'fill', ms: 4200, termId: 't', source: 'chat-quiz' });
    expect(e).toMatchObject({ kind: 'quiz.answered', subjectId: 't', payload: { correct: true, qtype: 'fill', ms: 4200 } });
    expect(toLearningEvents({ type: 'obs', kind: 'search', sessionId: null } as never)).toEqual([]);
  });
});

describe('落库与投影', () => {
  it('★ 经总线真打进订阅链落库', () => {
    publishEvent({ type: 'review_completed', termId: 't1', ownerId: 'u1', remembered: true, stageBefore: 0, stageAfter: 1 });
    publishEvent({ type: 'chat_done', sessionId: 's1', ownerId: 'u1' });
    const rows = getDb().prepare('SELECT kind, subject_id FROM learning_event ORDER BY id').all();
    expect(rows).toEqual([{ kind: 'term.reviewed', subject_id: 't1' }, { kind: 'chat.turn', subject_id: 's1' }]);
  });

  it('每日计数、记住率、正确率', () => {
    recordLearningEvent({ ownerId: 'u1', kind: 'term.reviewed', subjectId: 'a', payload: { remembered: true }, at: NOW });
    recordLearningEvent({ ownerId: 'u1', kind: 'term.reviewed', subjectId: 'b', payload: { remembered: false }, at: NOW });
    recordLearningEvent({ ownerId: 'u1', kind: 'quiz.answered', payload: { correct: true }, at: daysAgo(1) });
    recordLearningEvent({ ownerId: 'u1', kind: 'term.added', subjectId: 'c', at: daysAgo(1) });
    const s = learningSummary('u1', 7, NOW);
    expect(s.days).toHaveLength(7);
    expect(s.days[6]).toMatchObject({ reviews: 2, remembered: 1 });
    expect(s.days[5]).toMatchObject({ answers: 1, correct: 1, termsAdded: 1 });
    expect(s.totals.rememberRate).toBe(0.5);
    expect(s.totals.accuracy).toBe(1);
  });

  it('★ 连续天数：今天还没学不算断（从昨天起数）；中间断一天就停', () => {
    for (const n of [1, 2, 3, 5]) recordLearningEvent({ ownerId: 'u1', kind: 'chat.turn', at: daysAgo(n) });
    expect(learningSummary('u1', 14, NOW).streak).toBe(3);
    recordLearningEvent({ ownerId: 'u1', kind: 'chat.turn', at: NOW });
    expect(learningSummary('u1', 14, NOW).streak).toBe(4);
  });

  it('没复习过、没答过题 ⇒ 比率是 null（没考过 ≠ 全忘了）', () => {
    const s = learningSummary('u1', 7, NOW);
    expect(s.totals.rememberRate).toBeNull();
    expect(s.totals.accuracy).toBeNull();
    expect(s.streak).toBe(0);
  });

  it('★ 只看得到自己的；本地模式（null）与登录用户分开', () => {
    recordLearningEvent({ ownerId: 'u2', kind: 'chat.turn', at: NOW });
    recordLearningEvent({ ownerId: null, kind: 'chat.turn', at: NOW });
    expect(learningSummary('u1', 7, NOW).totals.chats).toBe(0);
    expect(learningSummary(null, 7, NOW).totals.chats).toBe(1);
  });

  it('词条时间线：只含这个词条，最新在前', () => {
    recordLearningEvent({ ownerId: 'u1', kind: 'term.added', subjectId: 't', at: daysAgo(2) });
    recordLearningEvent({ ownerId: 'u1', kind: 'term.reviewed', subjectId: 't', payload: { remembered: true }, at: NOW });
    recordLearningEvent({ ownerId: 'u1', kind: 'term.reviewed', subjectId: 'other', at: NOW });
    const items = termTimeline('u1', 't');
    expect(items.map((i) => i.kind)).toEqual(['term.reviewed', 'term.added']);
    expect(items[0]?.payload).toEqual({ remembered: true });
  });
});
