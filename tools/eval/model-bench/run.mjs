#!/usr/bin/env node
/**
 * evals/run — 模型能力评测跑分器(零依赖,Node ≥ 22)。四套件:
 *
 *   quiz-gen   从材料出题:协议服从性(40 例,含提示注入对抗)
 *   replicate  复刻网络题目:保真度 → 成功率 + 总体相似度(30 例)
 *   search     联网搜索出题:refs 引用溯源 → 引用命中率(15 例)
 *   terms      词条抽取:对金标 P/R/F1(25 例)
 *
 * 用法:
 *   npm run eval:models -- --selftest                # 评分器自检(零 key 零网络)
 *   npm run eval:models -- --fake                    # 假模型验通路(应当全绿)
 *   EVAL_API_KEY=sk-x EVAL_MODEL=gpt-4o-mini npm run eval:models --   # 真模型全量
 *   ... run.mjs --suite replicate,search               # 只跑部分套件
 *   ... run.mjs --only rep-00 --check 0.8 --judge      # 前缀过滤/CI 阈值/模型裁判
 *   ... run.mjs --verify                               # 盲解验算效果(quiz-gen 套件,对应生产 quiz-verify.ts / issue #71)
 *
 * 产出:tools/eval/model-bench/results/<tag>.json(逐用例逐检查)+ 同名 .md(汇总报告)。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, buildReplicatePrompt, buildSearchPrompt, buildTermsPrompt, loadQuizProtocol, loadTermsProtocol } from './lib/protocol.mjs';
import { gradeCase, HARD_CHECKS, SOFT_CHECKS, tryParse } from './lib/graders.mjs';
import { fakeCompletion, BROKEN_FIXTURES, FIXTURE_CASE } from './lib/fake-model.mjs';
import { replicateSuite, searchSuite, termsSuite, selftestSuites } from './lib/suites.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ── 参数 ──
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const CHECK = opt('check', null);
const ONLY = opt('only', null);
const CONCURRENCY = Number(opt('concurrency', '3'));

// ── 套件登记表 ──
const quizGenSuite = {
  grade: (raw, kase) => {
    const g = gradeCase(raw, kase);
    return { ...g, success: Object.values(g.checks).every((c) => c.pass) };
  },
  aggregate: (results) => {
    const allGreen = results.filter((r) => r.success).length;
    const score = results.reduce((a, r) => a + r.score, 0) / results.length;
    return {
      primary: score,
      headline: `总分 ${(score * 100).toFixed(1)} · 全绿率 ${pct(allGreen / results.length)}`,
      metrics: { 总分: (score * 100).toFixed(1), 全绿率: pct(allGreen / results.length) },
    };
  },
  fake: fakeCompletion,
};

const SUITES = {
  'quiz-gen': { ...quizGenSuite, dataset: 'quiz-gen.jsonl', prompt: buildPrompt, 用处: '从材料出题的协议服从性(对话出题/知识大陆挑战/对战的共同地基)' },
  replicate: { ...replicateSuite, dataset: 'quiz-replicate.jsonl', prompt: buildReplicatePrompt, 用处: '复刻网络题目保真度(联网搜到真题后转协议格式,考点与答案不许跑)' },
  search: { ...searchSuite, dataset: 'quiz-search.jsonl', prompt: buildSearchPrompt, 用处: '联网出题的 refs 引用溯源(引对资料=可信度,引错比不引更糟)' },
  terms: { ...termsSuite, dataset: 'term-extract.jsonl', prompt: buildTermsPrompt, 用处: '词条抽取质量(词条是产品主体,抽错=学练忆全歪)' },
};

// ── 真模型调用(OpenAI 兼容 /chat/completions)──
const API_BASE = process.env.EVAL_API_BASE || 'https://api.openai.com/v1';
const API_KEY = process.env.EVAL_API_KEY || '';
const MODEL = process.env.EVAL_MODEL || '';

const RETRIES = Number(opt('retries', '5'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function llm(prompt, { temperature = 0.3, maxTokens = 4096 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000); // 指数退避 4s→8s→16s→32s→60s
    const res = await fetch(`${API_BASE.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens }),
    }).catch((e) => ({ ok: false, status: 'network', text: async () => String(e) }));
    if (!res.ok) {
      lastErr = new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      // 429(限流)与 5xx(服务端抖动)值得重试;4xx 其他错误直接失败
      if (res.status === 429 || res.status >= 500 || res.status === 'network') continue;
      throw lastErr;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') { lastErr = new Error('API 返回缺 choices[0].message.content'); continue; }
    return text;
  }
  throw lastErr;
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

// ── 盲解验算(--verify,量产品保险丝 quiz-verify.ts 的效果,issue #71)──
//
// 对 quiz-gen 套件每道选择类题:同一模型**盲解**(只喂题干+选项,与生产 buildSolvePrompt
// 同款无泄漏),与标注比对。产出四个数:一致率 / 拦截数 / 不可解数 / answers 红 before→after
// (after = 把被拦的题丢掉后重跑 answers 检查)——「保险丝拦住了多少坏题」从此是可对照的数字。
// 解析纪律与生产 quiz-verify.ts 一致:只认字母;单选答出多个字母=矛盾 → 不猜,记 unresolved。
const V_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
function verifyParse(reply, optionCount, multiple) {
  const seen = new Set();
  for (const ch of String(reply).toUpperCase()) {
    const i = V_LETTERS.indexOf(ch);
    if (i >= 0 && i < optionCount) seen.add(i);
  }
  if (seen.size === 0 || (!multiple && seen.size > 1)) return null;
  return [...seen].sort((a, b) => a - b);
}

async function verifySolve(q, useFake) {
  if (useFake) return (q.answer ?? []).map((i) => V_LETTERS[i] ?? '').join(''); // 假模式=理想 solver,验通路
  const opts = (q.options ?? []).map((o, i) => `${V_LETTERS[i]}. ${o}`);
  const ask = q.type === 'multiple' ? '这是多选题,只输出全部正确选项的字母(如 AC),不要任何解释。' : '只输出正确选项的字母,不要任何解释。';
  try {
    // maxTokens 512 不是浪费:agnes/gemini 系有隐藏思考 token,给 16 会把答案截成空串(真机踩坑)
    return await llm([ask, '', `题干：${q.question}`, ...opts].join('\n'), { temperature: 0, maxTokens: 512 });
  } catch {
    return null;
  }
}

async function verifyQuizRaw(raw, useFake) {
  const parsed = tryParse(raw);
  const qs = parsed?.questions ?? [];
  const stats = { checked: 0, passed: 0, dropped: 0, unresolved: 0 };
  const kept = [];
  for (const q of qs) {
    if (!['single', 'multiple', 'judge'].includes(q.type) || !Array.isArray(q.options) || !Array.isArray(q.answer)) {
      kept.push(q);
      continue;
    }
    const reply = await verifySolve(q, useFake);
    stats.checked += 1;
    if (reply == null) { stats.unresolved += 1; kept.push(q); continue; }
    const got = verifyParse(reply, q.options.length, q.type === 'multiple');
    if (got == null) { stats.unresolved += 1; kept.push(q); continue; }
    const want = (q.answer ?? []).map(Number);
    const same = got.length === want.length && got.every((x) => want.includes(x));
    if (same) { stats.passed += 1; kept.push(q); } else stats.dropped += 1;
  }
  const filteredRaw = parsed && kept.length > 0 ? `[QUIZ]${JSON.stringify({ title: parsed.title, questions: kept })}[/QUIZ]` : raw;
  return { ...stats, answersAfterOk: HARD_CHECKS.answers(filteredRaw).pass };
}

// ── LLM 裁判(可选,仅 quiz-gen/replicate):质量分 1..5 ──
async function judgeQuality(raw, material) {
  const prompt = `你是出题质量评审。给下面这份 AI 生成的题组 JSON 从三个维度各打 1-5 分(5 最好):
correctness(标注的答案在学科上确实正确)、clarity(题干清晰无歧义)、distractors(干扰项有迷惑性)。
只输出 JSON:{"correctness":n,"clarity":n,"distractors":n}

【背景材料】\n${material}\n\n【题组】\n${raw}`;
  try {
    const text = await llm(prompt, { temperature: 0 });
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    const ok = (v) => Number.isFinite(v) && v >= 1 && v <= 5;
    return j && ok(j.correctness) && ok(j.clarity) && ok(j.distractors) ? j : null;
  } catch {
    return null;
  }
}

// ── 自检 ──
function selftest() {
  loadQuizProtocol();
  loadTermsProtocol(); // 护栏:两份生产协议都还提取得到
  let failed = 0;
  console.log('── quiz-gen 评分器(坏夹具必须被抓)──');
  for (const fx of BROKEN_FIXTURES) {
    const kase = { ...FIXTURE_CASE, mix: { ...FIXTURE_CASE.mix, ...(fx.mix ?? {}) } };
    if (fx.mix) for (const t of Object.keys(kase.mix)) if (!(t in fx.mix)) kase.mix[t] = 0;
    const { checks } = gradeCase(fx.output, kase);
    const hit = checks[fx.mustFail] && !checks[fx.mustFail].pass;
    console.log(`${hit ? '✅' : '❌'} ${fx.name} → 期望 ${fx.mustFail} 变红`);
    if (!hit) failed += 1;
  }
  const good = fakeCompletion(FIXTURE_CASE);
  const allGreen = Object.values(gradeCase(good, FIXTURE_CASE).checks).every((c) => c.pass);
  console.log(`${allGreen ? '✅' : '❌'} 假模型好输出全绿`);
  if (!allGreen) failed += 1;
  console.log('── 复刻/联网/词条 评分器 ──');
  failed += selftestSuites();
  console.log(failed === 0 ? '\n自检全部通过' : `\n自检失败 ${failed} 条`);
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

  const wanted = opt('suite', 'all');
  const suiteNames = wanted === 'all' ? Object.keys(SUITES) : wanted.split(',').map((s) => s.trim());
  for (const n of suiteNames) if (!SUITES[n]) { console.error(`未知套件 ${n}(可选:${Object.keys(SUITES).join(', ')})`); process.exit(2); }

  const summary = [];
  const allResults = {};
  for (const name of suiteNames) {
    const suite = SUITES[name];
    let cases = readFileSync(join(HERE, 'datasets', suite.dataset), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    if (ONLY) cases = cases.filter((c) => c.id.startsWith(ONLY));
    if (cases.length === 0) continue;
    console.log(`\n══ 套件 ${name}(${cases.length} 例)| ${suite.用处} ══`);

    const results = await mapLimit(cases, useFake ? 8 : CONCURRENCY, async (kase) => {
      let raw = '';
      let error = null;
      try {
        raw = useFake ? suite.fake(kase) : await llm(suite.prompt(kase));
      } catch (e) {
        error = String(e.message ?? e);
      }
      const graded = suite.grade(raw, kase);
      let judge = null;
      if (flag('judge') && !useFake && !error && (name === 'quiz-gen' || name === 'replicate'))
        judge = await judgeQuality(raw, kase.material ?? kase.ref?.question ?? '');
      let verify = null;
      if (flag('verify') && name === 'quiz-gen' && !error) verify = await verifyQuizRaw(raw, useFake);
      const bad = Object.entries(graded.checks).filter(([, c]) => !c.pass).map(([n]) => n);
      console.log(
        `${error ? '💥' : graded.success ? '✅' : '❌'} ${kase.id}` +
          (graded.similarity != null ? ` 相似度=${graded.similarity.toFixed(2)}` : '') +
          (graded.f1 != null ? ` F1=${graded.f1.toFixed(2)}` : '') +
          (bad.length && !graded.success ? ` 红:${bad.join(',')}` : '') +
          (judge ? ` 裁判:${judge.correctness}/${judge.clarity}/${judge.distractors}` : '') +
          (verify ? ` 验算:${verify.passed}/${verify.checked}一致${verify.dropped ? `·拦${verify.dropped}` : ''}` : '') +
          (error ? ` ${error.slice(0, 60)}` : ''),
      );
      return { id: kase.id, error, raw, judge, verify, ...graded };
    });

    const agg = suite.aggregate(results);
    console.log(`── ${name}:${agg.headline}`);
    // 验算汇总(--verify):一致率/拦截/answers 红 before→after ——保险丝效果的正账
    const withV = results.filter((r) => r.verify);
    if (withV.length > 0) {
      const t = withV.reduce((a, r) => ({ checked: a.checked + r.verify.checked, passed: a.passed + r.verify.passed, dropped: a.dropped + r.verify.dropped, unresolved: a.unresolved + r.verify.unresolved }), { checked: 0, passed: 0, dropped: 0, unresolved: 0 });
      const redBefore = withV.filter((r) => r.checks.answers && !r.checks.answers.pass).length;
      const redAfter = withV.filter((r) => !r.verify.answersAfterOk).length;
      agg.verify = { ...t, answersRedBefore: redBefore, answersRedAfter: redAfter };
      agg.metrics['验算一致率'] = t.checked ? `${((t.passed / t.checked) * 100).toFixed(1)}%` : 'n/a';
      agg.metrics['验算拦截'] = `${t.dropped} 题(不可解 ${t.unresolved})`;
      agg.metrics['answers红 前→后'] = `${redBefore} → ${redAfter} 例`;
      console.log(`── 验算(--verify):一致率 ${agg.metrics['验算一致率']} · 拦截 ${t.dropped} 题 · answers 红 ${redBefore}→${redAfter} 例`);
    }
    summary.push({ name, n: results.length, ...agg });
    allResults[name] = results;
  }

  // ── 汇总 ──
  const overall = summary.reduce((a, s) => a + s.primary, 0) / (summary.length || 1);
  console.log('\n═══════════ 汇总 ═══════════');
  for (const s of summary) console.log(`${s.name.padEnd(10)} ${String(s.n).padStart(3)} 例  ${s.headline}`);
  console.log(`综合分(各套件主指标均值):${(overall * 100).toFixed(1)} / 100`);

  const tag = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${useFake ? 'fake' : MODEL.replace(/[^\w.-]/g, '_')}`;
  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${tag}.json`), JSON.stringify({ tag, model: useFake ? 'fake' : MODEL, overall, summary, results: allResults }, null, 2));

  const md = [
    `# eval 报告 · ${tag}`,
    '',
    `综合分:**${(overall * 100).toFixed(1)} / 100**(各套件主指标均值)`,
    '',
    '| 套件 | 样本 | 结果 |',
    '| --- | --- | --- |',
    ...summary.map((s) => `| ${s.name} | ${s.n} | ${Object.entries(s.metrics).map(([k, v]) => `${k} ${v}`).join(' · ')} |`),
    '',
    '## 未成功用例',
    '',
    ...Object.entries(allResults).flatMap(([name, rs]) =>
      rs.filter((r) => !r.success).map((r) => {
        const bad = Object.entries(r.checks).filter(([, c]) => !c.pass).map(([n, c]) => `${n}(${c.note ?? ''})`).join('、');
        return `- **${name}/${r.id}**:${r.error ? `调用失败 ${r.error}` : bad}`;
      }),
    ),
  ].join('\n');
  writeFileSync(join(outDir, `${tag}.md`), md + '\n');
  console.log(`报告:tools/eval/model-bench/results/${tag}.md(+.json)`);

  if (CHECK != null && overall < Number(CHECK)) {
    console.error(`综合分低于阈值 ${CHECK},退出码 1`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
