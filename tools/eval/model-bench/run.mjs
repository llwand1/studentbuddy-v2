#!/usr/bin/env node
/**
 * evals/run — 模型能力评测跑分器(零依赖,Node ≥ 22)。
 *
 * ── 自造数据集(离线,`--suite all` 的默认四件)──
 *   quiz-gen          从材料出题:协议服从性(40 例,含提示注入对抗)
 *   replicate         复刻手写原题:保真度 → 成功率 + 总体相似度(30 例)
 *   search            联网搜索出题:refs 引用溯源 → 引用命中率(15 例)
 *   terms             词条抽取:对金标 P/R/F1(25 例)
 *
 * ── 外部数据集(按需,要网络/要快照)──
 *   public-solve      公开学术集(MMLU/C-Eval)盲解 → **对金标正确率**(零裁判的学科水平)
 *   public-replicate  公开集真题复刻 → 保真度(比手写 ref 更像真实场景)
 *   live-replicate    **现场从网上搜来的真题**复刻 → 保真度(没被背过的题,见 harvest.mts)
 *
 * 用法:
 *   npm run eval:models -- --selftest                # 评分器自检(零 key 零网络)
 *   npm run eval:models -- --fake                    # 假模型验通路(应当全绿)
 *   EVAL_API_KEY=sk-x EVAL_MODEL=gpt-4o-mini npm run eval:models --            # 真模型全量
 *   ... --suite public --public-per-config 5         # 公开评测集(首次会联网拉取并缓存)
 *   ... --suite live-replicate --live harvests/xxx-free.json                   # 现场题复刻
 *   ... --stream                                     # 流式:多出**首 token 时延**(TTFT)
 *   ... --serial                                     # 串行:时延数字才可横向比(并发会污染 p50/p95)
 *   ... --only rep-00 --check 0.8 --judge --verify
 *
 * 产出:results/<tag>.json(逐用例逐检查 + 逐次调用的计量账)+ 同名 .md(汇总报告)。
 * 跨模型横评:多跑几个模型,然后 `npm run eval:compare -- results/a.json results/b.json`。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, buildReplicatePrompt, buildSearchPrompt, buildTermsPrompt, loadQuizProtocol, loadTermsProtocol } from './lib/protocol.mjs';
import { gradeCase, HARD_CHECKS, SOFT_CHECKS, tryParse } from './lib/graders.mjs';
import { fakeCompletion, BROKEN_FIXTURES, LEGIT_FIXTURES, FIXTURE_CASE } from './lib/fake-model.mjs';
import { replicateSuite, searchSuite, termsSuite, selftestSuites } from './lib/suites.mjs';
import { publicReplicateSuite, publicSolveSuite, selftestPublicSuites } from './lib/public-suites.mjs';
import { loadPublicItems, toReplicateCase, toSolveCase, verifyCevalPointers } from './lib/public-sets.mjs';
import { selftestHarvest, toLiveCase } from './lib/harvest-lib.mjs';
import { assertMirrorsProduction, buildSolvePrompt, parseAnswerSet, sameAnswerSet } from './lib/solver.mjs';
import { chat, fakeSample } from './lib/client.mjs';
import { costPerPoint, fmtLatency, fmtMs, summarizeCost, summarizeLatency } from '../lib/meter.mjs';
import { fmtUsd, priceProvenance } from '../lib/pricing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ── 参数 ──
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const CHECK = opt('check', null);
const ONLY = opt('only', null);
const SERIAL = flag('serial');
const CONCURRENCY = SERIAL ? 1 : Number(opt('concurrency', '3'));

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

/** 读本目录 datasets/ 下的一份 jsonl */
const readLocal = (name) => () =>
  readFileSync(join(HERE, 'datasets', name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

/** 公开集只拉一次,两个套件共用(同一批条目,一次网络) */
let publicCache = null;
async function publicItems() {
  if (publicCache) return publicCache;
  const sources = opt('public-sources', 'mmlu,ceval').split(',').map((s) => s.trim()).filter(Boolean);
  const { items, report } = await loadPublicItems({
    sources,
    perConfig: Number(opt('public-per-config', '5')),
    offset: Number(opt('public-offset', '0')),
    offline: flag('public-offline'),
    refresh: flag('refresh'),
  });
  const pointers = verifyCevalPointers(items);
  publicCache = { items, report, pointers };
  const lines = Object.entries(report.sources).map(([k, v]) => `${k} ${v.got} 条(${v.license})`);
  console.log(`\n公开集:${lines.join('　')}　| 每 config ${report.perConfig} 条,offset ${report.offset}${report.offline ? '　| 离线(缓存/冻结件)' : ''}`);
  // 某个源取到 0 条时必须说出原因 —— 静默少一半样本是最坏的一种「有数」
  for (const [k, v] of Object.entries(report.sources))
    for (const note of v.notes ?? []) console.log(`   ⚠ ${k}/${note}`);
  if (pointers.mismatched.length > 0)
    console.log(`⚠️ C-Eval 指纹对不上 ${pointers.mismatched.length} 条 —— 上游数据集变过,本轮的题与当初登记的**不是同一批**`);
  return publicCache;
}

const SUITES = {
  'quiz-gen': { ...quizGenSuite, load: readLocal('quiz-gen.jsonl'), prompt: buildPrompt, 用处: '从材料出题的协议服从性(对话出题/知识大陆挑战/对战的共同地基)' },
  replicate: { ...replicateSuite, load: readLocal('quiz-replicate.jsonl'), prompt: buildReplicatePrompt, 用处: '复刻手写原题保真度(考点与答案不许跑)' },
  search: { ...searchSuite, load: readLocal('quiz-search.jsonl'), prompt: buildSearchPrompt, 用处: '联网出题的 refs 引用溯源(引对资料=可信度,引错比不引更糟)' },
  terms: { ...termsSuite, load: readLocal('term-extract.jsonl'), prompt: buildTermsPrompt, 用处: '词条抽取质量(词条是产品主体,抽错=学练忆全歪)' },

  'public-solve': {
    ...publicSolveSuite,
    load: async () => (await publicItems()).items.map(toSolveCase),
    prompt: publicSolveSuite.prompt,
    用处: '公开学术集盲解正确率(零裁判的学科水平上界;也是 quiz-verify 那道保险丝的能力天花板)',
    external: true,
  },
  'public-replicate': {
    ...publicReplicateSuite,
    load: async () => (await publicItems()).items.map(toReplicateCase),
    prompt: buildReplicatePrompt,
    用处: '公开集真题的复刻保真度(真题有长题干/LaTeX/"以下说法正确的是",比手写 ref 难)',
    external: true,
  },
  'live-replicate': {
    ...replicateSuite,
    load: () => {
      const file = opt('live', null);
      if (!file) throw new Error('live-replicate 需要 --live <harvests/xxx.json>(先跑 `npm run eval:harvest`)');
      const snap = JSON.parse(readFileSync(file, 'utf8'));
      if (snap.kind !== 'harvest-snapshot') throw new Error(`${file} 不是采集快照`);
      console.log(
        `\n现场题快照:${snap.items.length} 道　通道 ${snap.channel}(${(snap.providers ?? []).join('、') || '无'})　` +
          `抽题器 ${snap.extractor}　采于 ${String(snap.startedAt).slice(0, 16)}`,
      );
      if (snap.extractor && snap.extractor === (process.env.EVAL_MODEL ?? ''))
        console.log('⚠️ 抽题器与被测模型是同一只 —— 自产自销,复刻分会偏高。换 EVAL_EXTRACT_MODEL 重采一份再读这个数。');
      return snap.items.map(toLiveCase);
    },
    prompt: buildReplicatePrompt,
    用处: '**现场从网上搜来的真题**复刻保真度(没被背过的题,公开集测不到这一面)',
    external: true,
  },
};

/** `all` 保持原样 = 四个自造套件(README 的「110 样本」口径不变);外部套件按需显式指定 */
const DEFAULT_SUITES = ['quiz-gen', 'replicate', 'search', 'terms'];
const SUITE_ALIASES = { all: DEFAULT_SUITES, public: ['public-solve', 'public-replicate'], live: ['live-replicate'] };

// ── 真模型调用(计量走 lib/client.mjs)──
const API_BASE = process.env.EVAL_API_BASE || 'https://api.openai.com/v1';
const API_KEY = process.env.EVAL_API_KEY || '';
const MODEL = process.env.EVAL_MODEL || '';
const CLIENT = {
  apiBase: API_BASE,
  apiKey: API_KEY,
  model: MODEL,
  retries: Number(opt('retries', '5')),
  stream: flag('stream'),
  estimateTokens: flag('estimate-tokens'),
};
const TEMPERATURE = Number(opt('temperature', '0.3'));
const MAX_TOKENS = Number(opt('max-tokens', '4096'));

/** 每一次真调的账都进这里(主调用与裁判/验算分开记:它们烧的是不同的钱) */
const SAMPLES = { main: [], judge: [], verify: [] };

async function llm(prompt, o = {}) {
  const { text, sample } = await chat(CLIENT, prompt, { temperature: TEMPERATURE, maxTokens: MAX_TOKENS, ...o });
  (o.bucket ? SAMPLES[o.bucket] : SAMPLES.main).push(sample);
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

// ── 盲解验算(--verify,量产品保险丝 quiz-verify.ts 的效果,issue #71)──
//
// ★ 解析与提示词已收进 `lib/solver.mjs`(生产 quiz-verify.ts 的唯一镜像,带漂移护栏)。
//   本文件此前手抄过一份 V_LETTERS/verifyParse —— 那是第三处双写,现已删除。
async function verifySolve(q, useFake) {
  if (useFake) return (q.answer ?? []).map((i) => 'ABCDEF'[i] ?? '').join(''); // 假模式=理想 solver,验通路
  try {
    // maxTokens 512 不是浪费:agnes/gemini 系有隐藏思考 token,给 16 会把答案截成空串(真机踩坑)
    return await llm(buildSolvePrompt({ question: q.question, options: q.options ?? [], multiple: q.type === 'multiple' }), {
      temperature: 0,
      maxTokens: 512,
      bucket: 'verify',
    });
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
    const got = parseAnswerSet(reply, q.options.length, q.type === 'multiple');
    if (got == null) { stats.unresolved += 1; kept.push(q); continue; }
    if (sameAnswerSet(got, (q.answer ?? []).map(Number))) { stats.passed += 1; kept.push(q); } else stats.dropped += 1;
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
    const text = await llm(prompt, { temperature: 0, bucket: 'judge' });
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

  // ★ 反方向:合法输出**不许被误杀**(见 fake-model.mjs 的 LEGIT_FIXTURES 头注)
  console.log('── 反方向:合法输出必须放行(评分器过严同样是缺陷)──');
  for (const fx of LEGIT_FIXTURES) {
    const { checks } = gradeCase(fx.output, FIXTURE_CASE);
    const c = checks[fx.mustPass];
    const ok = c && c.pass;
    console.log(`${ok ? '✅' : '❌'} ${fx.name} → ${fx.mustPass} 必须放行${ok ? '' : `（实际红了：${c?.note ?? '无此检查'}）`}`);
    if (!ok) failed += 1;
  }

  console.log('── 复刻/联网/词条 评分器 ──');
  failed += selftestSuites();

  console.log('── 盲解口径:与生产 quiz-verify.ts 的漂移护栏 ──');
  const drift = assertMirrorsProduction();
  for (const d of drift) console.log(`❌ ${d}`);
  if (drift.length === 0) console.log('✅ solver.mjs 与生产 quiz-verify.ts 一致(问法/字母表/矛盾规则)');
  failed += drift.length;

  console.log('── 公开评测集套件 ──');
  failed += selftestPublicSuites();

  console.log('── 现场搜题:质检与快照对比 ──');
  failed += selftestHarvest();

  console.log('── 计量与价表 ──');
  failed += selftestMeter();

  console.log(failed === 0 ? '\n自检全部通过' : `\n自检失败 ${failed} 条`);
  process.exit(failed === 0 ? 0 : 1);
}

/** 计量口径的自检:每一条都对应一种会读出假数字的错法 */
function selftestMeter() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '✅' : '❌'} ${name}`);
    if (!cond) failed += 1;
  };
  const m = { pctl: null };
  void m;
  const lat = summarizeLatency([{ latencyMs: 100 }, { latencyMs: 300 }, { latencyMs: 200 }], { concurrency: 3 });
  check('时延:p50 取真实观测(200,不插值)', lat.total.p50 === 200);
  check('时延:max 正确', lat.total.max === 300);
  check('时延:并发数照实带进结果(读的人才知道这个 p50 能不能横向比)', lat.concurrency === 3);
  check('时延:非流式下 TTFT 为 null 而不是 0', lat.ttft === null);

  const cost = summarizeCost([
    { usage: { promptTokens: 100, completionTokens: 50, source: 'api' }, costUsd: 0.001 },
    { usage: null, costUsd: null },
    { usage: { promptTokens: 10, completionTokens: 5, source: 'estimated' }, costUsd: 0.0001 },
  ]);
  check('成本:token 来源分档不合并(api 1 / estimated 1 / none 1)', cost.bySource.api === 1 && cost.bySource.estimated === 1 && cost.bySource.none === 1);
  check('成本:分档之和 = 样本数(口径没漏形状)', Object.values(cost.bySource).reduce((a, b) => a + b, 0) === cost.cases);
  check('成本:costedCases 单独计数(没有 usage 的不进分母)', cost.costedCases === 2);
  check('每分成本:0 分时返回 null 而不是 Infinity', costPerPoint(0.01, 0) === null);
  check('每分成本:算得对', Math.abs(costPerPoint(1, 0.5) - 0.02) < 1e-12);
  check('金额:小额不被四舍五入成 $0.00(那会读成免费)', fmtUsd(0.000012) === '$0.000012');
  check('金额:未知成本显示 — 而不是 $0', fmtUsd(null) === '—');
  check('价表:未知模型查不到价(成本记 —,不记 0)', priceProvenance('完全不存在的模型-x').includes('价表无'));
  check('价表:已知模型带出处与抄录日期', /出处 http/.test(priceProvenance('gpt-4o-mini')));
  return failed;
}

// ── 报告头:七项可复现信息 ──
function gitSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: HERE, encoding: 'utf8' }).trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

function runHeader(useFake) {
  let host = API_BASE;
  try { host = new URL(API_BASE).host; } catch { /* 原样 */ }
  return {
    model: useFake ? 'fake' : MODEL,
    apiHost: useFake ? '(无)' : host,
    gitSha: gitSha(),
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    // 本台不传 seed —— 照实写 null,不编一个出来(采样不可复现是事实,遮住它才是问题)
    seed: null,
    concurrency: CONCURRENCY,
    serial: SERIAL,
    stream: CLIENT.stream,
    estimateTokens: CLIENT.estimateTokens,
    startedAt: new Date().toISOString(),
  };
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
  const suiteNames = [...new Set(wanted.split(',').flatMap((s) => SUITE_ALIASES[s.trim()] ?? [s.trim()]))];
  for (const n of suiteNames)
    if (!SUITES[n]) { console.error(`未知套件 ${n}(可选:${Object.keys(SUITES).join(', ')};别名:${Object.keys(SUITE_ALIASES).join(', ')})`); process.exit(2); }

  const header = runHeader(useFake);
  console.log(
    `模型 ${header.model}　端点 ${header.apiHost}　git ${header.gitSha ?? '(非仓库)'}　` +
      `温度 ${header.temperature}　max_tokens ${header.maxTokens}　种子 未设　` +
      `${header.serial ? '串行' : `并发 ${header.concurrency}`}　${header.stream ? '流式(可量 TTFT)' : '非流式(TTFT 量不到)'}`,
  );
  if (!useFake) console.log(priceProvenance(MODEL));

  const summary = [];
  const allResults = {};
  for (const name of suiteNames) {
    const suite = SUITES[name];
    let cases;
    try {
      cases = await suite.load();
    } catch (e) {
      console.error(`\n✗ 套件 ${name} 取数失败:${String(e.message ?? e)}`);
      process.exit(2);
    }
    if (ONLY) cases = cases.filter((c) => c.id.startsWith(ONLY));
    if (cases.length === 0) continue;
    console.log(`\n══ 套件 ${name}(${cases.length} 例)| ${suite.用处} ══`);

    const before = SAMPLES.main.length;
    const results = await mapLimit(cases, useFake ? 8 : CONCURRENCY, async (kase) => {
      let raw = '';
      let error = null;
      let sample = null;
      try {
        if (useFake) {
          raw = suite.fake(kase);
          sample = fakeSample(suite.prompt(kase), raw);
          SAMPLES.main.push(sample);
        } else {
          const prompt = suite.prompt(kase);
          const out = await chat(CLIENT, prompt, { temperature: TEMPERATURE, maxTokens: MAX_TOKENS });
          raw = out.text;
          sample = out.sample;
          SAMPLES.main.push(sample);
        }
      } catch (e) {
        error = String(e.message ?? e);
        // ★ 失败的调用也有账(烧掉的时间与重试次数)——不记就会让「这模型又慢又爱失败」看起来只是慢
        if (e?.sample) { sample = e.sample; SAMPLES.main.push(sample); }
      }
      const graded = suite.grade(raw, kase);
      let judge = null;
      if (flag('judge') && !useFake && !error && (name === 'quiz-gen' || name === 'replicate' || name === 'public-replicate'))
        judge = await judgeQuality(raw, kase.material ?? kase.ref?.question ?? '');
      let verify = null;
      if (flag('verify') && name === 'quiz-gen' && !error) verify = await verifyQuizRaw(raw, useFake);
      const bad = Object.entries(graded.checks).filter(([, c]) => !c.pass).map(([n]) => n);
      console.log(
        `${error ? '💥' : graded.success ? '✅' : '❌'} ${kase.id}` +
          (graded.similarity != null ? ` 相似度=${graded.similarity.toFixed(2)}` : '') +
          (graded.f1 != null ? ` F1=${graded.f1.toFixed(2)}` : '') +
          (sample?.latencyMs != null ? ` ${fmtMs(sample.latencyMs)}` : '') +
          (sample?.ttftMs != null ? `(首字 ${fmtMs(sample.ttftMs)})` : '') +
          (sample?.costUsd != null ? ` ${fmtUsd(sample.costUsd)}` : '') +
          (bad.length && !graded.success ? ` 红:${bad.join(',')}` : '') +
          (judge ? ` 裁判:${judge.correctness}/${judge.clarity}/${judge.distractors}` : '') +
          (verify ? ` 验算:${verify.passed}/${verify.checked}一致${verify.dropped ? `·拦${verify.dropped}` : ''}` : '') +
          (error ? ` ${error.slice(0, 60)}` : ''),
      );
      return { id: kase.id, error, raw, judge, verify, sample, ...graded };
    });

    const agg = suite.aggregate(results);
    console.log(`── ${name}:${agg.headline}`);

    // 本套件自己的计量账(用本轮新增的那些 sample)
    const mine = SAMPLES.main.slice(before);
    agg.latency = summarizeLatency(mine, { concurrency: useFake ? null : CONCURRENCY });
    agg.cost = summarizeCost(mine);
    agg.costPerPoint = costPerPoint(agg.cost.costedCases > 0 ? agg.cost.costUsd : NaN, agg.primary);
    if (agg.latency.total)
      console.log(
        `   时延 ${fmtLatency(agg.latency.total)}${agg.latency.ttft ? `　首字 ${fmtLatency(agg.latency.ttft)}` : ''}` +
          `　成本 ${agg.cost.costedCases > 0 ? `${fmtUsd(agg.cost.costUsd)}(${agg.cost.costedCases}/${agg.cost.cases} 例有 usage)` : '—(无 usage)'}`,
      );

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
  const allSamples = [...SAMPLES.main, ...SAMPLES.judge, ...SAMPLES.verify];
  const totalLatency = summarizeLatency(SAMPLES.main, { concurrency: useFake ? null : CONCURRENCY });
  const totalCost = summarizeCost(allSamples);
  const mainCost = summarizeCost(SAMPLES.main);
  const sideCost = summarizeCost([...SAMPLES.judge, ...SAMPLES.verify]);
  const overallCostPerPoint = costPerPoint(mainCost.costedCases > 0 ? mainCost.costUsd : NaN, overall);

  console.log('\n═══════════ 汇总 ═══════════');
  for (const s of summary) console.log(`${s.name.padEnd(17)} ${String(s.n).padStart(3)} 例  ${s.headline}`);
  console.log(`综合分(各套件主指标均值):${(overall * 100).toFixed(1)} / 100`);
  // 并发警示只在**真的测到了时延**时才有意义:假模型压根没发请求,那条 ⚠ 会让人以为量过
  const concWarn = totalLatency.total && !SERIAL ? `　⚠ 并发 ${CONCURRENCY} 下测得,不可与串行数横向比` : '';
  console.log(`时延(主调用)${totalLatency.total ? ` ${fmtLatency(totalLatency.total)}` : ' —(本轮没有真调)'}${totalLatency.ttft ? `　首字 ${fmtLatency(totalLatency.ttft)}` : ''}${concWarn}`);
  if (totalCost.costedCases > 0) {
    console.log(
      `成本 ${fmtUsd(totalCost.costUsd)}(正题 ${fmtUsd(mainCost.costUsd)}${sideCost.costedCases ? ` + 裁判/验算 ${fmtUsd(sideCost.costUsd)}` : ''})　` +
        `覆盖 ${totalCost.costedCases}/${totalCost.cases} 次调用　token in ${totalCost.promptTokens} / out ${totalCost.completionTokens}` +
        `${totalCost.reasoningTokens ? `(其中隐藏思考 ${totalCost.reasoningTokens})` : ''}`,
    );
    console.log(`每分成本(正题):${overallCostPerPoint != null ? fmtUsd(overallCostPerPoint) : '—'} / 分　${mainCost.cases ? `每例 ${fmtUsd(mainCost.costUsd / mainCost.costedCases)}` : ''}`);
  } else {
    console.log(`成本 —(本轮 ${totalCost.cases} 次调用一次 usage 都没拿到${CLIENT.estimateTokens ? '' : ';加 --estimate-tokens 可按字符估个量级'})`);
  }

  const tag = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${useFake ? 'fake' : MODEL.replace(/[^\w.-]/g, '_')}`;
  const outDir = join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  const payload = {
    tag,
    kind: 'model-bench-result',
    version: 2,
    header,
    public: publicCache ? { report: publicCache.report, pointers: publicCache.pointers } : null,
    overall,
    latency: totalLatency,
    cost: { total: totalCost, main: mainCost, side: sideCost, perPoint: overallCostPerPoint },
    summary,
    results: allResults,
  };
  writeFileSync(join(outDir, `${tag}.json`), JSON.stringify(payload, null, 2));
  writeFileSync(join(outDir, `${tag}.md`), renderReport(payload) + '\n');
  console.log(`\n报告:tools/eval/model-bench/results/${tag}.md(+.json)`);
  console.log(`横评:npm run eval:compare -- results/${tag}.json results/<另一个模型>.json`);

  if (CHECK != null && overall < Number(CHECK)) {
    console.error(`综合分低于阈值 ${CHECK},退出码 1`);
    process.exit(1);
  }
}

/** 报告 markdown(质量 / 延迟 / 成本 三段并列 —— 三个数一起看才能拍板) */
function renderReport(p) {
  const h = p.header;
  const c = p.cost.total;
  const srcRow = Object.entries(c.bySource).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(' · ');
  const lines = [
    `# eval 报告 · ${p.tag}`,
    '',
    '## 这一轮是怎么跑的(可复现七项)',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    `| 被测模型 | \`${h.model}\` @ ${h.apiHost} |`,
    `| 代码版本 | ${h.gitSha ?? '—(非 git 仓库)'} |`,
    `| 采样 | temperature ${h.temperature}／max_tokens ${h.maxTokens}／seed ${h.seed ?? '**未设**(本台不传 seed，采样不可逐字复现)'} |`,
    `| 并发 | ${h.serial ? '串行(时延可横向比)' : `${h.concurrency} ⚠ 时延受并发影响，不可与串行数比大小`} |`,
    `| 传输 | ${h.stream ? '流式(TTFT 可测)' : '非流式(**TTFT 量不到**，报告里记 —)'} |`,
    `| token 来源 | ${srcRow || '无'}${h.estimateTokens ? '（已开 --estimate-tokens：estimated 档是字符估算，不是实测）' : ''} |`,
    `| 价表 | ${h.model === 'fake' ? '—(假模型)' : priceProvenance(h.model)} |`,
    `| 起跑时刻 | ${h.startedAt} |`,
    '',
    `综合分:**${(p.overall * 100).toFixed(1)} / 100**(各套件主指标均值)`,
    '',
    '## 质量 × 延迟 × 成本',
    '',
    '| 套件 | 样本 | 质量 | 时延 p50／p95 | 首字 p50 | 成本(有 usage 的例数) | 每分成本 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...p.summary.map((s) => {
      const lat = s.latency?.total ? `${fmtMs(s.latency.total.p50)}／${fmtMs(s.latency.total.p95)}` : '—';
      const ttft = s.latency?.ttft ? fmtMs(s.latency.ttft.p50) : '—';
      const cost = s.cost?.costedCases > 0 ? `${fmtUsd(s.cost.costUsd)}（${s.cost.costedCases}/${s.cost.cases}）` : '—';
      return `| ${s.name} | ${s.n} | ${Object.entries(s.metrics).map(([k, v]) => `${k} ${v}`).join('<br>')} | ${lat} | ${ttft} | ${cost} | ${s.costPerPoint != null ? fmtUsd(s.costPerPoint) : '—'} |`;
    }),
    '',
    '### 全轮合计',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    `| 主调用时延 | ${fmtLatency(p.latency.total)} |`,
    `| 首 token 时延 | ${p.latency.ttft ? fmtLatency(p.latency.ttft) : '—（非流式，量不到；不是 0）'} |`,
    `| 总成本 | ${c.costedCases > 0 ? `${fmtUsd(c.costUsd)}（覆盖 ${c.costedCases}/${c.cases} 次调用）` : '—（一次 usage 都没拿到）'} |`,
    `| ├ 正题 | ${p.cost.main.costedCases > 0 ? fmtUsd(p.cost.main.costUsd) : '—'} |`,
    `| └ 裁判／验算 | ${p.cost.side.costedCases > 0 ? fmtUsd(p.cost.side.costUsd) : '—'} |`,
    `| token | in ${c.promptTokens}／out ${c.completionTokens}${c.reasoningTokens ? `（其中隐藏思考 **${c.reasoningTokens}**）` : ''}${c.cachedTokens ? `／命中缓存 ${c.cachedTokens}` : ''} |`,
    `| 字符 | in ${c.promptChars}／out ${c.outputChars} |`,
    `| **每分成本** | ${p.cost.perPoint != null ? `${fmtUsd(p.cost.perPoint)} / 分` : '—'} |`,
    '',
  ];
  if (p.public) {
    const ptr = p.public.pointers;
    lines.push(
      '### 公开评测集出处',
      '',
      ...Object.entries(p.public.report.sources).map(([k, v]) => `- \`${k}\` ${v.got} 条　许可 ${v.license}　${v.homepage}`),
      `- C-Eval 指纹校验：${ptr.checked ? `${ptr.matched}/${ptr.checked} 一致${ptr.mismatched.length ? `，**${ptr.mismatched.length} 条对不上**（上游数据集变过）` : ''}` : '—（仓内无指针文件）'}`,
      '- ⚠ 公开集大概率已在被测模型的训练数据里：正确率读作「记不记得住」的**上界**，不是「在你的新题上多准」。要看后者请跑 `live-replicate`。',
      '',
    );
  }
  lines.push(
    '## 未成功用例',
    '',
    ...Object.entries(p.results).flatMap(([name, rs]) =>
      rs.filter((r) => !r.success).map((r) => {
        const bad = Object.entries(r.checks).filter(([, c2]) => !c2.pass).map(([n, c2]) => `${n}(${c2.note ?? ''})`).join('、');
        return `- **${name}/${r.id}**:${r.error ? `调用失败 ${r.error}` : bad}`;
      }),
    ),
  );
  return lines.join('\n');
}

void SOFT_CHECKS; // 由 graders.gradeCase 内部使用,这里只保留 import 的可见性

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
