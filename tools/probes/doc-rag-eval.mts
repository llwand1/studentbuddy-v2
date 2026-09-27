/**
 * 检索召回**评测台**（开发侧，契约 DOC-RAG-SPEC §10.5）——把"没召回"拆成能读的原因。
 *
 * 复跑：
 *   npx tsx tools/probes/doc-rag-eval.mts              # 产物写同目录 doc-rag-eval.result.txt
 *   npx tsx tools/probes/doc-rag-eval.mts --scale=10   # 复印倍数（默认 10＝71.6 万字量级，与 §10.2 同竞争面）
 *   npx tsx tools/probes/doc-rag-eval.mts --k=24       # 换名次窗口（判"漏接到底是窗口还是词表"）
 *
 * ★ 与 `doc-rag-bm25.mjs` 的分工：那份是**历史证据**（自带一份复刻 BM25，产物已进契约，改它＝重述历史读数），
 *   这份是**日常评测台**：直接 import 产品的 `chunkDoc`/`buildBm25Index`/`scoreChunks`/`retrieveDoc`，
 *   所以解释与线上排序同源；名次与"是否真被投进上下文"以 `retrieveDoc` 的返回为事实（不重算注入预算）。
 * ★ 语料表在 `doc-rag-corpus.mts`（抄自探针，探针本体一个字没改）。抄写的漂移由
 *   `doc-rag-parity.mts` **现量**：它逐字比语料、比分词，并跑探针原码作忠实对照组。
 *   ★ 它 2026-09-27 抓到过一次真漂移：探针复刻的 `chunkDoc` 合并条件与产品那份不同（938 块 vs 941 块），
 *   同一查询第14章的名次从 10 变 19 ⇒ §10.2 的 `para 8/13` 在产品码上是 **7/13**。见契约 §10.2 补注。
 * ★ 三档对照：`kw`（贴着原文用词的提问）／`para`（学生大白话＝今天线上无扩展时的行为）／
 *   `para+terms`（大白话＋扩展术语串＝本批落地的产品档）。
 *   ★ 三档必须**句子上就不同**：循环里写 `armQuery(c, arm)`（少 `.key`）时两个 `===` 全不成立，
 *     三档静默退化成同一句扩展查询，本台第一版就是这样把 7/13 读成 12/13 的。`tools/` 不在 tsconfig 内，
 *     类型检查抓不到 ⇒ 下面循环里带了一句当场比句子的防呆，同句即罢工。
 * ★ **两个语料 cohort 分开报，永不合并成一个数**：13 条的术语串来自 `agnes-3.0-flash` 真调快照，
 *   17 条的题目与术语串都是我手写的（`author: "dev-hand"`）——手写的题＋手写的词＝同一个脑子，
 *   混在一起报等于给自己的解释背书。★ 这条纪律实测有牙：手写档大白话召回 14/17，真调快照档只有 7/13，
 *   **我出的题系统性比我照着的快照更容易**——合并数字会把扩展档的功劳吹大。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBm25Index, chunkDoc, retrieveDoc } from '../../packages/server/src/learning/doc-retrieve.js';
import { buildCorpus, FACTS } from './doc-rag-corpus.mts';
import { explainCase, explainTermRescue } from '../../packages/server/src/learning/doc-eval-explain.js';
import type { CaseExplanation } from '../../packages/server/src/learning/doc-eval-explain.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out: string[] = [];
const log = (s: string): void => {
  out.push(s);
};


/* ── 参数 ─────────────────────────────────────────────── */
const argNum = (name: string, dft: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dft;
};
const SCALE = argNum('scale', 10);
const K = argNum('k', 12);
const CHUNK = 800;
const OVERLAP = 120;
const BUDGET = 12_000;

const casesPath = path.join(HERE, 'doc-rag-eval-cases.json');
const rewritesPath = path.join(HERE, 'doc-rag-rewrites.json');
if (!fs.existsSync(casesPath)) {
  log('❌ 缺 doc-rag-eval-cases.json（病例集），无法跑评测台');
  fs.writeFileSync(path.join(HERE, 'doc-rag-eval.result.txt'), out.join('\n') + '\n', 'utf8');
  console.log(out.join('\n'));
  process.exit(1);
}
type Case = { id: string; chapter: number; author: string; kw: string; para: string; terms?: string; termsFrom?: string };
const CASES = JSON.parse(fs.readFileSync(casesPath, 'utf8')).cases as Case[];
const RW = fs.existsSync(rewritesPath)
  ? (JSON.parse(fs.readFileSync(rewritesPath, 'utf8')).rewrites as Record<string, { ch: number; terms: string }>)
  : {};

const termsOf = (c: Case): string => {
  if (c.termsFrom === 'rewrites') return RW[c.para]?.terms ?? '';
  return c.terms ?? '';
};

const text = buildCorpus(SCALE);
const t0 = performance.now();
const chunks = chunkDoc(text, CHUNK, OVERLAP);
const index = buildBm25Index(chunks);
const t1 = performance.now();

/** 事实句所在的那一块（产品切块口径）；-1＝被切断或找不到 */
const targetOf = (chapter: number): number => {
  const fact = FACTS[chapter - 1];
  if (!fact) return -1;
  const copyStart = text.lastIndexOf(`# 复印部分 ${SCALE}`);
  return chunks.findIndex((c) => c.from >= copyStart && c.text.includes(fact));
};

log('检索召回评测台（解释度版）');
log(`口径：语料=${text.length} 字（复印 ${SCALE} 片，事实只落在最后一片）｜切块=${CHUNK}/${OVERLAP}｜k=${K}｜注入预算=${BUDGET} 字`);
log(`病例=${CASES.length} 条，其中术语串来自真调快照 ${CASES.filter((c) => c.termsFrom === 'rewrites').length} 条、我手写 ${CASES.filter((c) => c.author === 'dev-hand').length} 条 ⇒ **两 cohort 分开报，不合并成一个数**`);
log(`解释层＝产品的 chunkDoc/buildBm25Index/scoreChunks/retrieveDoc（同一条分词与打分），切块+建索引耗时 ${(t1 - t0).toFixed(1)}ms，块数=${chunks.length}`);

type Arm = { key: 'kw' | 'para' | 'para+terms'; label: string };
const ARMS: Arm[] = [
  { key: 'kw', label: 'KW  贴原文用词的提问（对照上限）' },
  { key: 'para', label: 'PARA 学生大白话（＝线上无扩展时的行为）' },
  { key: 'para+terms', label: 'PARA+术语 大白话＋扩展术语串（＝本批落地的产品档）' },
];

function armQuery(c: Case, arm: Arm['key']): string {
  if (arm === 'kw') return c.kw;
  if (arm === 'para') return c.para;
  const t = termsOf(c);
  return t ? `${c.para} ${t}` : c.para;
}

type Row = { c: Case; arm: Arm['key']; e: CaseExplanation; rescuers: string[] };
const rows: Row[] = [];
for (const c of CASES) {
  const target = targetOf(c.chapter);
  for (const arm of ARMS) {
    if (arm.key === 'para+terms' && !termsOf(c)) continue; // 没有术语串＝这一档不成立，不硬跑
    const q = armQuery(c, arm.key);
    /**
     * ★ 三档防呆（2026-09-27 实付的学费）：写成 `armQuery(c, arm)`（少 `.key`）时两个 `===` 全不成立，
     *   三档静默退化成同一句扩展查询，kw/para/para+terms 召回数一模一样——**本台第一版的全部结论
     *   都是从那个假数读出来的**。`tools/` 不在 tsconfig 覆盖内，`npm run check` 抓不到这种错，
     *   所以只能当场比句子：同一病例的 para 档与 para+terms 档查出同一句 ⇒ 直接罢工，不许往下写读数。
     */
    if (arm.key === 'para' && termsOf(c) && q === armQuery(c, 'para+terms')) {
      throw new Error(`${c.id}：para 档与 para+terms 档查询相同 ⇒ 查询构造有 bug，读数作废`);
    }
    const picked = retrieveDoc(text, q, { k: K, chunkChars: CHUNK, overlap: OVERLAP, budgetChars: BUDGET });
    const e = explainCase({ index, chunks, query: q, target, selectedSeqs: picked.map((p) => p.seq), k: K });
    let rescuers: string[] = [];
    if (arm.key === 'para+terms' && termsOf(c)) {
      /**
       * ★ 术语串有两种写法：真调快照那 13 条是**顿号连**（`月球、重力加速度、…`，来自 `doc-rag-rewrites.json`），
       *   我手写那 17 条是**空格连**。原先只按 `/\s+/` 拆 ⇒ 快照档整串被当成**一个术语**，
       *   "撤掉哪个术语"退化成"撤掉整串"，而打印出来**看着像**每个术语都是救手（09:3x 自查抓到）。
       *   召回读数不受影响（那一档拼的是 `para + 整串`，与拆法无关），受影响的是**撤词反事实**这一格。
       */
      const terms = termsOf(c).split(/[\s、，,；;]+/).filter(Boolean);
      rescuers = explainTermRescue({ index, base: c.para, terms, target, k: K })
        .filter((r) => r.keyRescuer)
        .map((r) => `${r.term}(${r.rankWithout === 0 ? '撤掉即跌出打分序' : `撤掉→rank${r.rankWithout}`})`);
    }
    rows.push({ c, arm: arm.key, e, rescuers });
  }
}

const cohortOf = (c: Case): string => (c.termsFrom === 'rewrites' ? '真调快照' : '我手写');
const fmtTerms = (arr: string[], n: number): string =>
  arr.length ? `${arr.slice(0, n).join('、')}${arr.length > n ? `…等 ${arr.length} 个` : ''}` : '（无）';
/** 反事实候选：带 df——df≤2 的候选只是"离前 k 差多远"的刻度，**不能当扩词依据**（孤词 bigram 分量虚高）。 */
const fmtCand = (arr: Array<{ term: string; df: number }>): string =>
  arr.length ? arr.map((c) => `${c.term}(df=${c.df})`).join('、') : '（无）';

for (const arm of ARMS) {
  log('');
  log('='.repeat(78));
  log(`【${arm.label}】逐例解释（rank＝纯打分序名次，实投＝retrieveDoc 真返回里有没有它）：`);
  for (const r of rows.filter((x) => x.arm === arm.key)) {
    const e = r.e;
    const tag = `${r.c.id} 第${String(r.c.chapter).padStart(2)}章 [${cohortOf(r.c)}]`;
    const head = `${tag} ${e.selected ? '✓' : '✗'} rank=${e.rank || '-'} 实投=${e.selected ? 'Y' : 'N'} 正确块分=${e.score.toFixed(2)}`;
    log(`  ${head}｜归因=${e.cause}`);
    if (e.cause !== '命中') {
      log(`      缺的词元＝${fmtTerms(e.missing, 8)}｜它有的词元＝${fmtTerms(e.hits.map((h) => `${h.term}:${h.contrib.toFixed(1)}`), 5)}`);
      log(`      补词代价＝${e.gapFill.needed === null ? `**补满 ${e.gapFill.candidates.length} 个候选词元也进不了前 ${K}**（分 ${e.score.toFixed(2)}→${e.gapFill.filledScore.toFixed(2)}，名次 ${e.rank || '-'}→${e.gapFill.rankIfFilled}）＝要语义信号` : `先补这 ${e.gapFill.needed} 个就够（${fmtCand(e.gapFill.candidates)}）→分 ${e.gapFill.filledScore.toFixed(2)} 名次 ${e.gapFill.rankIfFilled}`}` +
        `｜教材里一次没出现过的缺失词元=${e.gapFill.absent.length} 个（扩词扩不出它们，见 §10.5 口径）`);
      if (e.above) {
        log(`      紧压它的是块#${e.above.chunkIdx}(起${chunks[e.above.chunkIdx]?.from}字) 分=${e.above.score.toFixed(2)}｜它多用了＝${fmtTerms(e.above.extraTerms.map((h) => h.term), 8)}`);
      }
    }
    if (arm.key === 'para+terms') {
      const tw = termsOf(r.c);
      log(`      术语串=${tw.slice(0, 60)}${tw.length > 60 ? '…' : ''}｜撤掉就出局的术语＝${r.rescuers.length ? r.rescuers.join('、') : '（无：撤哪个都还在前 k，说明召回不靠单点）'}`);
    }
  }
}

/* ── 汇总：召回＋归因分布，按 cohort 分开 ───────────────── */
log('');
log('='.repeat(78));
log('召回与归因汇总（**每个 cohort 单独计**）：');
for (const cohort of ['真调快照', '我手写', '全部']) {
  const sel = (c: Case): boolean => cohort === '全部' || cohortOf(c) === cohort;
  if (cohort === '全部') {
    // ★ 这一行**故意不报合并召回**：两 cohort 难度实测差一倍（见上面两行），合并成一个数就是把
    //   手写档的偏易混进真调档的真数。留这行只为对账条数。
    const n = rows.filter((r) => r.arm === 'para' && sel(r.c)).length;
    log(`  ${cohort}（n=${n}）：只作条数对账 ⇒ **不报合并召回**（两 cohort 难度不同，合并即自证，见 cases.json 的 cohort纪律）`);
    continue;
  }
  const line: string[] = [];
  for (const arm of ARMS) {
    const sub = rows.filter((r) => r.arm === arm.key && sel(r.c));
    if (!sub.length) continue;
    const hit = sub.filter((r) => r.e.selected).length;
    line.push(`${arm.key}=${hit}/${sub.length}`);
  }
  log(`  ${cohort.padEnd(6)}（n=${rows.filter((r) => r.arm === 'para' && sel(r.c)).length}）：` + line.join('  '));
}
log('');
log('漏接归因分布（只数"实投=N"的那些；补词代价见下面那张曲线表，这里不重复）：');
for (const arm of ARMS) {
  const miss = rows.filter((r) => r.arm === arm.key && !r.e.selected);
  const tally = new Map<string, number>();
  for (const m of miss) tally.set(m.e.cause, (tally.get(m.e.cause) ?? 0) + 1);
  const parts = [...tally].map(([c, n]) => `${c}=${n}`).sort();
  log(`  ${arm.key.padEnd(11)} 漏 ${miss.length} 条：${parts.length ? parts.join('、') : '（全命中）'}`);
}

/* ── 一张能指导产品的表：一次扩词给几个词元，就救得回几条 ────────────
 * 口径＝上面"只给正确块加分"的乐观上界；它回答"扩到 T 个词最多能救到哪"，不是"一定能救到"。 */
log('');
log(`扩词预算 → 可救病例数（**乐观上界**：只给正确块加分、对手一律不动；k=${K}）：`);
for (const arm of ARMS) {
  const miss = rows.filter((r) => r.arm === arm.key && !r.e.selected);
  if (!miss.length) continue;
  const base = rows.filter((r) => r.arm === arm.key && r.e.selected).length;
  const curve = [1, 2, 3, 4, 6, 8, 12]
    .map((t) => `T=${String(t).padStart(2)}→${base + miss.filter((m) => m.e.gapFill.needed !== null && m.e.gapFill.needed <= t).length}`)
    .join(' ');
  const rescued = miss.filter((m) => m.e.gapFill.needed !== null && (m.e.gapFill.needed ?? 0) > 0);
  const byRare = rescued.filter((m) => m.e.gapFill.candidates.slice(0, m.e.gapFill.needed ?? 0).every((c) => c.df <= 2)).length;
  const noWay = miss.filter((m) => m.e.gapFill.needed === null).length;
  log(`  ${arm.key.padEnd(11)} 现有实投=${base}/${rows.filter((r) => r.arm === arm.key).length}｜${curve}（T＝一次扩词允许的词元个数）`);
  log(`  ${' '.repeat(11)} ★ 可救 ${rescued.length} 条（其中 ${byRare} 条靠 df≤2 的孤词，只算刻度不算同义词）｜` +
    `补满候选也救不回=${noWay} 条 ⇒ 曲线量的是"差距有多小"，不是"扩词能救这么多"的承诺`);
}

/* ── 窗口敏感性：漏接到底是"窗口太小"还是"词表不通"（同一批名次，不重跑）── */
log('');
log(`窗口敏感性（**纯打分序口径**，只看名次不看注入预算；把窗口从 k=${K} 放宽到 2k=${2 * K}）：`);
for (const arm of ARMS) {
  const parts: string[] = [];
  for (const cohort of ['真调快照', '我手写']) {
    const sub = rows.filter((r) => r.arm === arm.key && cohortOf(r.c) === cohort);
    const inK = sub.filter((r) => r.e.rank > 0 && r.e.rank <= K).length;
    const in2K = sub.filter((r) => r.e.rank > 0 && r.e.rank <= 2 * K).length;
    parts.push(`${cohort}：${inK}/${sub.length} → 放宽到${2 * K}＝${in2K}/${sub.length}（+${in2K - inK}）`);
  }
  log(`  ${arm.key.padEnd(11)} ` + parts.join('｜'));
}

/* ── 扩词质量对照：还漏着的那几条，"该扩的词"与"模型给的词"差在哪 ──────
 * 这是本台最该回答的问题：救回一条病例只差 1~2 个词元（见上面的 T 曲线），
 * 所以漏接究竟是"扩词方向没用"还是"扩出来的词不对"，一比就知道。 */
log('');
log('扩词质量对照（para+terms 档仍漏接的病例）：');
for (const r of rows.filter((x) => x.arm === 'para+terms' && !x.e.selected)) {
  const paraRow = rows.find((x) => x.arm === 'para' && x.c.id === r.c.id);
  const need = paraRow?.e.gapFill;
  log(`  ${r.c.id} 第${String(r.c.chapter).padStart(2)}章 [${cohortOf(r.c)}] 名次=${r.e.rank || '-'}`);
  log(`      该补的词（反事实前 5，按分量降序，带 df）＝${need ? fmtCand(need.candidates) || '（不缺词）' : '（补满候选也救不回）'}｜needed=${need?.needed ?? '-'}｜教材没这个词元=${need?.absent.length ?? '-'} 个`);
  const used = (need?.candidates ?? []).slice(0, need?.needed ?? 0);
  if (need?.needed && used.length && used.every((c) => c.df <= 2)) {
    log('      ★ 救回它靠的这几个候选全是 df≤2 的**孤词** ⇒ 这一列只量"离前 k 差多远"，不能当同义词表该收的词');
  }
  log(`      实际给的术语串＝${termsOf(r.c).slice(0, 70)}`);
}

/* ── 本批的可证伪预言（写码前先立，跑完当场判）───────────── */
log('');
log('='.repeat(78));
const missPara = rows.filter((r) => r.arm === 'para' && !r.e.selected);
const noTerm = missPara.filter((r) => r.e.missing.length > 0);
const gapMiss = rows.filter((r) => r.arm === 'para' && r.e.cause === '词表鸿沟');
const compMiss = rows.filter((r) => r.arm === 'para' && r.e.cause === '打分竞争');
const splitMiss = rows.filter((r) => r.e.cause === '答案不在任何块');
const budgetMiss = rows.filter((r) => r.e.cause === '预算截断');
log(`P1（写码前立的）：「大白话档的漏接里，**至少 3 条**的原因是"正确块里根本没有那个词元"」`);
log(`  直判据（漏接且 missing 非空）=${noTerm.length}/${missPara.length} 条 ⇒ ${noTerm.length >= 3 ? '**预言成立**' : '**预言落空——解释层很可能在自证，必须回查**'}`);
log(`  ★ 这一条**几乎恒真**（bigram 分词下改写句总会漏词元），所以它只证明"解释层没瞎编"，不证明方向；`);
log(`    真正有牙的是下面 P2 与"补词反事实"的分档（旧口径把 9/9 全判成同一个标签，等于没判，已改掉）。`);
log('');
log(`P2（本轮新立，同一份名次当场判）：「真调快照·大白话档的漏接，**把窗口从 k=${K} 放宽到 2k=${2 * K} 最多救回 2 条**」`);
const snapPara = rows.filter((r) => r.arm === 'para' && cohortOf(r.c) === '真调快照');
const savedByWindow = snapPara.filter((r) => r.e.rank > K && r.e.rank <= 2 * K).length;
log(`  实测＝放宽到 ${2 * K} 多救回 ${savedByWindow} 条 ⇒ ${savedByWindow <= 2 ? '**预言成立：瓶颈不在名次窗口**（与 §10.2 的 k=24 仍是 8/13 同向）' : '**预言落空：那才该回去调 k**'}`);
log(`  同档补词反事实分档：补词可救=${gapMiss.length} 条（${gapMiss.map((r) => `${r.c.id}/第${r.c.chapter}章`).join('、') || '无'}）` +
  `｜补词也救不回=${compMiss.length} 条（${compMiss.map((r) => `${r.c.id}/第${r.c.chapter}章`).join('、') || '无'}）⇒ 后一类才是 embedding 的地盘`);
log(`  切块断裂（答案没落进任何块）=${splitMiss.length} 条｜预算截断（打分已进前 k 却没投进上下文）=${budgetMiss.length} 条`);
log('  ★ 这两类都不是检索算法的锅：前者属切块粒度，后者属注入预算——能分开，就是本台存在的理由。');

fs.writeFileSync(path.join(HERE, 'doc-rag-eval.result.txt'), out.join('\n') + '\n', 'utf8');
console.log(out.slice(-24).join('\n'));
console.log(`\ndone -> tools/probes/doc-rag-eval.result.txt（${out.length} 行）`);
