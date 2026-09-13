/**
 * learning/notes — 刷题笔记（练环产物沉淀，契约 docs/QUIZ-NOTES-SPEC.md）。
 * 核心语义：**提交答案即落草稿**——upsertNoteFromAnswer 挂在 POST /quiz/stats/record 之后，
 * 每道题一篇（quiz_id + question_index 唯一），题目/解析/题干以快照入库，
 * 重复作答只刷新对错与作答快照，心得 body 永不被自动流程覆盖。
 * 快照不设外键：题库删除后笔记仍自洽可读（用户的学习成果不随题库生命周期）。
 */
import { randomUUID } from 'node:crypto';
import type { QuizNote, QuizNoteSummary, QuizQuestion } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { getQuiz } from './quiz.js';

/** 作答快照的落库形态：single/multiple 存下标数组、fill 存文本、essay 未作答为 null */
export type MyAnswer = number[] | string | null;

/** 心得长度上限：防大 payload 直灌 body（与 express.json 2mb 总闸独立的一层业务闸） */
export const MAX_NOTE_BODY = 20_000;

/**
 * 提交答案后的草稿落库（幂等 upsert）。题库/题目不存在时静默跳过——
 * 统计主流程（recordAnswer）不因笔记失败受影响，调用方也无需感知。
 */
export function upsertNoteFromAnswer(quizId: string, questionIndex: number, correct: boolean, myAnswer?: MyAnswer): void {
  const quiz = getQuiz(quizId);
  const q: QuizQuestion | undefined = quiz?.questions[questionIndex];
  if (!quiz || !q) return;
  getDb()
    .prepare(
      `INSERT INTO quiz_notes (id, quiz_id, question_index, quiz_title, question_data, my_answer, correct)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(quiz_id, question_index) DO UPDATE SET
         my_answer = COALESCE(excluded.my_answer, quiz_notes.my_answer),
         correct = excluded.correct,
         updated_at = datetime('now')`,
    )
    .run(
      randomUUID(),
      quizId,
      questionIndex,
      quiz.title ?? '练习题',
      JSON.stringify(q),
      myAnswer === undefined || myAnswer === null ? null : JSON.stringify(myAnswer),
      correct ? 1 : 0,
    );
}

/** 列表：updated_at 倒序（最近动过的在前）；quizId 过滤本套题、wrong=1 只看错题。 */
export function listNotes(opts: { quizId?: string; wrong?: boolean } = {}): QuizNoteSummary[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.quizId) {
    where.push('quiz_id = ?');
    params.push(opts.quizId);
  }
  if (opts.wrong) {
    where.push('correct = 0');
  }
  const sql = `SELECT id, quiz_id, question_index, quiz_title, question_data, correct, body, created_at, updated_at
    FROM quiz_notes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
  const rows = getDb()
    .prepare(sql)
    .all(...params) as Array<{
    id: string;
    quiz_id: string;
    question_index: number;
    quiz_title: string;
    question_data: string;
    correct: number;
    body: string;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map((r) => {
    const q = parseQuestion(r.question_data);
    return {
      id: r.id,
      quizId: r.quiz_id,
      questionIndex: r.question_index,
      quizTitle: r.quiz_title,
      question: q?.question ?? '',
      correct: r.correct === 1,
      hasBody: r.body.trim().length > 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

/** 详情；不存在返回 null（路由转 404）。 */
export function getNote(id: string): QuizNote | null {
  const r = getDb()
    .prepare(
      'SELECT id, quiz_id, question_index, quiz_title, question_data, my_answer, correct, body, created_at, updated_at FROM quiz_notes WHERE id = ?',
    )
    .get(id) as
    | {
        id: string;
        quiz_id: string;
        question_index: number;
        quiz_title: string;
        question_data: string;
        my_answer: string | null;
        correct: number;
        body: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!r) return null;
  const q = parseQuestion(r.question_data);
  if (!q) return null;
  let myAnswer: MyAnswer = null;
  if (r.my_answer) {
    try {
      myAnswer = JSON.parse(r.my_answer) as MyAnswer;
    } catch {
      myAnswer = null;
    }
  }
  return {
    id: r.id,
    quizId: r.quiz_id,
    questionIndex: r.question_index,
    quizTitle: r.quiz_title,
    question: q.question,
    correct: r.correct === 1,
    hasBody: r.body.trim().length > 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    questionData: q,
    myAnswer,
    body: r.body,
  };
}

/** 只写心得（快照字段不可经此改动——那是自动流程的地盘）。返回 false = 笔记不存在。 */
export function updateNoteBody(id: string, body: string): boolean {
  const res = getDb()
    .prepare(`UPDATE quiz_notes SET body = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(body.slice(0, MAX_NOTE_BODY), id);
  return res.changes > 0;
}

/** 删除单篇笔记（用户显式操作，快照随之丢弃）。 */
export function deleteNote(id: string): void {
  getDb().prepare('DELETE FROM quiz_notes WHERE id = ?').run(id);
}

function parseQuestion(raw: string): QuizQuestion | null {
  try {
    return JSON.parse(raw) as QuizQuestion;
  } catch {
    return null;
  }
}
