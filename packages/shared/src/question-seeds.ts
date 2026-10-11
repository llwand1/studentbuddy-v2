/** 外部 agent 的出题依据与参数空间，不是成品题导入。 */
export const SEED_TYPES = ['single', 'multiple', 'judge', 'fill', 'essay'] as const;
export type SeedType = typeof SEED_TYPES[number];
export interface EquationRecipe { kind: 'linear-equation'; coefficients: number[]; constants: number[]; solutions: number[] }
export interface QuestionSeed {
  externalId: string; topic: string; domain: string; tags: string[]; objective: string;
  facts: string[]; misconceptions: string[]; rubric: string[]; variations: string[]; types: SeedType[];
  sourceUrls: string[]; scopeSignature: string; validUntil: string; recipe?: EquationRecipe;
}
export interface QuestionSeedBatch { batchId: string; seeds: QuestionSeed[] }
export interface QuestionPreparation {
  seedId: string; topic: string; mode: 'compiled' | 'material'; skipped: string[];
  source: 'external-agent';
}
type Validation = { ok: true; value: QuestionSeedBatch } | { ok: false; error: string; index?: number };
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.trim().length > 0 && x.trim().length <= max;
const list = (x: unknown, min: number, max: number, chars: number): x is string[] => Array.isArray(x) && x.length >= min && x.length <= max && x.every(t => text(t, chars));
const fields = new Set(['externalId', 'topic', 'domain', 'tags', 'objective', 'facts', 'misconceptions', 'rubric', 'variations', 'types', 'sourceUrls', 'scopeSignature', 'validUntil', 'recipe']);
const cleanList = (x: string[]) => [...new Set(x.map(t => t.trim()))];

export function validateQuestionSeedBatch(input: unknown, now = Date.now(), checkTime = true): Validation {
  if (!object(input) || Object.keys(input).some(k => !['batchId', 'seeds'].includes(k))) return { ok: false, error: '只接受 batchId 和 seeds，归属由密钥决定。' };
  if (!text(input.batchId, 100) || !/^[A-Za-z0-9._:-]+$/.test(input.batchId)) return { ok: false, error: 'batchId 需要 1–100 个 ASCII 字母数字或 . _ : -。' };
  if (!Array.isArray(input.seeds) || !input.seeds.length || input.seeds.length > 50) return { ok: false, error: '每批需要 1–50 个预产物。' };
  const seeds: QuestionSeed[] = [];
  for (const [index, r] of input.seeds.entries()) {
    const fail = (error: string): Validation => ({ ok: false, index, error });
    if (!object(r) || Object.keys(r).some(k => !fields.has(k))) return fail('预产物字段不合法，不能上传成品题、答案或归属。');
    if (!text(r.externalId, 100) || !/^[A-Za-z0-9._:-]+$/.test(r.externalId)) return fail('externalId 需要 1–100 个 ASCII 字母数字或 . _ : -。');
    if (!text(r.topic, 100) || !text(r.objective, 300) || (r.domain !== undefined && !text(r.domain, 30))) return fail('topic 1–100 字、objective 1–300 字、domain 1–30 字。');
    if (!list(r.tags, 1, 12, 80) || !list(r.facts, 1, 12, 1000) || !list(r.rubric, 1, 8, 300) || !list(r.variations, 1, 8, 300) || !list(r.misconceptions ?? [], 0, 8, 300)) return fail('tags/facts/rubric/variations 需要非空有界文字列表，misconceptions 最多 8 个。');
    if (!Array.isArray(r.types) || !r.types.length || r.types.length > 5 || r.types.some(t => !SEED_TYPES.includes(t as SeedType))) return fail('types 需要受支持的非空题型集合。');
    if (r.scopeSignature !== undefined && (!text(r.scopeSignature, 1000) || /[\r\n]/.test(r.scopeSignature))) return fail('scopeSignature 请复制 context.exam.signature。');
    if (!text(r.validUntil, 40) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(r.validUntil) || !Number.isFinite(Date.parse(r.validUntil)) || (checkTime && (Date.parse(r.validUntil) <= now || Date.parse(r.validUntil) > now + 366 * 86400000))) return fail('validUntil 需要未来一年内的 UTC ISO 时间。');
    const urls: string[] = [];
    if (r.sourceUrls !== undefined && (!Array.isArray(r.sourceUrls) || r.sourceUrls.length > 3)) return fail('sourceUrls 最多 3 个完整 http(s) URL。');
    for (const source of (r.sourceUrls ?? []) as unknown[]) {
      if (!text(source, 2000)) return fail('来源 URL 需要 1–2000 字。');
      try {
        const u = new URL(source);
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.href.length > 2000) return fail('来源只接受无凭证 http(s) URL。');
        urls.push(u.href);
      } catch { return fail('来源 URL 不合法。'); }
    }
    const domain = typeof r.domain === 'string' ? r.domain.trim().toLowerCase() : 'general';
    let recipe: EquationRecipe | undefined;
    if (r.recipe !== undefined) {
      const p = r.recipe;
      if (!object(p) || Object.keys(p).some(k => !['kind', 'coefficients', 'constants', 'solutions'].includes(k)) || p.kind !== 'linear-equation' || domain !== 'math' || r.topic.trim() !== '一元一次方程' || r.types.includes('multiple')) return fail('配方仅支持 math / 一元一次方程，不支持多选或执行代码。');
      const ints = (v: unknown, bound: number, nonzero = false): v is number[] => Array.isArray(v) && v.length >= 2 && v.length <= 10 && new Set(v).size === v.length && v.every(n => typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= bound && (!nonzero || n !== 0));
      if (!ints(p.coefficients, 9, true) || !ints(p.constants, 20) || !ints(p.solutions, 20)) return fail('参数需要 2–10 个不同整数；系数非零且 −9..9，常数和解 −20..20。');
      recipe = { kind: 'linear-equation', coefficients: [...p.coefficients], constants: [...p.constants], solutions: [...p.solutions] };
    }
    seeds.push({ externalId: r.externalId.trim(), topic: r.topic.trim(), domain, tags: cleanList(r.tags), objective: r.objective.trim(),
      facts: cleanList(r.facts), misconceptions: cleanList((r.misconceptions ?? []) as string[]), rubric: cleanList(r.rubric), variations: cleanList(r.variations), types: [...new Set(r.types as SeedType[])],
      sourceUrls: [...new Set(urls)], scopeSignature: typeof r.scopeSignature === 'string' ? r.scopeSignature.trim() : 'all', validUntil: new Date(r.validUntil).toISOString(), ...(recipe ? { recipe } : {}) });
  }
  return { ok: true, value: { batchId: input.batchId, seeds } };
}

export function questionSeedsInstructions(origin: string): string {
  return `请为我的 StudentBuddy 准备出题预产物，不上传成品题。\n接口：${origin}/api/open/v1；使用已勾选「出题预产物」权限的专用密钥，从私有环境变量 STUDENTBUDDY_SEEDS_TOKEN 读取，使用 Authorization: Bearer；不要输出它。\n先 GET /context，复制 exam.signature 并遵守 allowedHosts；GET /question-seeds 分页排重。\nPOST /question-seeds/import：{batchId,seeds:[{externalId,topic,domain,tags,objective,facts,misconceptions,rubric,variations,types,sourceUrls,scopeSignature,validUntil}]}。每批最多50个，batchId 重试不变。事实要有可靠依据，误区与评分要点要清楚；variations 写可变情境，不写现成题干/选项/答案。validUntil 为未来一年内 UTC ISO 时间；时效材料用短期限，来源不可编造。\n可选 linear-equation 参数配方可现场快速编译数学题；其他蓝图由模型现场创作、核对。撤下不再使用的预产物：DELETE /question-seeds/:id。按回执报告 added/skipped、eligible 与 reason；不要把导入成功当已经生成题目。\n完整字段和示例：${origin}/api/open/v1/openapi.json`;
}
