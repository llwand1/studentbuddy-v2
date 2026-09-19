/**
 * learning/notes 单测（openIsolated 隔离库，同 quiz.test.ts 手法）。
 * 钉契约核心语义：提交答案即落草稿；快照自洽（不依赖题库存活）；
 * 重复作答只刷新对错与作答快照，心得永不被自动流程覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import type { QuizPayload } from '@sb/shared';
import { saveQuiz, deleteQuiz } from './quiz.js';
import {
  upsertNoteFromAnswer,
  listNotes,
  getNote,
  updateNoteBody,
  deleteNote,
} from './notes.js';

const quiz: QuizPayload = {
  title: '二重积分练习',
  questions: [
    { type: 'single', question: 'Q1 单选', options: ['a', 'b', 'c'], answer: [1], explanation: '解析1' },
    { type: 'fill', question: 'Q2 填空____', answer: ['x'], explanation: '解析2' },
  ],
};

let quizId = '';
const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notes-test-'));

beforeEach(() => {
  openIsolated(dataDir());
  quizId = saveQuiz(quiz, 'ai', null);
});

afterEach(() => closeDb());

describe('upsertNoteFromAnswer（提交答案即落草稿）', () => {
  it('首次作答 → 建草稿，快照含题干/解析/对错', () => {
    upsertNoteFromAnswer(quizId, 0, false, null, [0]);
    const notes = listNotes(null, );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      quizId,
      questionIndex: 0,
      quizTitle: '二重积分练习',
      question: 'Q1 单选',
      correct: false,
      hasBody: false,
    });
    const detail = getNote(notes[0]!.id, null);
    expect(detail?.questionData.explanation).toBe('解析1');
    expect(detail?.myAnswer).toEqual([0]);
    expect(detail?.body).toBe('');
  });

  it('每题一篇：不同题各一篇，同题重复作答不新增', () => {
    upsertNoteFromAnswer(quizId, 0, false, null, [0]);
    upsertNoteFromAnswer(quizId, 1, true, null, 'x');
    upsertNoteFromAnswer(quizId, 0, true, null, [1]);
    expect(listNotes(null, )).toHaveLength(2);
    const again = listNotes(null, { quizId });
    expect(again.filter((n) => n.questionIndex === 0)).toHaveLength(1);
  });

  it('重复作答 → 刷新对错与作答快照，心得保留不被覆盖', () => {
    upsertNoteFromAnswer(quizId, 0, false, null, [0]);
    const id = listNotes(null, )[0]!.id;
    updateNoteBody(id, '这里容易混淆积分次序', null);
    upsertNoteFromAnswer(quizId, 0, true, null, [1]);
    const detail = getNote(id, null);
    expect(detail?.correct).toBe(true);
    expect(detail?.myAnswer).toEqual([1]);
    expect(detail?.body).toBe('这里容易混淆积分次序');
    expect(detail?.hasBody).toBe(true);
  });

  it('再作答未传作答快照 → 保留旧值（COALESCE，不清洗成 null）', () => {
    upsertNoteFromAnswer(quizId, 0, false, null, [0]);
    upsertNoteFromAnswer(quizId, 0, true, null);
    expect(getNote(listNotes(null, )[0]!.id, null)?.myAnswer).toEqual([0]);
  });

  it('题库/题目不存在 → 静默跳过（统计主流程不受影响）', () => {
    upsertNoteFromAnswer('no-such-quiz', 0, true, null, [0]);
    upsertNoteFromAnswer(quizId, 99, true, null, [0]);
    expect(listNotes(null, )).toHaveLength(0);
  });

  it('题库删除 → 笔记快照仍自洽可读（不设外键的决策点）', () => {
    upsertNoteFromAnswer(quizId, 0, false, null, [0]);
    deleteQuiz(quizId, null);
    const detail = getNote(listNotes(null, )[0]!.id, null);
    expect(detail?.quizTitle).toBe('二重积分练习');
    expect(detail?.questionData.explanation).toBe('解析1');
  });
});

describe('列表过滤与增删改', () => {
  it('wrong=1 只看错题；quizId 过滤本套题', () => {
    upsertNoteFromAnswer(quizId, 0, false, null, [0]);
    upsertNoteFromAnswer(quizId, 1, true, null, 'x');
    const other = saveQuiz({ title: '另一套', questions: quiz.questions }, 'ai', null);
    upsertNoteFromAnswer(other, 0, false, null, [0]);
    expect(listNotes(null, { wrong: true })).toHaveLength(2);
    expect(listNotes(null, { quizId })).toHaveLength(2);
    expect(listNotes(null, { quizId, wrong: true })).toHaveLength(1);
  });

  it('updateNoteBody 只写心得；删除后查无此笔记', () => {
    upsertNoteFromAnswer(quizId, 0, false, null, [0]);
    const id = listNotes(null, )[0]!.id;
    expect(updateNoteBody(id, '错因：审题不清', null)).toBe(true);
    expect(getNote(id, null)?.body).toBe('错因：审题不清');
    deleteNote(id, null);
    expect(getNote(id, null)).toBeNull();
    expect(listNotes(null, )).toHaveLength(0);
  });

  it('心得超长截断到上限（业务闸独立于 express.json 总闸）', () => {
    upsertNoteFromAnswer(quizId, 0, false, null, [0]);
    const id = listNotes(null, )[0]!.id;
    const long = '好'.repeat(25_000);
    updateNoteBody(id, long, null);
    expect(getNote(id, null)?.body.length).toBeLessThanOrEqual(20_000);
  });

  it('my_answer 快照损坏 → 容错回 null（数据容错，ADR-6）', () => {
    upsertNoteFromAnswer(quizId, 0, false, null, [0]);
    getDb()
      .prepare('UPDATE quiz_notes SET my_answer = ? WHERE quiz_id = ?')
      .run('{broken', quizId);
    expect(getNote(listNotes(null, )[0]!.id, null)?.myAnswer).toBeNull();
  });
});
