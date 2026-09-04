/**
 * routes/quiz-image 端到端（supertest，同 quiz-mix.test.ts 手法）。
 * 钉四件事：默认关；开关读写一致且真落库；非真值一律按关（不静默当开）；写接口吃同一道 Origin 闸门。
 * 另钉「带图题存进题库后回读仍在」——图是存在 JSON 里的，别存得进去读不出来。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuizPayload, QuizQuestion } from '@sb/shared';
import { DEFAULT_QUIZ_IMAGE } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-image-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { loadQuizImage } = await import('../learning/quiz.js');
const request = (await import('supertest')).default;

// 只桩「模型出题」这一段：开关读写、落库、回读全用真实现，端到端才有意义
const quizStub = vi.hoisted(() => ({ result: null as QuizPayload | null }));

vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../learning/quiz.js')>()),
  generateQuiz: async () => quizStub.result,
}));

const origin = 'http://localhost:5173';
const SVG = '<svg viewBox="0 0 100 60"><circle cx="50" cy="30" r="20" fill="none" stroke="#333"/></svg>';

const put = (body: Record<string, unknown>) =>
  request(app).put('/api/settings/quiz-image').set('Origin', origin).send(body);
const generate = () => request(app).post('/api/quiz/generate').set('Origin', origin).send({ topic: 't' });

beforeEach(() => {
  quizStub.result = null;
});

afterAll(() => closeDb());

describe('/api/settings/quiz-image（出题配图开关）', () => {
  it('未配置过 → 回默认关（配图显著拉长输出，默认不背这个包袱）', async () => {
    const res = await request(app).get('/api/settings/quiz-image').expect(200);
    expect(res.body.on).toBe(DEFAULT_QUIZ_IMAGE);
    expect(res.body.on).toBe(false);
  });

  it('PUT 开启 → 落库，GET 回读与服务端直读一致', async () => {
    const r = await put({ on: true }).expect(200);
    expect(r.body.on).toBe(true);
    expect(loadQuizImage()).toBe(true);

    const got = await request(app).get('/api/settings/quiz-image').expect(200);
    expect(got.body.on).toBe(true);
  });

  it('PUT 关闭 → 落库，GET 回读与服务端直读一致', async () => {
    await put({ on: true }).expect(200);
    const r = await put({ on: false }).expect(200);
    expect(r.body.on).toBe(false);
    expect(loadQuizImage()).toBe(false);

    const got = await request(app).get('/api/settings/quiz-image').expect(200);
    expect(got.body.on).toBe(false);
  });

  it('非真值一律按关处理（"true" 字符串 / 1 / 缺字段 都不算开）', async () => {
    expect((await put({ on: 'true' }).expect(200)).body.on).toBe(false);
    expect((await put({ on: 1 }).expect(200)).body.on).toBe(false);
    expect((await put({}).expect(200)).body.on).toBe(false);
  });

  it('写操作无 Origin → 403（与其余设置接口同一道闸门）', async () => {
    await request(app).put('/api/settings/quiz-image').send({ on: true }).expect(403);
  });
});

describe('/api/quiz/generate 配图落库与回读', () => {
  it('带合法 SVG 的题存进题库，回读仍在（图随 JSON 走，别存得进读不出）', async () => {
    quizStub.result = { title: 'T', questions: [{ type: 'essay', question: '画个圆', svg: SVG }] };
    const res = await generate().expect(200);
    expect(res.body.quiz.questions[0].svg).toBe(SVG);

    const bank = await request(app).get(`/api/quiz/bank/${res.body.quizId}`).expect(200);
    expect(bank.body.quiz.questions[0].svg).toBe(SVG);
  });

  it('老题库无 svg 字段 → 回读 undefined，不报错（向后兼容，不做数据迁移）', async () => {
    quizStub.result = { title: '老题', questions: [{ type: 'essay', question: '纯文字题' }] };
    const res = await generate().expect(200);
    expect(res.body.quiz.questions[0].svg).toBeUndefined();
  });

  it('响应带 images 报告，且交付张数是路由自己数的（不靠模型自觉）', async () => {
    quizStub.result = { title: 'T', questions: [{ type: 'essay', question: '画个圆', svg: SVG }] };
    const res = await generate().expect(200);
    expect(res.body.images).toMatchObject({ delivered: 1, droppedSvg: 0, truncated: false });
  });

  it('带图的题被配比裁掉 → delivered 只数最终留下的（报「你拿到几张」而不是「模型画了几张」）', async () => {
    quizStub.result = {
      title: 'T',
      questions: [
        { type: 'essay', question: '圆一', svg: SVG },
        { type: 'essay', question: '圆二', svg: SVG },
      ],
    };
    const res = await request(app)
      .post('/api/quiz/generate')
      .set('Origin', origin)
      .send({ topic: 't', save: false, mix: { single: 0, multiple: 0, fill: 0, essay: 1 } })
      .expect(200);
    expect(res.body.quiz.questions).toHaveLength(1);
    expect(res.body.images.delivered).toBe(1);
  });
});

describe('/api/quiz/generate 失败时把真因分开说（契约 §2.4）', () => {
  it('解析不出来 → 只说模型/解析，不掺配比', async () => {
    quizStub.result = null;
    const res = await generate().expect(502);
    expect(res.body.error).toContain('解析');
    expect(res.body.error).not.toContain('配比');
  });

  it('配比裁空 → 只说配比，不掺解析（v1.0 两个真因写在一句里，照着重试永远调不对）', async () => {
    quizStub.result = {
      title: 'T',
      questions: [{ type: 'judge' as QuizQuestion['type'], question: '模型自造的超纲题型' }],
    };
    const res = await request(app)
      .post('/api/quiz/generate')
      .set('Origin', origin)
      .send({ topic: 't', save: false, mix: { single: 0, multiple: 0, fill: 0, essay: 1 } })
      .expect(502);
    expect(res.body.error).toContain('配比');
    expect(res.body.error).not.toContain('解析');
  });
});
