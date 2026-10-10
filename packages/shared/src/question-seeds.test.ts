import { describe, expect, it } from 'vitest';
import { validateQuestionSeedBatch, questionSeedsInstructions } from './question-seeds.js';
const now = Date.UTC(2026, 9, 10);
const seed = { externalId: 'seed-1', topic: ' RAG ', tags: ['RAG'], objective: '结合检索结果回答', facts: ['检索资料可补充模型知识'], rubric: ['先检索再生成'], variations: ['改变知识缺口'], types: ['single'], validUntil: '2026-11-01T00:00:00Z' };
const batch = (extra: object = {}) => ({ batchId: 'b-1', seeds: [{ ...seed, ...extra }] });
describe('出题预产物契约', () => {
  it('归一资料与来源，条目内不保存题干或答案', () => {
    const r = validateQuestionSeedBatch(batch({ sourceUrls: ['https://example.com', 'https://example.com/'] }), now);
    expect(r.ok && r.value.seeds[0]).toMatchObject({ topic: 'RAG', domain: 'general', sourceUrls: ['https://example.com/'], scopeSignature: 'all', misconceptions: [] });
  });
  it('拒绝成品题、归属、执行器以及坏批次，定位坏条目', () => {
    for (const extra of [{ question: '成品题' }, { answer: [0] }, { ownerId: 'b' }, { recipe: { kind: 'eval', code: 'run' } }]) expect(validateQuestionSeedBatch(batch(extra), now).ok).toBe(false);
    expect(validateQuestionSeedBatch({ batchId: '../bad', seeds: [seed] }, now).ok).toBe(false);
    expect(validateQuestionSeedBatch({ batchId: 'b', seeds: [seed, { ...seed, facts: [] }] }, now)).toMatchObject({ ok: false, index: 1 });
  });
  it('明确拒绝坏集合、超限正文和携带凭证的来源', () => {
    for (const extra of [{ tags: null }, { rubric: [] }, { sourceUrls: null }, { sourceUrls: ['https://u:pw@example.com/'] }, { facts: ['x'.repeat(1001)] }, { types: ['scenario'] }]) expect(validateQuestionSeedBatch(batch(extra), now).ok).toBe(false);
    expect(validateQuestionSeedBatch({ batchId: 'b', seeds: Array(51).fill(seed) }, now).ok).toBe(false);
  });
  it('有效期有界；回放可单独校验结构不误拒已过期旧批次', () => {
    for (const validUntil of ['not-date', '2026-10-09T00:00:00Z', '2028-01-01T00:00:00Z']) expect(validateQuestionSeedBatch(batch({ validUntil }), now).ok).toBe(false);
    expect(validateQuestionSeedBatch(batch({ validUntil: '2026-10-09T00:00:00Z' }), now, false).ok).toBe(true);
  });
  it('数学配方只允许已实现的有界非零参数规则和相应题型', () => {
    const math = { topic: '一元一次方程', domain: 'math', recipe: { kind: 'linear-equation', coefficients: [-2, 2], constants: [-1, 1], solutions: [-3, 3] } };
    expect(validateQuestionSeedBatch(batch(math), now).ok).toBe(true);
    for (const extra of [{ domain: 'english' }, { topic: '积分' }, { types: ['multiple'] }, { recipe: { ...math.recipe, coefficients: [0, 2] } }, { recipe: { ...math.recipe, solutions: [3, 3] } }]) expect(validateQuestionSeedBatch(batch({ ...math, ...extra }), now).ok).toBe(false);
  });
  it('可复制说明要求独立授权与可靠依据，不包含任何 token', () => {
    const s = questionSeedsInstructions('https://example.com');
    expect(s).toContain('STUDENTBUDDY_SEEDS_TOKEN'); expect(s).toContain('不上传成品题'); expect(s).toContain('DELETE /question-seeds/:id'); expect(s).not.toContain('sb_terms_');
  });
});
