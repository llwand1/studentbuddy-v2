#!/usr/bin/env node
/**
 * model-bench/compare —— 横评与稳定性对比(`npm run eval:compare`)。
 *
 * 两种用法:
 *   npm run eval:compare -- results/a.json results/b.json [...]   # 跨模型横评 → 质量×延迟×成本一张表
 *   npm run eval:compare -- --harvest h1.json h2.json             # 两次现场采集的稳定性(免 key vs 带 key)
 *   ... --doc                                                     # 顺手把横评表写进 docs/eval/model-bench.md
 *
 * ══ 这个文件最重要的东西不是排行榜,是**可比性护栏** ══
 *
 * 跑分报告堆在一起排个序是五行代码的事,而这五行代码会稳定地骗人:
 *   · 并发 3 测的 p50 和串行测的 p50 放一张表里比大小 —— 没有意义;
 *   · 一边开了流式一边没开 —— TTFT 一栏一个有数一个空,读的人会以为后者是 0;
 *   · 两次跑的套件集不同 —— 综合分是「各套件主指标均值」,套件不同分母就不同;
 *   · 公开集 offset 不同 —— 那根本是两批题;
 *   · git sha 不同 —— 评分口径本身可能改过,分数差里混着「改了尺子」。
 * ⇒ `comparabilityWarnings()` 把这些逐条挑出来,**排在表格前面**。宁可先说不能比,也不给一张
 *   看起来很清楚的错表。这与 `render.mts` 的「分母为 0 写 —(无分母),绝不写 0%」是同一条原则。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareHarvests } from './lib/harvest-lib.mjs';
import { fmtLatency, fmtMs } from '../lib/meter.mjs';
import { fmtUsd } from '../lib/pricing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DOC = join(REPO, 'docs', 'eval', 'model-bench.md');

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--'));
const flag = (n) => argv.includes(`--${n}`);

const readJson = (f) => JSON.parse(readFileSync(resolve(process.cwd(), f), 'utf8'));

// ════════════════════════ 可比性护栏 ════════════════════════

/**
 * 逐项比对各轮的运行条件,不一致的挑出来并说明**哪一栏因此不能读**。
 * @returns {Array<{ level: '⛔'|'⚠', what: string, detail: string }>}
 */
export function comparabilityWarnings(runs) {
  const out = [];
  const uniq = (fn) => [...new Set(runs.map(fn).map((v) => JSON.stringify(v)))];
  const show = (fn) => uniq(fn).map((v) => JSON.parse(v)).join(' vs ');

  if (uniq((r) => r.header?.serial ? 'serial' : r.header?.concurrency).length > 1)
    out.push({
      level: '⛔',
      what: '时延栏不可比',
      detail: `各轮并发不同(${runs.map((r) => (r.header?.serial ? '串行' : `并发${r.header?.concurrency}`)).join(' vs ')})。并发下的 p50/p95 含排队时间。要比时延请各轮都加 --serial 重跑。`,
    });
  if (uniq((r) => !!r.header?.stream).length > 1)
    out.push({
      level: '⛔',
      what: '首字栏不可比',
      detail: '有的轮开了流式、有的没开。非流式**量不到** TTFT，那一栏的「—」是「没测」不是「很快」。',
    });
  const suiteSets = uniq((r) => (r.summary ?? []).map((s) => s.name).sort());
  if (suiteSets.length > 1)
    out.push({
      level: '⛔',
      what: '综合分不可比',
      detail: `各轮跑的套件集不同(${suiteSets.map((s) => JSON.parse(s).join('+')).join(' vs ')})。综合分是各套件主指标的均值，套件不同就是两个不同的数。只能逐套件比。`,
    });
  if (uniq((r) => [r.header?.temperature, r.header?.maxTokens]).length > 1)
    out.push({ level: '⚠', what: '采样参数不同', detail: `temperature／max_tokens: ${show((r) => [r.header?.temperature, r.header?.maxTokens])}` });
  if (uniq((r) => r.header?.gitSha).length > 1)
    out.push({
      level: '⚠',
      what: '评分代码版本不同',
      detail: `git ${show((r) => r.header?.gitSha)}。分数差里可能混着「改了尺子」，不全是模型差异。`,
    });
  if (runs.some((r) => String(r.header?.gitSha ?? '').endsWith('-dirty')))
    out.push({ level: '⚠', what: '有未提交改动', detail: '至少一轮跑在 dirty 工作区上，那一轮的代码版本无法被别人还原。' });
  const pubOffsets = uniq((r) => (r.public ? [r.public.report?.offset, r.public.report?.perConfig, Object.keys(r.public.report?.sources ?? {})] : null));
  if (pubOffsets.length > 1 && runs.some((r) => r.public))
    out.push({ level: '⛔', what: '公开集不是同一批题', detail: '各轮的 offset／perConfig／源不一致 —— 那是两个数据集，分数不可比。' });
  if (runs.some((r) => (r.cost?.total?.bySource?.estimated ?? 0) > 0))
    out.push({ level: '⚠', what: '成本含估算', detail: '至少一轮的 token 是字符估算(--estimate-tokens)得来的，误差 ±25%，只能读量级。' });
  if (runs.some((r) => (r.cost?.total?.costedCases ?? 0) === 0))
    out.push({ level: '⚠', what: '有轮次没有成本', detail: '至少一轮一次 usage 都没拿到（上游不回 usage）。那一栏的「—」是未知，不是免费。' });
  const covered = runs.filter((r) => r.cost?.total?.cases > 0).map((r) => (r.cost.total.costedCases / r.cost.total.cases));
  if (covered.length > 1 && Math.max(...covered) - Math.min(...covered) > 0.2)
    out.push({ level: '⚠', what: '成本覆盖率差得多', detail: '各轮拿到 usage 的调用占比相差 >20pt，总成本不是同口径的总账。' });
  return out;
}

// ════════════════════════ 横评表 ════════════════════════

function suiteNames(runs) {
  const names = [];
  for (const r of runs) for (const s of r.summary ?? []) if (!names.includes(s.name)) names.push(s.name);
  return names;
}

/**
 * 帕累托判定:在**质量、成本、时延三个维度上同时不优于**别人的,标出来。
 * 这是横评真正要输出的结论 —— 排名第一往往贵得离谱，而「谁被谁全面压制」可以直接删候选。
 *
 * ★ 时延必须进这个判定。第一版只比质量与成本,于是把一个「分低一点、贵一点、但 p50 快 2.7s」
 *   的模型标成了「全面压制」——那是一句**错话**:它在时延这一维上赢着。
 *   慢而便宜 vs 快而贵是真实取舍,不是支配关系,评测台没有资格替人拍这一板。
 * ★ 三个维度里只要有一个**量不到**(成本 null / 时延 null),就不参与判定:
 *   拿未知当成"不劣"会凭空造出支配关系。
 */
function dominated(rows) {
  const out = new Map();
  const comparable = (r) => r.costPerCase != null && r.p50 != null;
  for (const a of rows) {
    if (!comparable(a)) continue;
    const by = rows.find(
      (b) =>
        b !== a &&
        comparable(b) &&
        b.overall >= a.overall &&
        b.costPerCase <= a.costPerCase &&
        b.p50 <= a.p50 &&
        (b.overall > a.overall || b.costPerCase < a.costPerCase || b.p50 < a.p50),
    );
    if (by) out.set(a.tag, by.model);
  }
  return out;
}

function renderCompare(runs) {
  const warn = comparabilityWarnings(runs);
  const names = suiteNames(runs);
  const rows = runs.map((r) => {
    const cost = r.cost?.total;
    const costPerCase = cost?.costedCases > 0 ? cost.costUsd / cost.costedCases : null;
    return {
      tag: r.tag,
      model: r.header?.model ?? '(未知)',
      sha: r.header?.gitSha ?? '—',
      overall: r.overall ?? 0,
      p50: r.latency?.total?.p50 ?? null,
      p95: r.latency?.total?.p95 ?? null,
      ttft: r.latency?.ttft?.p50 ?? null,
      costUsd: cost?.costedCases > 0 ? cost.costUsd : null,
      costPerCase,
      perPoint: r.cost?.perPoint ?? null,
      bySuite: Object.fromEntries((r.summary ?? []).map((s) => [s.name, s.primary])),
      calls: cost?.cases ?? 0,
    };
  });
  rows.sort((a, b) => b.overall - a.overall);
  const dom = dominated(rows);

  const lines = [];
  lines.push(`> 本块由 \`npm run eval:compare\` 生成于 ${new Date().toISOString().slice(0, 10)}，对比 ${runs.length} 轮跑分。`);
  lines.push('');

  if (warn.length > 0) {
    lines.push('### ⚠ 先读这个：哪些栏不能横向比');
    lines.push('');
    lines.push('| | 影响 | 为什么 |');
    lines.push('| --- | --- | --- |');
    for (const w of warn) lines.push(`| ${w.level} | ${w.what} | ${w.detail} |`);
    lines.push('');
  } else {
    lines.push('各轮运行条件一致（并发／流式／套件集／采样参数／代码版本），整张表可横向读。');
    lines.push('');
  }

  lines.push('### 质量 × 延迟 × 成本');
  lines.push('');
  lines.push(`| 模型 | 综合分 | ${names.join(' | ')} | p50 | p95 | 首字 p50 | 每例成本 | 每分成本 | 结论 |`);
  lines.push(`| --- | --- | ${names.map(() => '---').join(' | ')} | --- | --- | --- | --- | --- | --- |`);
  for (const r of rows) {
    const verdict = dom.has(r.tag) ? `被 \`${dom.get(r.tag)}\` 帕累托支配（质量·成本·时延三维全不占优）` : r === rows[0] ? '质量第一' : '';
    lines.push(
      `| \`${r.model}\`<br><sub>${r.sha}</sub> | **${(r.overall * 100).toFixed(1)}** | ` +
        names.map((n) => (r.bySuite[n] == null ? '—' : (r.bySuite[n] * 100).toFixed(1))).join(' | ') +
        ` | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${r.ttft == null ? '—' : fmtMs(r.ttft)} | ` +
        `${r.costPerCase == null ? '—' : fmtUsd(r.costPerCase)} | ${r.perPoint == null ? '—' : fmtUsd(r.perPoint)} | ${verdict} |`,
    );
  }
  lines.push('');
  lines.push('读法：**每分成本**（跑完一轮、每拿到 1 分质量分花多少钱）是换模型时唯一该看的那一列 ——');
  lines.push('总成本单看会选出一个又便宜又不能用的；质量单看会选出一个用不起的。「—」一律是**未知**，不是 0。');
  return lines.join('\n');
}

/** 写进 docs/eval/model-bench.md 的标记区块;标记之外的手写内容原样保留(同 run.mts 的 writeDoc 纪律) */
function writeDoc(block) {
  const BEGIN = '<!-- eval:model-bench:begin -->';
  const END = '<!-- eval:model-bench:end -->';
  const wrapped = `${BEGIN}\n${block}\n${END}`;
  mkdirSync(dirname(DOC), { recursive: true });
  const prev = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
  const next =
    prev.includes(BEGIN) && prev.includes(END)
      ? prev.replace(new RegExp(`${BEGIN}[\\s\\S]*${END}`), () => wrapped)
      : `${prev.trimEnd()}${prev ? '\n\n' : ''}${wrapped}\n`;
  writeFileSync(DOC, next, 'utf8');
  console.log(`\n横评表已写入 docs/eval/model-bench.md`);
}

// ════════════════════════ 采集稳定性 ════════════════════════

function renderHarvest(a, b) {
  const c = compareHarvests(a, b);
  const row = (s, name) =>
    `| ${name}（${s.channel}） | ${s.queries} | ${s.pagesFetched} | ${s.pagesUsable} | ${s.items} | ${s.duplicatesRemoved} | ` +
    `${s.pagesFetched ? (s.items / s.pagesFetched).toFixed(2) : '—'} | ${s.hosts.slice(0, 3).map(([h, n]) => `${h}×${n}`).join('、') || '—'} |`;
  const lines = [
    '## 两次现场采集的稳定性',
    '',
    '| 快照 | 查询 | 抓页 | 产出页 | 合格题 | 去重 | 每页产题 | 主要来源 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    row(c.a, 'A'),
    row(c.b, 'B'),
    '',
    `- **题目重合**：${c.pairedItems} 道配上（重合率 ${(c.itemOverlap * 100).toFixed(1)}%，分母取较大那份）`,
    `- **来源 URL 重合**：Jaccard ${(c.urlJaccard * 100).toFixed(1)}%`,
    `- **判定**：${c.verdict}`,
    '',
    '### 丢弃原因分布（采集产出率低时先读这里）',
    '',
    '| 原因 | A | B |',
    '| --- | --- | --- |',
  ];
  const reasons = [...new Set([...Object.keys(c.a.dropped), ...Object.keys(c.b.dropped)])].sort();
  for (const k of reasons) lines.push(`| ${k} | ${c.a.dropped[k] ?? 0} | ${c.b.dropped[k] ?? 0} |`);
  if (reasons.length === 0) lines.push('| （无丢弃） | 0 | 0 |');
  lines.push('');
  lines.push('丢因读法：`fetch-failed`／`http-4xx` 多 ⇒ 站点反爬或网络，与模型无关；');
  lines.push('`extract-unparsed` 多 ⇒ 抽题模型不服从协议，换抽题器；');
  lines.push('`needs-media`／`no-answer` 多 ⇒ 查询词搜到的页面本身不是可用题库页，改 `datasets/harvest-queries.json`。');
  return lines.join('\n');
}

// ════════════════════════ 入口 ════════════════════════

function main() {
  if (flag('harvest')) {
    if (files.length !== 2) {
      console.error('用法：npm run eval:compare -- --harvest <快照A.json> <快照B.json>');
      process.exit(2);
    }
    const [a, b] = files.map(readJson);
    for (const [f, s] of [[files[0], a], [files[1], b]])
      if (s.kind !== 'harvest-snapshot') { console.error(`${f} 不是采集快照（kind=${s.kind}）`); process.exit(2); }
    console.log(renderHarvest(a, b));
    return;
  }

  if (files.length < 2) {
    console.error('用法：npm run eval:compare -- results/a.json results/b.json [...]　或　-- --harvest h1.json h2.json');
    process.exit(2);
  }
  const runs = files.map((f) => {
    const r = readJson(f);
    if (r.kind !== 'model-bench-result')
      console.error(`⚠ ${basename(f)} 不带 kind=model-bench-result（可能是本批改动之前跑的旧报告：它没有计量字段，延迟/成本栏会全空）`);
    return r;
  });
  const block = renderCompare(runs);
  console.log('\n' + block);
  if (flag('doc')) writeDoc(block);
}

main();
