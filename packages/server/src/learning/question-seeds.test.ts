import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateQuestionSeedBatch, type QuizMix, type QuestionSeed } from '@sb/shared';
import { openIsolated, closeDb } from '../storage/db.js';
import { importSeeds, listSeeds, selectSeed, seedEligibility } from './question-seeds.js';
import { compileSeed, equationQuestion } from './question-seed-compile.js';
import { saveExamMode, saveExamScope, loadExamContext } from './exam-mode.js';
const raw = (extra: object = {}) => ({ externalId: 'math-1', topic: '一元一次方程', domain: 'math', tags: ['数学', '一元一次方程'], objective: '求解并检验', facts: ['等式两边除以同一个非零数仍相等'], rubric: ['求解', '代入检验'], variations: ['改变整数参数'], types: ['single', 'judge', 'fill', 'essay'], validUntil: new Date(Date.now() + 86400000).toISOString(), recipe: { kind: 'linear-equation', coefficients: [-2, 2], constants: [-1, 1], solutions: [-3, 3] }, ...extra });
const add = (owner: string | null = 'a', extra: object = {}) => {
  const v = validateQuestionSeedBatch({ batchId: 'batch-' + owner, seeds: [raw(extra)] }); if (!v.ok) throw new Error(v.error);
  importSeeds(v.value, owner); return listSeeds(owner)[0]!;
};
const mix = (extra: Partial<QuizMix> = {}): QuizMix => ({ single: 1, multiple: 0, judge: 0, fill: 0, essay: 0, scenario: 0, ...extra });
beforeEach(() => { openIsolated(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-seed-domain-'))); });
afterEach(closeDb);
describe('预产物选择与现场编译', () => {
  it('主题、账号、有效期和题型共同约束，不拿无关材料填空', () => {
    const r = add(); add('b', { externalId: 'b-math' });
    expect(selectSeed('a', '数学', ['single'])?.id).toBe(r.id);
    expect(selectSeed('c', '数学', ['single'])).toBeNull(); expect(selectSeed('a', '英语语法', ['single'])).toBeNull();
    expect(selectSeed('a', '数学', ['multiple'])).toBeNull();
    expect(selectSeed('a', '数学二重积分', ['single'])).toBeNull();
    expect(seedEligibility(r.seed, 'a', Date.now() + 2 * 86400000).eligible).toBe(false);
  });
  it('应试签名与完整来源都必须符合当前范围，切换后立刻停用', () => {
    saveExamMode(true, 'a'); saveExamScope({ packs: [], custom: ['example.com'] }, 'a');
    const signature = loadExamContext('a').signature;
    const r = add('a', { scopeSignature: signature, sourceUrls: ['https://example.com/lesson'] });
    expect(seedEligibility(r.seed, 'a').eligible).toBe(true);
    expect(seedEligibility({ ...r.seed, sourceUrls: [] }, 'a').eligible).toBe(false);
    expect(seedEligibility({ ...r.seed, sourceUrls: ['https://evil.example.net/'] }, 'a').eligible).toBe(false);
    saveExamScope({ packs: [], custom: ['other.com'] }, 'a'); expect(selectSeed('a', '数学', ['single'])).toBeNull();
  });
  it('显式资料、实时/最新主题与 freshSearch 优先于预产物', () => {
    add(); expect(selectSeed('a', '数学', ['single'], '当前文档')).toBeNull();
    for (const topic of ['最新数学资料', '数学实时题', '数学联网搜索']) expect(selectSeed('a', topic, ['single'])).toBeNull();
    expect(selectSeed('a', '数学', ['single'], undefined, true)).toBeNull();
  });
  it('正负系数/常数/零与负解均只有一个正确选项，解析含同一参数的验算', () => {
    for (const a of [-9, -1, 1, 9]) for (const b of [-20, 0, 20]) for (const x of [-20, 0, 20]) for (const position of [0, 1, 2, 3]) {
      const q = equationQuestion(a, b, x, 'single', position);
      const values = q.options!.map(Number), answer = q.answer as number[];
      expect(new Set(values).size).toBe(4); expect(values[answer[0]!]).toBe(x);
      expect(values.filter(v => a * v + b === a * x + b)).toHaveLength(1);
      expect(q.explanation).toContain(`=${a * x + b}`);
    }
  });
  it('同一配方每组参数只交付一次，用完明确返回 null、不回显旧题', () => {
    const r = add(), stems = new Set<string>();
    for (let i = 0; i < 8; i++) { const q = compileSeed('a', r, mix())!; expect(q).not.toBeNull(); stems.add(q.questions[0]!.question); }
    expect(stems.size).toBe(8); expect(compileSeed('a', r, mix())).toBeNull(); expect(listSeeds('a')[0]!.used).toHaveLength(8);
  });
  it('整个题组才能认领；取消、排除、提交失败不消耗，旧快照不覆盖新消费', () => {
    const r = add();
    expect(compileSeed('a', r, mix({ single: 9 }))).toBeNull();
    expect(compileSeed('a', r, mix(), { signal: AbortSignal.abort() })).toBeNull();
    expect(compileSeed('a', r, mix(), { accept: () => false })).toBeNull();
    expect(compileSeed('a', r, mix(), { commit: () => false })).toBeNull();
    expect(listSeeds('a')[0]!.used).toHaveLength(0);
    compileSeed('a', r, mix()); compileSeed('a', r, mix()); expect(listSeeds('a')[0]!.used).toHaveLength(2);
  });
  it('单选、判断、填空和解答按配比分配，多选不伪造成单选', () => {
    const r = add(), out = compileSeed('a', r, mix({ judge: 1, fill: 1, essay: 1 }))!;
    expect(out.questions.map(q => q.type)).toEqual(['single', 'judge', 'fill', 'essay']);
    expect(out.questions[2]!.answer).toHaveLength(1); expect(out.questions[3]!.solution).toContain('\\begin{aligned}');
    const changed = { ...r, seed: { ...r.seed, types: ['multiple'] as QuestionSeed['types'] } };
    expect(compileSeed('a', changed, mix({ single: 0, multiple: 1 }))).toBeNull();
  });
});
