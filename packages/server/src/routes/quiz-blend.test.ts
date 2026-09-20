/**
 * routes/quiz-blend — 出题来源合流的端到端（supertest，同 quiz-search.test.ts 手法）。
 *
 * 钉四件事（契约 `docs/QUIZ-BLEND-SPEC.md` §7 T3）：
 * ① **向后兼容**：不传 `sourceMix` 且设置里真题全 0 时，行为与改动前逐字一致（不发起搜集、来源仍 `ai`）；
 * ② `sourceMix` 透传 → 搜集**带题型配额**发起（不带配额，模型会全摘选择题）；
 * ③ 合流报告原样回响应，缺额如实（报缺不补）；
 * ④ 设置端点的**联合钳位**：AI 侧 + 真题侧 ≤ 20。
 *
 * 上游一律打桩（`generateQuiz` / `collectQuiz`），**不碰真模型真网络**；库走临时 `SB_DATA_DIR`。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CollectCandidate, CollectReport, QuizPayload, QuizSourceMix } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-blend-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

const stub = vi.hoisted(() => ({
  aiQuiz: null as QuizPayload | null,
  candidates: [] as CollectCandidate[],
  collectCalls: [] as unknown[][],
}));

vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../learning/quiz.js')>()),
  generateQuiz: async () => stub.aiQuiz,
}));

vi.mock('../learning/collect.js', () => ({
  collectQuiz: async (topic: string, report: CollectReport, opts?: unknown) => {
    stub.collectCalls.push([topic, report, opts]);
    return { report, candidates: stub.candidates };
  },
}));

const origin = 'http://localhost:5173';
const AI_QUIZ: QuizPayload = {
  title: 'AI 题组',
  questions: [
    { type: 'single', question: 'AI-s0', options: ['A', 'B'], answer: [0] },
    { type: 'single', question: 'AI-s1', options: ['A', 'B'], answer: [0] },
    { type: 'fill', question: 'AI-f0', answer: ['x'] },
    { type: 'essay', question: 'AI-e0', answer: 'a' },
  ],
};
const collected = (n: number): CollectCandidate[] =>
  Array.from({ length: n }, (_, i) => ({
    question: {
      type: 'single' as const,
      question: `真题${i}`,
      options: ['A', 'B'],
      answer: [0],
      source: { kind: 'collect' as const, title: '某题库页', url: `https://example.com/${i}` },
    },
    ok: true,
  }));

const generate = (body: Record<string, unknown>) =>
  request(app).post('/api/quiz/generate').set('Origin', origin).send(body);
const putSourceMix = (mix: Partial<QuizSourceMix>) =>
  request(app).put('/api/settings/quiz-source-mix').set('Origin', origin).send({ mix });
const putAiMix = (mix: Record<string, number>) =>
  request(app).put('/api/settings/quiz-mix').set('Origin', origin).send({ mix });

/**
 * 按 quizId 取题库行。
 * ★ 刻意**不用** `bank[0]`：`quiz_bank.created_at` 只到秒（`datetime('now')`），
 *   本文件多个用例在同一秒内落库 ⇒ `ORDER BY created_at DESC` 的并列项**顺序不稳定**，
 *   拿第一条会读到别的用例的行（实测踩到：期望 'blend' 实得 'ai'）。
 */
const bankRowOf = async (quizId: string): Promise<{ id: string; source: string } | undefined> => {
  const bank = await request(app).get('/api/quiz/bank').set('Origin', origin).expect(200);
  return (bank.body as Array<{ id: string; source: string }>).find((b) => b.id === quizId);
};

beforeEach(async () => {
  stub.aiQuiz = AI_QUIZ;
  stub.candidates = [];
  stub.collectCalls = [];
  // 每个用例都从干净配比起步（服务端按 owner 存，未登录＝无主行）
  await putAiMix({ single: 2, multiple: 0, fill: 1, essay: 1, scenario: 0 });
  await putSourceMix({});
});

afterAll(() => closeDb());

describe('★ 向后兼容：不配真题时与改动前逐字一致', () => {
  it('不传 sourceMix 且设置里真题全 0 → 一次搜集都不发起', async () => {
    const r = await generate({ topic: 't' }).expect(200);
    expect(stub.collectCalls).toHaveLength(0);
    expect(r.body.blend?.collect).toBeUndefined();
  });

  it('落库来源仍是 ai（老行为不变，题库徽标不会无端变成"混合"）', async () => {
    const r = await generate({ topic: 't' }).expect(200);
    const row = await bankRowOf(r.body.quizId);
    expect(row?.source).toBe('ai');
  });

  it('响应仍带 mix（AI 侧报告）——前端既有 shortfallText 零改动', async () => {
    const r = await generate({ topic: 't' }).expect(200);
    expect(r.body.mix).toMatchObject({ matched: true });
  });
});

describe('sourceMix 透传与合流落库（契约 §3.3／§7 T3）', () => {
  it('传 sourceMix → 搜集发起，且**带题型配额**进提示词参数', async () => {
    stub.candidates = collected(1);
    await generate({ topic: '二次函数', sourceMix: { single: 2 } }).expect(200);
    expect(stub.collectCalls).toHaveLength(1);
    const opts = stub.collectCalls[0]?.[2] as { quota?: QuizSourceMix } | undefined;
    expect(opts?.quota).toMatchObject({ single: 2 });
    // 搜集词用的是本次主题
    expect(stub.collectCalls[0]?.[0]).toBe('二次函数');
  });

  it('真题摘到 → 题组含真题（排在 AI 题之后）且落库来源为 blend', async () => {
    stub.candidates = collected(2);
    const r = await generate({ topic: 't', sourceMix: { single: 2 } }).expect(200);
    expect(r.body.quiz.questions.map((q: { question: string }) => q.question)).toEqual([
      'AI-s0', 'AI-s1', 'AI-f0', 'AI-e0', '真题0', '真题1',
    ]);
    const row = await bankRowOf(r.body.quizId);
    expect(row?.source).toBe('blend');
  });

  it('★ 配了真题但一道没摘到 → 来源仍写 ai（按**实际内容**判，不让徽标说谎）', async () => {
    stub.candidates = [];
    const r = await generate({ topic: 't', sourceMix: { single: 3 } }).expect(200);
    expect(r.body.quiz.questions).toHaveLength(4);
    const row = await bankRowOf(r.body.quizId);
    expect(row?.source).toBe('ai');
  });

  it('★ 缺额如实回响应（报缺不补）：要 3 摘到 1 → missing 记 2', async () => {
    stub.candidates = collected(1);
    const r = await generate({ topic: 't', sourceMix: { single: 3 } }).expect(200);
    expect(r.body.blend.real.requested.single).toBe(3);
    expect(r.body.blend.real.actual.single).toBe(1);
    expect(r.body.blend.real.missing).toEqual([{ type: 'single', want: 3, got: 1, label: '单选题' }]);
  });

  it('设置页存了真题配比时，不传 sourceMix 也会带真题（两条入口共用一份设置）', async () => {
    await putSourceMix({ single: 1 });
    stub.candidates = collected(1);
    const r = await generate({ topic: 't' }).expect(200);
    expect(r.body.quiz.questions).toHaveLength(5);
    expect(r.body.blend.real.actual.single).toBe(1);
  });
});

describe('设置端点 /api/settings/quiz-source-mix（联合钳位）', () => {
  it('默认全 0（没配过＝不出真题，不是"缺配置"）', async () => {
    const r = await request(app).get('/api/settings/quiz-source-mix').set('Origin', origin).expect(200);
    expect(r.body.mix).toEqual({ single: 0, multiple: 0, fill: 0, essay: 0, scenario: 0 });
  });

  it('PUT 归一化后回读：超单档上限钳到 5、情景档恒 0', async () => {
    const r = await putSourceMix({ single: 99, scenario: 4 }).expect(200);
    expect(r.body.mix.single).toBe(5);
    expect(r.body.mix.scenario).toBe(0);
  });

  it('★ AI 侧占满 20 时真题被削成 0（AI 优先保额）', async () => {
    await putAiMix({ single: 10, multiple: 10, fill: 0, essay: 0, scenario: 0 });
    const r = await putSourceMix({ single: 3 }).expect(200);
    expect(r.body.mix.single).toBe(0);
  });

  it('★ PUT /quiz-mix 加大 AI 侧会挤掉真题（联合总量兜底，绕过前端也守得住）', async () => {
    await putSourceMix({ single: 3 }); // AI 侧 4 + 真题 3 = 7
    await putAiMix({ single: 10, multiple: 9, fill: 1, essay: 0, scenario: 0 }); // AI 侧 20
    const r = await request(app).get('/api/settings/quiz-source-mix').set('Origin', origin).expect(200);
    expect(r.body.mix.single).toBe(0);
  });
});

describe('纯真题组一道都没摘到 → 502 文案不指鹿为马（2026-09-20 全量回归补钉）', () => {
  it('AI 侧全 0 + 真题摘 0 → 文案说「真题没摘到」，不说「模型解析不出」（模型根本没被调用）', async () => {
    stub.aiQuiz = null;
    stub.candidates = []; // 一道都摘不到
    const r = await generate({
      topic: 't',
      // 纯真题组要过 normalizeQuizMix 的「全 0 回退默认」例外，必须连 sourceMix 一起给
      mix: { single: 0, multiple: 0, fill: 0, essay: 0, scenario: 0 },
      sourceMix: { single: 2 },
    }).expect(502);
    expect(String(r.body.error)).toContain('真题一道都没摘到');
    expect(String(r.body.error)).not.toContain('解析');
  });
});
