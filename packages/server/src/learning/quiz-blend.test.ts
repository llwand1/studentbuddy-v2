/**
 * learning/quiz-blend — 出题来源合流的单测（契约 `docs/QUIZ-BLEND-SPEC.md` §3.3／§7 T1+T2）。
 *
 * 分两层钉：
 * · **纯函数层**（`pickByQuota` / `blendMissing`）：配额怎么算、缺口怎么报——不带 IO，失败信息最干净；
 * · **IO 层**（`generateBlendedQuiz`）：两条管道的拼装、跳过与降级。
 *
 * 两条**反向锁**（只断正向会漏掉的）：
 *   ① 真题**不参与** `applyQuizMix` 裁剪（拿一个会裁掉题的 aiMix 验证真题一道不少）；
 *   ② 真题侧抛错时**仍然返回 AI 题**（真题是增益不是依赖——ADR-4）。
 * 上游一律打桩：`generateQuiz` 桩掉、`collectQuiz` 桩掉，**不碰真库真网**。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CollectCandidate, CollectReport, QuizPayload, QuizQuestion, QuizSourceMix } from '@sb/shared';
import { DEFAULT_QUIZ_MIX, DEFAULT_QUIZ_SOURCE_MIX, emptyQuizImageReport } from '@sb/shared';
import { blendMissing, generateBlendedQuiz, pickByQuota } from './quiz-blend.js';

const stub = vi.hoisted(() => ({
  /** 桩：AI 侧产出（null ＝ 出题失败） */
  aiQuiz: null as QuizPayload | null,
  /** 桩：真题侧候选 */
  candidates: [] as CollectCandidate[],
  /** 桩：collectQuiz 是否抛错 */
  collectThrows: false,
  genCalls: [] as unknown[][],
  collectCalls: [] as unknown[][],
}));

vi.mock('./quiz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./quiz.js')>()),
  generateQuiz: async (...args: unknown[]) => {
    stub.genCalls.push(args);
    return stub.aiQuiz;
  },
}));

vi.mock('./collect.js', () => ({
  collectQuiz: async (topic: string, report: CollectReport, opts?: unknown) => {
    stub.collectCalls.push([topic, report, opts]);
    if (stub.collectThrows) throw new Error('network down');
    return { report, candidates: stub.candidates };
  },
}));

const real = (over: Partial<QuizSourceMix> = {}): QuizSourceMix => ({ ...DEFAULT_QUIZ_SOURCE_MIX, ...over });
const cand = (type: 'single' | 'multiple' | 'fill' | 'essay', question: string, ok = true): CollectCandidate => ({
  question: { type, question, ...(type === 'single' || type === 'multiple' ? { options: ['A', 'B'], answer: [0] } : { answer: ['x'] }) },
  ok,
});
/**
 * 与 `DEFAULT_QUIZ_MIX`（2 单选 + 1 填空 + 1 解答，共 4 道）**严格对齐**的 AI 产出——好让
 * `applyQuizMix` 一道都不裁。裁剪本身是既有行为、另有专测钉着，不该在合流的用例里被当成变量
 * （否则「真题没被 AI 侧裁掉」那条断言就说不清了）。
 */
const AI_QUESTIONS: QuizQuestion[] = [
  { type: 'single', question: 'AI-s0', options: ['A', 'B'], answer: [0] },
  { type: 'single', question: 'AI-s1', options: ['A', 'B'], answer: [0] },
  { type: 'fill', question: 'AI-f0', answer: ['x'] },
  { type: 'essay', question: 'AI-e0', answer: 'a' },
];
const aiQuizDefault = (): QuizPayload => ({ title: 'AI 题组', questions: AI_QUESTIONS.map((q) => ({ ...q })) });

beforeEach(() => {
  stub.aiQuiz = aiQuizDefault();
  stub.candidates = [];
  stub.collectThrows = false;
  stub.genCalls = [];
  stub.collectCalls = [];
});

describe('pickByQuota（按题型配额挑真题）', () => {
  it('只收 ok:true 的候选——被判「疑似非原文」的题绝不放行', () => {
    const out = pickByQuota([cand('single', '好题'), cand('single', '坏题', false)], real({ single: 5 }));
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0]?.question).toBe('好题');
  });

  it('逐档封顶：配额 2 就给 2（第 3 道同题型不再收）', () => {
    const out = pickByQuota([cand('single', 'a'), cand('single', 'b'), cand('single', 'c')], real({ single: 2 }));
    expect(out.questions.map((q) => q.question)).toEqual(['a', 'b']);
    expect(out.actual.single).toBe(2);
  });

  it('配额为 0 的题型一道不收（用户在设置页没要这类真题）', () => {
    const out = pickByQuota([cand('single', 'a'), cand('fill', 'b')], real({ fill: 1 }));
    expect(out.questions.map((q) => q.question)).toEqual(['b']);
    expect(out.actual.single).toBe(0);
  });

  it('顺序即候选顺序（摘到什么就是什么，不重排）', () => {
    const out = pickByQuota([cand('fill', 'f1'), cand('single', 's1'), cand('fill', 'f2')], real({ single: 1, fill: 2 }));
    expect(out.questions.map((q) => q.question)).toEqual(['f1', 's1', 'f2']);
  });

  it('scenario 档永远挑不到（真题里没有「可玩 demo」这种东西）', () => {
    const out = pickByQuota([cand('single', 'a')], real({ scenario: 3 }));
    expect(out.questions).toHaveLength(0);
    expect(out.actual.scenario).toBe(0);
  });
});

describe('blendMissing（缺口如实报，不用 AI 补）', () => {
  it('全摘够 → 空数组', () => {
    expect(blendMissing(real({ single: 2 }), real({ single: 2 }))).toEqual([]);
  });

  it('只列没摘够的档，带 want/got 与中文题型名', () => {
    const out = blendMissing(real({ single: 2, fill: 1 }), real({ single: 1 }));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'single', want: 2, got: 1, label: '单选题' });
    expect(out[1]).toMatchObject({ type: 'fill', want: 1, got: 0, label: '填空题' });
  });

  it('一道都没摘到 → 所有配了额的档都在缺口里', () => {
    expect(blendMissing(real({ single: 2, essay: 1 }), real())).toHaveLength(2);
  });

  it('本批没配真题 → 缺口为空（没要不等于没出齐）', () => {
    expect(blendMissing(real(), real())).toEqual([]);
  });
});

describe('generateBlendedQuiz（两条管道的拼装与降级）', () => {
  const run = (aiMix = DEFAULT_QUIZ_MIX, realMix = real()) =>
    generateBlendedQuiz('主题', undefined, aiMix, realMix, emptyQuizImageReport(), undefined, false, null);

  it('AI 题在前、真题在后（按来源分组，用户一眼能分辨）', async () => {
    stub.candidates = [cand('single', '真题1')];
    const r = await run(DEFAULT_QUIZ_MIX, real({ single: 1 }));
    expect(r.quiz?.questions.map((q) => q.question)).toEqual(['AI-s0', 'AI-s1', 'AI-f0', 'AI-e0', '真题1']);
  });

  it('★ 真题不参与 AI 侧的 applyQuizMix 裁剪（配额是 1，就留 1 道，不会因 aiMix 被削）', async () => {
    stub.candidates = [cand('single', '真题1'), cand('fill', '真题2')];
    // aiMix 只允许 1 道 essay，AI 侧只有 1 道 essay 会被留；真题侧各 1 道必须原样进组
    const r = await run({ single: 0, multiple: 0, fill: 0, essay: 1, scenario: 0 }, real({ single: 1, fill: 1 }));
    expect(r.quiz?.questions.map((q) => q.question)).toEqual(['AI-e0', '真题1', '真题2']);
  });

  it('AI 侧配额为 0 → 整段跳过，一次出题模型都不调（纯真题组）', async () => {
    stub.candidates = [cand('single', '真题1')];
    const r = await run({ single: 0, multiple: 0, fill: 0, essay: 0, scenario: 0 }, real({ single: 1 }));
    expect(stub.genCalls).toHaveLength(0);
    expect(r.quiz?.questions.map((q) => q.question)).toEqual(['真题1']);
    expect(r.quiz?.title).toContain('现场搜集');
  });

  it('真题侧配额为 0 → 一次搜集都不发起（老行为零成本）', async () => {
    const r = await run();
    expect(stub.collectCalls).toHaveLength(0);
    expect(r.quiz?.questions).toHaveLength(AI_QUESTIONS.length);
    expect(r.report.collect).toBeUndefined();
  });

  it('真题配额进搜集提示词参数（不告诉模型要哪类题，它会全摘选择题）', async () => {
    stub.candidates = [];
    await run(DEFAULT_QUIZ_MIX, real({ single: 2, fill: 1 }));
    const opts = stub.collectCalls[0]?.[2] as { quota?: QuizSourceMix } | undefined;
    expect(opts?.quota).toEqual(real({ single: 2, fill: 1 }));
  });

  it('★ 真题侧抛错不阻断：AI 题照常返回，缺口与失败原因如实记账', async () => {
    stub.collectThrows = true;
    const r = await run(DEFAULT_QUIZ_MIX, real({ single: 2 }));
    expect(r.quiz?.questions).toHaveLength(AI_QUESTIONS.length);
    expect(r.report.real.actual.single).toBe(0);
    expect(r.report.real.missing).toHaveLength(1);
    expect(r.report.collect?.failed.join(' ')).toContain('network down');
  });

  it('AI 侧失败但真题摘到了 → 仍然有题组（真题独立成立）', async () => {
    stub.aiQuiz = null;
    stub.candidates = [cand('single', '真题1')];
    const r = await run(DEFAULT_QUIZ_MIX, real({ single: 1 }));
    expect(r.quiz?.questions.map((q) => q.question)).toEqual(['真题1']);
  });

  it('两侧都没产出 → quiz 为 null（路由据此走 502 降级）', async () => {
    stub.aiQuiz = null;
    const r = await run();
    expect(r.quiz).toBeNull();
  });

  it('AI 侧报告原样透传（路由的 shortfallText 依赖它）', async () => {
    stub.aiQuiz = { title: 'AI 题组', questions: [AI_QUESTIONS[0]!] }; // 默认配比要 4 道，只给 1 道
    const r = await run();
    expect(r.report.ai.requested).toEqual(DEFAULT_QUIZ_MIX);
    expect(r.report.ai.matched).toBe(false);
  });
});
