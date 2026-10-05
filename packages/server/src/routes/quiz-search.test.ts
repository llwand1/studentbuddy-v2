/**
 * routes/quiz-search 端到端（supertest，同 quiz-image.test.ts 手法）。
 * 钉四件事：① `search` 真透传到出题引擎的第 6 参；② 不传＝不联网（老客户端行为一字不变）；
 * ③ 联网报告原样回到响应（前端据此说「参考了哪几家」）；④ 失败真因分得开
 *   ——「没配模型」指路设置页，「解析不出来」才说可重试（契约 QUIZ-SEARCH-SPEC §3 / §5）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuizPayload, QuizRef } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-search-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { saveExamMode } = await import('../learning/exam-mode.js');
const { savePomodoro, clearPomodoro } = await import('../storage/pomodoro.js');
const { startPomodoro } = await import('@sb/shared');
const request = (await import('supertest')).default;

// 只桩「模型出题」这一段：要验的是路由与引擎之间的接线，故连 report 回填都自己模拟
const quizStub = vi.hoisted(() => ({
  result: null as QuizPayload | null,
  calls: [] as unknown[][],
  /** 模拟引擎回填的失败真因（空串＝不回填） */
  failure: '' as '' | 'no-model' | 'parse' | 'ungrounded',
  /** 模拟引擎回填的联网报告（null＝不回填，走「本次没联网」那条） */
  search: null as { on: boolean; count: number; providers: string[]; failed: string[]; refs: QuizRef[] } | null,
}));

// 真题优先缺省开（QUIZ-TIER-SPEC §4）会并行发起搜集；本文件不断言真题，搜集侧打桩免得碰网
vi.mock('../learning/collect.js', () => ({
  collectQuiz: async (_topic: string, report: unknown) => ({ report, candidates: [] }),
}));

vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../learning/quiz.js')>()),
  generateQuiz: async (...args: unknown[]) => {
    quizStub.calls.push(args);
    const report = args[3] as { failure?: string; search?: unknown } | undefined;
    if (report) {
      if (quizStub.failure) report.failure = quizStub.failure;
      if (quizStub.search) report.search = quizStub.search;
    }
    return quizStub.result;
  },
}));

const origin = 'http://localhost:5173';
const OK_QUIZ: QuizPayload = { title: 'T', questions: [{ type: 'essay', question: 'Q' }] };

const generate = (body: Record<string, unknown>) =>
  request(app).post('/api/quiz/generate').set('Origin', origin).send(body);

/** 末参＝online，也就是本次是否联网 */
const onlineArg = () => quizStub.calls.at(-1)?.at(5);

beforeEach(() => {
  saveExamMode(false, null);
  clearPomodoro(null);
  quizStub.result = OK_QUIZ;
  quizStub.calls = [];
  quizStub.failure = '';
  quizStub.search = null;
});

afterAll(() => closeDb());

describe('/api/quiz/generate 的联网开关透传（契约 §3）', () => {
  it('search: true → 引擎收到 online=true', async () => {
    await generate({ topic: 't', search: true }).expect(200);
    expect(onlineArg()).toBe(true);
  });

  it('search: false → 引擎收到 false（关了就是关了）', async () => {
    await generate({ topic: 't', search: false }).expect(200);
    expect(onlineArg()).toBe(false);
  });

  it('★ 不传 search → 引擎收到 false：老客户端不因为本次改动而被悄悄联网', async () => {
    await generate({ topic: 't' }).expect(200);
    expect(onlineArg()).toBe(false);
  });

  it('非布尔值一律按不联网（不静默当开）', async () => {
    await generate({ topic: 't', search: 'true' }).expect(200);
    expect(onlineArg()).toBe(false);
  });

  it('应试模式省略开关会实时联网，显式关闭和非法值仍不联网', async () => {
    saveExamMode(true, null);
    await generate({ topic: 'Java 线程池' }).expect(200);
    expect(onlineArg()).toBe(true);
    await generate({ topic: 'Java 线程池', search: false }).expect(200);
    expect(onlineArg()).toBe(false);
    await generate({ topic: 'Java 线程池', search: 'true' }).expect(200);
    expect(onlineArg()).toBe(false);
  });

  it('番茄钟标签保留在教学主题里，原始主题单独送到检索入口', async () => {
    savePomodoro(startPomodoro({ subject: 'AI 全栈知识' }, new Date()), null);
    await generate({ topic: 'Java 线程池', search: true }).expect(200);
    expect(quizStub.calls.at(-1)?.[0]).toBe('【AI 全栈知识】Java 线程池');
    expect(quizStub.calls.at(-1)?.[8]).toBe('Java 线程池');
  });
});

describe('/api/quiz/generate 的联网报告回传（契约 §3）', () => {
  it('引擎回填的 search 报告原样回到响应，供前端如实播报', async () => {
    quizStub.search = { on: true, count: 4, providers: ['exa', 'tavily'], failed: [], refs: [] };
    const res = await generate({ topic: 't', search: true }).expect(200);
    expect(res.body.images.search).toEqual({ on: true, count: 4, providers: ['exa', 'tavily'], failed: [], refs: [] });
  });

  it('★ 来源清单（refs）原样回到响应——前端要拿它渲染可点击来源区（契约 §2.8）', async () => {
    const refs: QuizRef[] = [{ n: 1, title: '标题一', url: 'https://a.example/1', provider: 'exa' }];
    quizStub.search = { on: true, count: 1, providers: ['exa'], failed: [], refs };
    const res = await generate({ topic: 't', search: true }).expect(200);
    expect(res.body.images.search.refs).toEqual(refs);
  });

  it('没联网 → images.search 缺席（前端据此不播报，不产生「开了但没搜到」的误读）', async () => {
    const res = await generate({ topic: 't' }).expect(200);
    expect(res.body.images.search).toBeUndefined();
  });
});

describe('/api/quiz/generate 的失败真因（契约 §5，2026-09-13 拆开）', () => {
  it('没有依据的题被剔除时如实报告，而非误报 JSON 解析失败', async () => {
    quizStub.result = null;
    quizStub.failure = 'ungrounded';
    const res = await generate({ topic: 'Java' }).expect(502);
    expect(res.body.error).toContain('没有引用本次检索资料');
    expect(res.body.error).not.toContain('解析');
  });
  it('引擎报 no-model → 文案指路设置页，且**不**说「可重试」', async () => {
    quizStub.result = null;
    quizStub.failure = 'no-model';
    const res = await generate({ topic: 't' }).expect(502);
    expect(res.body.error).toContain('设置');
    expect(res.body.error).toContain('绑定');
    expect(res.body.error).not.toContain('可重试');
  });

  it('引擎报 parse → 文案说可重试（模型确实有输出，只是解不出）', async () => {
    quizStub.result = null;
    quizStub.failure = 'parse';
    const res = await generate({ topic: 't' }).expect(502);
    expect(res.body.error).toContain('解析');
    expect(res.body.error).toContain('可重试');
    expect(res.body.error).not.toContain('绑定模型');
  });

  it('引擎没回填真因（老桩/异常路径）→ 退回「解析」口径，不误指设置页', async () => {
    quizStub.result = null;
    const res = await generate({ topic: 't' }).expect(502);
    expect(res.body.error).toContain('解析');
    expect(res.body.error).not.toContain('绑定模型');
  });
});
