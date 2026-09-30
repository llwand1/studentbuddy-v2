/**
 * learning/quiz-attempts.test — 作答记录落 `quiz_stats`：写读往返、老行兼容、主键被别人占着不覆盖、入参闸门。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { openIsolated, closeDb, getDb } = await import('../storage/db.js');
const { recordQuizAttempt, listQuizAttempts, parseQuizAttemptInput, isQuizIdLike } = await import('./quiz-attempts.js');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-qa-'));
  openIsolated(dir);
});
afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recordQuizAttempt / listQuizAttempts', () => {
  it('逐题累计：同一题记三次，attempts/correct/streak 按 shared 口径走；读回按题号升序、last 带判定与作答', () => {
    const t1 = '2026-09-30T06:00:00.000Z';
    recordQuizAttempt('q1', { questionIndex: 1, verdict: 'wrong', answer: 'B. 加速度' }, null, t1);
    recordQuizAttempt('q1', { questionIndex: 0, verdict: 'correct', answer: 'A. 速度' }, null, t1);
    const last = recordQuizAttempt('q1', { questionIndex: 1, verdict: 'correct', answer: 'A. 速度' }, null, '2026-09-30T06:05:00.000Z');
    expect(last).toMatchObject({ index: 1, attempts: 2, correct: 1, streak: 1, bestStreak: 1 });
    const rows = listQuizAttempts('q1', null);
    expect(rows.map((r) => r.index)).toEqual([0, 1]);
    expect(rows[1]?.last).toEqual({ verdict: 'correct', answer: 'A. 速度', at: '2026-09-30T06:05:00.000Z' });
    // 别的 quizId 看不到
    expect(listQuizAttempts('q2', null)).toEqual([]);
  });

  it('归属：登录用户只看自己的行；未登录只看无主行；同一 quizId 的主键被别人占着 ⇒ null、不覆盖', () => {
    expect(recordQuizAttempt('q1', { questionIndex: 0, verdict: 'correct', answer: 'x' }, 'alice')).not.toBeNull();
    expect(listQuizAttempts('q1', 'bob')).toEqual([]);
    expect(listQuizAttempts('q1', null)).toEqual([]);
    expect(recordQuizAttempt('q1', { questionIndex: 0, verdict: 'wrong', answer: 'y' }, 'bob')).toBeNull();
    expect(listQuizAttempts('q1', 'alice')[0]).toMatchObject({ attempts: 1, correct: 1, last: { answer: 'x' } });
    // 另一题号是空位，bob 也能写——主键是 (quiz_id, question_index)，不是整组
    expect(recordQuizAttempt('q1', { questionIndex: 1, verdict: 'wrong', answer: 'y' }, 'bob')).not.toBeNull();
    expect(listQuizAttempts('q1', 'bob').map((r) => r.index)).toEqual([1]);
  });

  it('★ 老行兼容：题库时代 last_answer 是裸文本 ⇒ 判定按 streak 推、作答原样回显；再记一笔后变成新格式', () => {
    getDb()
      .prepare(`INSERT INTO quiz_stats (quiz_id, question_index, attempts, correct, streak, best_streak, last_answer, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '')`)
      .run('old', 0, 3, 2, 0, 2, 'C. 位移', '2026-09-20 08:00:00');
    getDb()
      .prepare(`INSERT INTO quiz_stats (quiz_id, question_index, attempts, correct, streak, best_streak, last_answer, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, '')`)
      .run('old', 1, 1, 1, 1, 1, '2026-09-20 08:00:00');
    const rows = listQuizAttempts('old', null);
    expect(rows[0]?.last).toEqual({ verdict: 'wrong', answer: 'C. 位移', at: '2026-09-20 08:00:00' });
    expect(rows[1]?.last).toBeNull();
    const next = recordQuizAttempt('old', { questionIndex: 0, verdict: 'correct', answer: 'A. 速度' }, null, '2026-09-30T06:00:00.000Z');
    expect(next).toMatchObject({ attempts: 4, correct: 3, streak: 1, bestStreak: 2, last: { verdict: 'correct', answer: 'A. 速度' } });
    const raw = getDb().prepare(`SELECT last_answer FROM quiz_stats WHERE quiz_id = 'old' AND question_index = 0`).get() as { last_answer: string };
    expect(JSON.parse(raw.last_answer)).toEqual({ v: 'correct', a: 'A. 速度' });
  });
});

describe('入参闸门', () => {
  it('题号要是 0–199 整数、判定三档内；answer 非字符串按空串；quizId 只认 UUID/短 id 字符集', () => {
    expect(parseQuizAttemptInput({ questionIndex: 3, verdict: 'review', answer: '略' })).toEqual({ questionIndex: 3, verdict: 'review', answer: '略' });
    expect(parseQuizAttemptInput({ questionIndex: 3, verdict: 'correct', answer: 7 })).toEqual({ questionIndex: 3, verdict: 'correct', answer: '' });
    expect(parseQuizAttemptInput({ questionIndex: -1, verdict: 'correct' })).toBeNull();
    expect(parseQuizAttemptInput({ questionIndex: 1.5, verdict: 'correct' })).toBeNull();
    expect(parseQuizAttemptInput({ questionIndex: 200, verdict: 'correct' })).toBeNull();
    expect(parseQuizAttemptInput({ questionIndex: 0, verdict: 'right' })).toBeNull();
    expect(parseQuizAttemptInput(null)).toBeNull();
    expect(isQuizIdLike('4f3c2b1a-0000-4000-8000-000000000001')).toBe(true);
    expect(isQuizIdLike('quiz-legacy')).toBe(true);
    expect(isQuizIdLike('{"a":1}')).toBe(false);
    expect(isQuizIdLike('x'.repeat(81))).toBe(false);
  });
});
