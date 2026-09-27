#!/usr/bin/env node
/**
 * evals/run — 出题能力评测跑分器(零依赖,Node ≥ 22)。
 *
 * 用法:
 *   node tools/evals/run.mjs --selftest            # 评分器自检(19 条坏夹具逐一必须被抓到)
 *   node tools/evals/run.mjs --fake                # 假模型全流程(零 key,验证通路,应当全绿)
 *   EVAL_API_KEY=sk-xx EVAL_MODEL=gpt-4o-mini node tools/evals/run.mjs        # 真模型跑分
 *   EVAL_API_BASE=https://api.deepseek.com/v1 ...  # 任意 OpenAI 兼容端点(自带 Key 哲学)
 *
 * 可选参数:
 *   --dataset <path>   默认 tools/evals/datasets/quiz-gen.jsonl
 *   --check <0..1>     总分低于阈值时退出码 1(接 CI 用)
 *   --judge            额外用模型当裁判打质量分(正确性/清晰度/干扰项,1..5)
 *   --concurrency <n>  真模型并发,默认 3
 *   --only <id前缀>    只跑匹配用例
 *
 * 产出:tools/evals/results/<tag>.json(逐用例逐检查)+ 同名 .md(汇总报告)。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, loadQuizProtocol } from './lib/protocol.mjs';
import { gradeCase, HARD_CHECKS, SOFT_CHECKS } from './lib/graders.mjs';
import { fakeCompletion, BROKEN_FIXTURES, FIXTURE_CASE } from './lib/fake-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 参数 ──
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DATASET = opt('dataset', join(HERE, 'datasets', 'quiz-gen.jsonl'));
const CHECK = opt('check', null);
const ONLY = opt('only', null);
const CONCURRENCY = Number(opt('concurrency', '3'));

// ── 真模型调用(OpenAI 兼容 /chat/completions)──
const API_BASE = process.env.EVAL_API_BASE || 'https://api.openai.com/v1';
const API_KEY = process.env.EVAL_API_KEY || '';
const MODEL = process.env.EVAL_MODEL || '';

async function llm(prompt, { temperature = 0.3, maxTokens = 4096 } = {}) {
  const res = await fetch(`${API_BASE.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('API 返回缺 choices[0].message.content');
  return text;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ── LLM 裁判(可选):对通过硬检查的输出打质量分 ──
async function judgeQuality(raw, quizCase) {
  const prompt = `你是出题质量评审。下面是给定材料与一份 AI 生成的题组 JSON。请从三个维度各打 1-5 分(5 最好):
correctness(标注的答案在学科上确实正确)、clarity(题干清晰无歧义)、distractors(干扰项有迷惑性、不弱智)。
只输出 JSON:{"correctness":n,"clarity":n,"distractors":n,"worst_question":"一句话指出最差的一题及原因"}

【材料】
${quizCase.material}

【题组】
${raw}`;
  try {
    const text = await llm(prompt, { temperature: 0 });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const ok = (v) => Number.isFinite(v) && v >= 1 && v <= 5;
    if (!ok(j.correctness) || !ok(j.clarity) || !ok(j.distractors)) return null;
    return j;
  } catch {
    return null;
  }
}

// ── 自检:19 条坏夹具,对应检查必须变红 ──
function selftest() {
  loadQuizProtocol(); // 顺带护栏:生产协议还提取得到
  let failed = 0;
  for (const fx of BROKEN_FIXTURES) {
    const kase = { ...FIXTURE_CASE, mix: { ...FIXTURE_CASE.mix, ...(fx.mix ?? {}) } };
    if (fx.mix) for (const t of Object.keys(kase.mix)) if (!(t in fx.mix)) kase.mix[t] = 0;
    const { checks } = gradeCase(fx.output, kase);
    const hit = checks[fx.mustFail] && !checks[fx.mustFail].pass;
    console.log(`${hit ? '✅' : '❌'} ${fx.name} → 期望 ${fx.mustFail} 变红${hit ? '' : `(实际:${JSON.stringify(checks[fx.mustFail])})`}`);
    if (!hit) failed += 1;
  }
  // 反向护栏:好输出必须全绿
  const good = fakeCompletion(FIXTURE_CASE);
  const { checks, score } = gradeCase(good, FIXTURE_CASE);
  const allGreen = Object.values(checks).every((c) => c.pass);
  console.log(`${allGreen ? '✅' : '❌'} 假模型好输出全绿(score=${score.toFixed(2)})`);
  if (!allGreen) failed += 1;
  console.log(failed === 0 ? `\n自检通过:${BROKEN_FIXTURES.length} 条坏夹具全部被抓到` : `\n自检失败 ${failed} 条`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── 主流程 ──
async function main() {
  if (flag('selftest')) return selftest();

  const useFake = flag('fake');
  if (!useFake && (!API_KEY || !MODEL)) {
    console.error('真模型模式需要 EVAL_API_KEY 与 EVAL_MODEL(或加 --fake 用假模型验通路)。');
    process.exit(2);
  }

  let cases = readFileSync(DATASET, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  if (ONLY) cases = cases.filter((c) => c.id.startsWith(ONLY));
  console.log(`数据集 ${cases.length} 例 | 模式:${useFake ? '假模型(验通路)' : `${MODEL} @ ${API_BASE}`}\n`);

  const results = await mapLimit(cases, useFake ? 8 : CONCURRENCY, async (kase) => {
    const started = Date.now();
    let raw;
    let error = null;
    try {
      raw = useFake ? fakeCompletion(kase) : await llm(buildPrompt(kase));
    } catch (e) {
      error = String(e.message ?? e);
      raw = '';
    }
    const graded = gradeCase(raw, kase);
    let judge = null;
    if (flag('judge') && !useFake && !error) judge = await judgeQuality(raw, kase);
    const hardFails = Object.entries(graded.checks)
      .filter(([, c]) => c.tier === 'hard' && !c.pass)
      .map(([n]) => n);
    const mark = error ? '💥' : hardFails.length === 0 ? '✅' : '❌';
    console.log(
      `${mark} ${kase.id} [${kase.domain}] score=${graded.score.toFixed(2)}` +
        (hardFails.length ? ` 红:${hardFails.join(',')}` : '') +
        (judge ? ` 裁判:${judge.correctness}/${judge.clarity}/${judge.distractors}` : '') +
        (error ? ` ${error.slice(0, 60)}` : ''),
    );
    return { id: kase.id, domain: kase.domain, ms: Date.now() - started, error, raw, ...graded, judge };
  });

  // ── 汇总 ──
  const scores = results.map((r) => r.score);
  const overall = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const perCheck = {};
  for (const name of [...Object.keys(HARD_CHECKS), ...Object.keys(SOFT_CHECKS)]) {
    const ok = results.filter((r) => r.checks[name]?.pass).length;
    perCheck[name] = { pass: ok, total: results.length, rate: ok / (results.length || 1) };
  }
  const allGreen = results.filter((r) => Object.values(r.checks).every((c) => c.pass)).length;

  const tag = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${useFake ? 'fake' : MODEL.replace(/[^\w.-]/g, '_')}`;
  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ tag, dataset: DATASET, overall, perCheck, results }, null, 2));

  const md = [
    `# 出题 eval 报告 · ${tag}`,
    ``,
    `- 用例:${results.length} | 全绿:${allGreen} (${((allGreen / results.length) * 100).toFixed(0)}%) | **总分:${(overall * 100).toFixed(1)}**`,
    ``,
    `| 检查项 | 层级 | 通过率 |`,
    `| --- | --- | --- |`,
    ...Object.entries(perCheck).map(
      ([n, s]) => `| ${n} | ${n in HARD_CHECKS ? 'hard' : 'soft'} | ${s.pass}/${s.total} (${(s.rate * 100).toFixed(0)}%) |`,
    ),
    ``,
    `## 未全绿用例`,
    ``,
    ...results
      .filter((r) => !Object.values(r.checks).every((c) => c.pass))
      .map((r) => {
        const bad = Object.entries(r.checks)
          .filter(([, c]) => !c.pass)
          .map(([n, c]) => `${n}(${c.note ?? ''})`)
          .join('、');
        return `- **${r.id}** [${r.domain}] score=${r.score.toFixed(2)}:${r.error ? `调用失败 ${r.error}` : bad}`;
      }),
  ].join('\n');
  writeFileSync(join(outDir, `${tag}.md`), md + '\n');

  console.log(`\n═══ 总分 ${(overall * 100).toFixed(1)} / 100 | 全绿 ${allGreen}/${results.length} ═══`);
  console.log(`报告:tools/evals/results/${tag}.md(+.json)`);

  if (CHECK != null && overall < Number(CHECK)) {
    console.error(`低于阈值 ${CHECK},退出码 1`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
