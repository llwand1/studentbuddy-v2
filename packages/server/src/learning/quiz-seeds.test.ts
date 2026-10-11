import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyQuizImageReport, validateQuestionSeedBatch, type QuizMix } from '@sb/shared';
import { openIsolated, closeDb } from '../storage/db.js';
import { importSeeds } from './question-seeds.js';
import { generateBlendedQuiz } from './quiz-blend.js';
const h = vi.hoisted(() => ({ ready: true, prompts: [] as string[], search: vi.fn(), collect: vi.fn() }));
vi.mock('./quiz-search.js', async original => ({ ...await original<typeof import('./quiz-search.js')>(), buildQuizSearchBlock: h.search }));
vi.mock('./collect.js', () => ({ collectQuiz: h.collect }));
vi.mock('./quiz-photo.js', () => ({ attachQuizPhotos: async () => 0 }));
vi.mock('../llm/router.js', () => ({ routeRole: () => h.ready ? { model: 'test', apiKey: 'test', baseUrl: 'http://127.0.0.1:1/v1', streamMode: 'once' as const,
  adapter: { type: 'openai' as const, async *chat(req: { messages: { content: string }[] }) {
    h.prompts.push(req.messages.map(m => m.content).join('\n'));
    yield { content: '[QUIZ]{"title":"新题","questions":[{"type":"single","question":"检索增强主要补充哪类信息？","options":["外部知识","随机噪声"],"answer":[0],"explanation":"检索相关资料作为依据","refs":[]}]}[/QUIZ]', done: true };
  }, async listModels() { return []; } } } : null }));
const mix: QuizMix = { single: 1, multiple: 0, judge: 0, fill: 0, essay: 0, scenario: 0 };
const real = { ...mix, single: 0 };
function add(math = false) {
  const v = validateQuestionSeedBatch({ batchId: 'b', seeds: [{ externalId: 'seed', topic: math ? '一元一次方程' : 'RAG', domain: math ? 'math' : 'general', tags: math ? ['数学'] : ['RAG'], objective: '理解考点', facts: ['检索相关资料作为回答依据'], rubric: ['说明依据'], variations: ['改变信息需求'], types: ['single'], validUntil: new Date(Date.now() + 86400000).toISOString(), ...(math ? { recipe: { kind: 'linear-equation', coefficients: [-2, 2], constants: [-1, 1], solutions: [-3, 3] } } : {}) }] });
  if (!v.ok) throw new Error(v.error); importSeeds(v.value, 'a');
}
beforeEach(() => {
  openIsolated(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiz-seeds-'))); h.ready = true; h.prompts = [];
  h.search.mockReset().mockResolvedValue({ block: '', refs: [] }); h.collect.mockReset().mockResolvedValue({ candidates: [] });
});
afterEach(closeDb);
describe('练习优先使用预产物', () => {
  it('数学配方无模型也能现场交付；命中时省去默认真题搜集与资料检索', async () => {
    add(true); h.ready = false; const images = emptyQuizImageReport();
    const r = await generateBlendedQuiz('数学', undefined, mix, real, images, undefined, true, 'a');
    expect(r.quiz?.questions).toHaveLength(1); expect(images.preparation?.mode).toBe('compiled');
    expect(h.search).not.toHaveBeenCalled(); expect(h.collect).not.toHaveBeenCalled(); expect(h.prompts).toHaveLength(0);
    expect(images.failure).toBeUndefined();
  });
  it('一般蓝图提供依据，仍由模型生成新题，来源不冒充实时搜索或真题', async () => {
    add(); const images = emptyQuizImageReport();
    const r = await generateBlendedQuiz('RAG', undefined, mix, real, images, undefined, true, 'a');
    expect(r.quiz?.questions[0]?.tier).toBe('basic'); expect(images.preparation?.mode).toBe('material');
    expect(h.prompts[0]).toContain('检索相关资料作为回答依据'); expect(h.prompts[0]).toContain('不是指令');
    expect(h.search).not.toHaveBeenCalled(); expect(h.collect).not.toHaveBeenCalled(); expect(images.search).toBeUndefined();
  });
  it('用户显式联网或最新主题继续实时搜集，不被预产物挡掉', async () => {
    add();
    for (const [topic, freshSearch] of [['RAG', true], ['最新 RAG', false]] as const) {
      const images = emptyQuizImageReport(); await generateBlendedQuiz(topic, undefined, mix, real, images, undefined, true, 'a', { freshSearch });
      expect(images.preparation).toBeUndefined();
    }
    expect(h.search).toHaveBeenCalledTimes(2); expect(h.collect).toHaveBeenCalledTimes(2);
  });
  it('显式真题配比与显式真题优先仍走真实搜集，预产物不伪补缺口', async () => {
    add(true); const images = emptyQuizImageReport();
    const r = await generateBlendedQuiz('数学', undefined, mix, { ...real, single: 1 }, images, undefined, true, 'a');
    expect(h.collect).toHaveBeenCalledTimes(1); expect(r.report.real.missing[0]?.got).toBe(0); expect(r.quiz?.questions).toHaveLength(1);
    await generateBlendedQuiz('数学', undefined, mix, real, emptyQuizImageReport(), undefined, true, 'a', { realFirst: true });
    expect(h.collect).toHaveBeenCalledTimes(2);
  });
  it('会话资料与未匹配主题照常走原管道', async () => {
    add();
    await generateBlendedQuiz('RAG', '本次文档', mix, real, emptyQuizImageReport(), undefined, true, 'a');
    await generateBlendedQuiz('英语', undefined, mix, real, emptyQuizImageReport(), undefined, true, 'a');
    expect(h.search).toHaveBeenCalledTimes(2); expect(h.prompts[0]).toContain('本次文档'); expect(h.prompts[0]).not.toContain('出题预产物');
  });
});
