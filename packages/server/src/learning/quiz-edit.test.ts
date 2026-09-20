/**
 * quiz-edit 单测——剔除单题（契约 docs/QUIZ-BLEND-SPEC.md §8 对冲④，2026-09-20）。
 * 库走临时目录（openIsolated），与 quiz.test.ts 同手法；重点锁**统计平移**：
 * quiz_stats 主键是 (quiz_id, question_index)，剔题后 index 前移，统计错位就是数据事故。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import type { QuizPayload } from '@sb/shared';
import { saveQuiz, getQuiz } from './quiz.js';
import { recordAnswer } from './quiz-record.js';
import { removeQuizQuestion } from './quiz-edit.js';

const Q = (question: string): QuizPayload['questions'][number] => ({ type: 'single', question, options: ['a', 'b'], answer: [0] });
const QUIZ: QuizPayload = { title: 'T', questions: [Q('q0'), Q('q1'), Q('q2'), Q('q3')] };

/** 读 quiz_stats 原始行（按 question_index 升序），供平移断言 */
function statsRows(quizId: string): Array<{ question_index: number; attempts: number }> {
  return getDb()
    .prepare('SELECT question_index, attempts FROM quiz_stats WHERE quiz_id = ? ORDER BY question_index')
    .all(quizId) as Array<{ question_index: number; attempts: number }>;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-edit-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
});

describe('removeQuizQuestion — 剔除单题', () => {
  it('剔中间一道：data 少一题、其后统计 index 前移、被剔题的统计随题删除', () => {
    const id = saveQuiz(QUIZ, 'blend', null);
    // 每题都留一条统计（attempts 用题号+1 区分，平移后认得出谁是谁）
    recordAnswer(id, 0, true, null);
    recordAnswer(id, 2, true, null);
    recordAnswer(id, 2, false, null); // q2 attempts=2
    recordAnswer(id, 3, true, null);

    const r = removeQuizQuestion(id, 1, null);
    expect(r).toEqual({ removed: true, remaining: 3 });

    const quiz = getQuiz(id, null);
    expect(quiz?.questions.map((q) => q.question)).toEqual(['q0', 'q2', 'q3']);
    // q0 不动；q2→index1（attempts=2 认得出是原 q2）；q3→index2；原 q1 无统计、原 q2 的行已随题走
    expect(statsRows(id)).toEqual([
      { question_index: 0, attempts: 1 },
      { question_index: 1, attempts: 2 },
      { question_index: 2, attempts: 1 },
    ]);
  });

  it('剔到剩 0 道：整组连统计一起自删（空组没有存在意义）', () => {
    const id = saveQuiz({ title: 'T', questions: [Q('q0')] }, 'ai', null);
    recordAnswer(id, 0, true, null);

    const r = removeQuizQuestion(id, 0, null);
    expect(r).toEqual({ removed: true, remaining: 0 });
    expect(getQuiz(id, null)).toBeNull();
    expect(statsRows(id)).toEqual([]);
  });

  it('下标越界 / 题组不存在 / 情景套组（无 questions 键）→ removed:false，不静默装成功', () => {
    const id = saveQuiz(QUIZ, 'ai', null);
    expect(removeQuizQuestion(id, 4, null).removed).toBe(false);
    expect(removeQuizQuestion(id, -1, null).removed).toBe(false);
    expect(getQuiz(id, null)?.questions).toHaveLength(4); // 越界调用不动数据
    expect(removeQuizQuestion('no-such-id', 0, null)).toEqual({ removed: false, remaining: -1 });
    const scenarioId = saveQuiz({ title: 'S', tasks: [{ id: 't1' }] } as unknown as QuizPayload, 'scenario', null);
    expect(removeQuizQuestion(scenarioId, 0, null).removed).toBe(false);
    expect(getQuiz(scenarioId, null)).not.toBeNull();
  });
});
