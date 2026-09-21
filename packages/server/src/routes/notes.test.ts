/**
 * routes/notes 端到端（supertest，同 quiz-mix.test.ts 手法）。
 * 钉三件事：提交答案自动落草稿（stats/record 一条龙）；心得写接口的校验与 404；
 * 写接口吃同一套跨源闸门。
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuizPayload } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notes-route-test-'));
const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { saveQuiz } = await import('../learning/quiz.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

const quiz: QuizPayload = {
  title: '虚拟语气练习',
  questions: [
    { type: 'single', question: 'Q1', options: ['a', 'b'], answer: [0], explanation: '解析A' },
  ],
};
const quizId = saveQuiz(quiz, 'ai', null);

const record = (body: Record<string, unknown>) =>
  request(app).post('/api/quiz/stats/record').set('Origin', origin).send(body);

const seed = (body: Record<string, unknown>) =>
  request(app).post('/api/scenario/seed').set('Origin', origin).send(body);

afterAll(() => closeDb());

describe('提交答案 → 笔记草稿自动生成', () => {
  it('stats/record 后 GET /api/notes 出现该题的草稿', async () => {
    await record({ quizId, questionIndex: 0, correct: false, answer: [1] }).expect(200);
    const list = await request(app).get('/api/notes').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      quizId,
      questionIndex: 0,
      quizTitle: '虚拟语气练习',
      correct: false,
      hasBody: false,
    });
  });

  it('列表过滤：wrong=1 与 quizId 查询参数生效', async () => {
    await record({ quizId, questionIndex: 0, correct: true, answer: [0] }).expect(200);
    const wrong = await request(app).get('/api/notes?wrong=1').expect(200);
    expect(wrong.body).toHaveLength(0);
    const byQuiz = await request(app).get(`/api/notes?quizId=${quizId}`).expect(200);
    expect(byQuiz.body).toHaveLength(1);
  });

  it('详情含整题快照与作答快照；心得保存后 hasBody=true', async () => {
    const list = await request(app).get('/api/notes').expect(200);
    const id = list.body[0].id as string;
    const detail = await request(app).get(`/api/notes/${id}`).expect(200);
    expect(detail.body.questionData.explanation).toBe('解析A');
    expect(detail.body.myAnswer).toEqual([0]);

    await request(app).put(`/api/notes/${id}`).set('Origin', origin).send({ body: '错因：时态判断' }).expect(200);
    const after = await request(app).get(`/api/notes/${id}`).expect(200);
    expect(after.body.body).toBe('错因：时态判断');
    expect(after.body.hasBody).toBe(true);
  });

  it('写心得：非字符串 body → 400；不存在的笔记 → 404', async () => {
    const list = await request(app).get('/api/notes').expect(200);
    const id = list.body[0].id as string;
    await request(app).put(`/api/notes/${id}`).set('Origin', origin).send({ body: 123 }).expect(400);
    await request(app).put('/api/notes/no-such-id').set('Origin', origin).send({ body: 'x' }).expect(404);
  });

  it('删除笔记 → 详情 404', async () => {
    const list = await request(app).get('/api/notes').expect(200);
    const id = list.body[0].id as string;
    await request(app).delete(`/api/notes/${id}`).set('Origin', origin).expect(200);
    await request(app).get(`/api/notes/${id}`).expect(404);
  });

  it('写操作无 Origin → 403（与其余写接口同一道闸门）', async () => {
    await request(app).put('/api/notes/x').send({ body: 'x' }).expect(403);
    await request(app).delete('/api/notes/x').expect(403);
  });
});

// 回归锁（2026-09-21 闸门 #2 探针实打出的缺陷）：情景套题的 data 是 `{title, tasks}` 没有 questions，
// `quiz.questions[qi]` 曾 TypeError ⇒ 500，而 quiz_stats 已先写库 ⇒ 客户端一重试就重复计数。
describe('情景套题 quizId 走 stats/record（缺陷锁）', () => {
  it('不崩（200）、quiz_stats 照记、笔记不落', async () => {
    const seeded = await seed({
      title: '缺陷锁情景',
      html: '<!doctype html><html><body>demo</body></html>',
      tasks: [{ id: 't1', prompt: '把开关拨到 on', criteria: { kind: 'state', value: 'on' } }],
    }).expect(200);
    const scenarioQuizId = seeded.body.quizId as string;

    await record({ quizId: scenarioQuizId, questionIndex: 0, correct: true }).expect(200);

    // 统计主流程不受影响：情景题每个评分点在 quiz_stats 里就是一道普通题（契约 §0.1）
    const stats = getDb()
      .prepare('SELECT COUNT(*) AS n FROM quiz_stats WHERE quiz_id = ?')
      .get(scenarioQuizId) as { n: number };
    expect(stats.n).toBe(1);

    // 笔记按「题目不存在」静默跳过——情景套题不产刷题草稿
    const notes = await request(app).get(`/api/notes?quizId=${scenarioQuizId}`).expect(200);
    expect(notes.body).toHaveLength(0);
  });
});
