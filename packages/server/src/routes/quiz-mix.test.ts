/**
 * routes/quiz-mix 端到端（supertest，同 document.test.ts 手法）。
 * 钉四件事：配比归一化后才落库；写接口吃同一套跨源闸门；出题用「设置页存的」或「本次传的」配比；
 * 模型不数数时（多出/少出）如实反映在响应里，绝不静默补题。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuizMix, QuizPayload, QuizQuestion } from '@sb/shared';
import { DEFAULT_QUIZ_MIX, MAX_QUIZ_TOTAL } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-mix-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

// 只桩「模型出题」这一段：配比读写、裁剪、落库全用真实现，端到端才有意义
const quizStub = vi.hoisted(() => ({
  calls: [] as Array<{ mix: QuizMix | undefined }>,
  result: null as QuizPayload | null,
}));

vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../learning/quiz.js')>()),
  generateQuiz: async (_topic: string, _material?: string, mix?: QuizMix) => {
    quizStub.calls.push({ mix });
    return quizStub.result;
  },
}));

const origin = 'http://localhost:5173';

const payload = (...types: Array<QuizQuestion['type']>): QuizPayload => ({
  title: 'T',
  questions: types.map((t, i) =>
    t === 'single' || t === 'multiple'
      ? { type: t, question: `Q${i}`, options: ['a', 'b'], answer: [0] }
      : { type: t, question: `Q${i}`, answer: t === 'fill' ? ['x'] : '要点' },
  ),
});

const putMix = (mix: unknown) => request(app).put('/api/settings/quiz-mix').set('Origin', origin).send({ mix });
const generate = (body: Record<string, unknown>) => request(app).post('/api/quiz/generate').set('Origin', origin).send(body);

beforeEach(() => {
  quizStub.calls = [];
  quizStub.result = null;
});

afterAll(() => closeDb());

describe('/api/settings/quiz-mix（出题配比设置）', () => {
  it('未配置过 → 回默认配比（2 单选 + 1 填空 + 1 解答）', async () => {
    const res = await request(app).get('/api/settings/quiz-mix').expect(200);
    expect(res.body.mix).toEqual(DEFAULT_QUIZ_MIX);
  });

  it('PUT 先归一化再落库：负数归 0、小数取整、超上限钳住', async () => {
    const put = await putMix({ single: -2, multiple: 2.9, fill: 3, essay: 99 }).expect(200);
    expect(put.body.mix).toEqual({ single: 0, multiple: 2, fill: 3, essay: 10 });

    const got = await request(app).get('/api/settings/quiz-mix').expect(200);
    expect(got.body.mix).toEqual(put.body.mix);
  });

  it('四档全 0 → 落默认（出 0 题没意义，接口也不接受）', async () => {
    const res = await putMix({ single: 0, multiple: 0, fill: 0, essay: 0 }).expect(200);
    expect(res.body.mix).toEqual(DEFAULT_QUIZ_MIX);
  });

  it('总题数不会被堆过上限', async () => {
    const res = await putMix({ single: 10, multiple: 10, fill: 10, essay: 10 }).expect(200);
    const total = (Object.values(res.body.mix) as number[]).reduce((a, b) => a + b, 0);
    expect(total).toBe(MAX_QUIZ_TOTAL);
  });

  it('写操作无 Origin → 403（与其余设置接口同一道闸门）', async () => {
    await request(app).put('/api/settings/quiz-mix').send({ mix: { single: 1 } }).expect(403);
  });
});

describe('/api/quiz/generate 按配比出题', () => {
  it('不传 mix → 用设置页存的全局配比', async () => {
    await putMix({ single: 1, multiple: 0, fill: 0, essay: 0 });
    quizStub.result = payload('single', 'single', 'single');
    await generate({ topic: 't' }).expect(200);
    expect(quizStub.calls[0]?.mix).toEqual({ single: 1, multiple: 0, fill: 0, essay: 0 });
  });

  it('本次传 mix → 覆盖全局设置（不写脏库里的配比）', async () => {
    await putMix({ single: 1, multiple: 0, fill: 0, essay: 0 });
    quizStub.result = payload('fill', 'fill');
    await generate({ topic: 't', mix: { fill: 2 } }).expect(200);
    expect(quizStub.calls[0]?.mix).toEqual({ single: 0, multiple: 0, fill: 2, essay: 0 });

    const got = await request(app).get('/api/settings/quiz-mix').expect(200);
    expect(got.body.mix).toEqual({ single: 1, multiple: 0, fill: 0, essay: 0 });
  });

  it('模型多出 → 裁到配比，响应带实际配比报告', async () => {
    quizStub.result = payload('single', 'single', 'single', 'fill', 'essay');
    const res = await generate({ topic: 't', mix: { single: 2, multiple: 0, fill: 1, essay: 1 } }).expect(200);
    expect(res.body.quiz.questions).toHaveLength(4);
    expect(res.body.mix.matched).toBe(true);
    expect(res.body.mix.actual).toEqual({ single: 2, multiple: 0, fill: 1, essay: 1 });
  });

  it('模型少出 → matched false 且不补题，UI 据此如实告知（不静默）', async () => {
    quizStub.result = payload('single', 'single', 'fill');
    const res = await generate({ topic: 't', mix: { single: 2, multiple: 0, fill: 1, essay: 1 } }).expect(200);
    expect(res.body.quiz.questions).toHaveLength(3);
    expect(res.body.mix.matched).toBe(false);
    expect(res.body.mix.actual.essay).toBe(0);
    expect(res.body.mix.requested.essay).toBe(1);
  });

  it('模型出的题型全不在配比内 → 502 并给可重试文案（不返回空题组）', async () => {
    quizStub.result = payload('judge' as QuizQuestion['type']);
    const res = await generate({ topic: 't', mix: { single: 1 } });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('可重试');
  });
});
