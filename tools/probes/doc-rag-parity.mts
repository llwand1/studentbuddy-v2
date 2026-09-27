/**
 * 对照件（开发侧，契约 DOC-RAG-SPEC §10.5）——评测台与 §10.2 历史探针**是不是同一件事**，跑一遍就知道。
 *
 * 复跑：`npx tsx tools/probes/doc-rag-parity.mts`（产物写同目录 doc-rag-parity.result.txt）
 *
 * **治的病（2026-09-27 实付的学费）**：§10.2 记的基线是 `PARA recall 8/13 → 扩词 12/13`，而评测台
 * 走产品码量出来是 **7/13**。两个数都对，量的不是同一个东西：探针自带一份**复刻**的 `chunkDoc`
 * （合并条件 `to-from+(t-f) > size`），产品那份是 `pt-from > size` ⇒ 同语料 938 块 vs 941 块，
 * 第14章那条的块边界一挪，名次从 10 掉到 19。复刻件与产品件**没有编译期约束不许分叉**，
 * 所以分叉只能这样现量。
 *
 * ★ 本件干三件事：
 *   ① 语料字节对照（我的 `doc-rag-corpus.mts` vs 探针源文件里那段，逐字比）——抄写漂移当场暴露；
 *   ② 分词对照（产品 `tokenizeDoc` vs 探针 `tokenize`，末片 200 块 + 26 条查询）；
 *   ③ 2×2 归因（切块口径 × 平局次序），并跑**探针原码**作忠实对照组，历史读数复不复现当场见。
 * ★ 探针的函数是**从 .mjs 源文本里按锚点抠出来 eval 的**，不改探针一个字（它的 result.txt 已进契约正文）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBm25Index, chunkDoc as prodChunk, scoreChunks, tokenizeDoc } from '../../packages/server/src/learning/doc-retrieve.js';
import { buildCorpus as myBuildCorpus, FACTS as MY_FACTS } from './doc-rag-corpus.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 一行同时进控制台与产物（产物＝契约 §10.2 补注的证据件）。 */
const out: string[] = [];
const log = (s: string): void => {
  out.push(s);
  process.stdout.write(s + "\n");
};
const src = fs.readFileSync(path.join(HERE, 'doc-rag-bm25.mjs'), 'utf8');
const seg = (from: string, to: string): string => {
  const i = src.indexOf(from);
  const j = src.indexOf(to);
  if (i < 0 || j < 0 || i >= j) throw new Error(`锚点失败：${from} / ${to} ⇒ 探针源文件被改过，本对照件要跟着改`);
  return src.slice(i, j);
};
const probeBody = [
  seg('const TOPICS', '// ── 切块'),
  seg('function chunkDoc', '// ── 分词'),
  seg('function tokenize', '// ── BM25'),
  seg('function buildIndex', '// ── 查询集'),
  seg('const QUERIES', 'const DISTRACTORS'),
  seg('function buildScaleCopies', 'const SCALE = buildScaleCopies'),
  'return { chunkDoc, tokenize, buildIndex, search, QUERIES, FACTS, buildScaleCopies };',
].join('\n');
const probe = new Function(probeBody)() as {
  chunkDoc: (t: string, s: number, o: number) => Array<{ seq: number; from: number; to: number; text: string }>;
  tokenize: (s: string) => string[];
  buildIndex: (c: Array<{ seq: number; from: number; to: number; text: string }>) => unknown;
  search: (i: unknown, q: string) => Array<{ i: number; s: number }>;
  QUERIES: Array<{ want: number; kw: string; para: string }>;
  FACTS: string[];
  buildScaleCopies: (n: number) => string;
};

const pc = probe.buildScaleCopies(10);
const mc = myBuildCorpus(10);

const pchunks = probe.chunkDoc(pc, 800, 120);
const mchunks = prodChunk(mc, 800, 120);

/* ① 语料字节 */
let firstDiff = -1;
if (pc !== mc) {
  firstDiff = 0;
  while (firstDiff < Math.min(pc.length, mc.length) && pc[firstDiff] === mc[firstDiff]) firstDiff++;
}
log(`① 语料字节：探针=${pc.length} 字｜评测台=${mc.length} 字｜逐字相等=${pc === mc}` +
  (firstDiff >= 0 ? `｜首个差异 @${firstDiff}：探针「${pc.slice(firstDiff - 18, firstDiff + 18)}」vs 我「${mc.slice(firstDiff - 18, firstDiff + 18)}」` : ''));
log(`   FACTS 表逐字相等=${JSON.stringify(probe.FACTS) === JSON.stringify(MY_FACTS)}`);

/* ② 分词 */
let tokDiff = 0;
for (const c of mchunks.slice(-200)) {
  if (JSON.stringify(probe.tokenize(c.text)) !== JSON.stringify([...tokenizeDoc(c.text)])) tokDiff++;
}
let qDiff = 0;
for (const q of probe.QUERIES) {
  for (const s of [q.kw, q.para]) {
    if (JSON.stringify(probe.tokenize(s)) !== JSON.stringify([...tokenizeDoc(s)])) qDiff++;
  }
}
log(`② 分词：末片 200 块不一致=${tokDiff}/200｜26 条查询不一致=${qDiff}/26` +
  `（产品 CJK 区间更宽，本语料无扩展 A/兼容表意字 ⇒ 预期 0）`);

/* ③ 切块口径 */
log(`③ 切块：探针=${pchunks.length} 块（合并条件 to-from+(t-f)>size）｜产品=${mchunks.length} 块（pt-from>size）` +
  `⇒ **两份实现，块边界不同**，这就是 8/13 与 7/13 的差额来源`);

/* ④ 忠实对照组：探针原码原样跑，历史读数复不复现 */
const faithful = (arm: 'kw' | 'para', k: number): number => {
  const idx = probe.buildIndex(pchunks);
  let hit = 0;
  for (const q of probe.QUERIES) {
    const ci = pchunks.findIndex((c) => c.text.includes(probe.FACTS[q.want - 1]));
    if (probe.search(idx, q[arm]).slice(0, k).some((r) => r.i === ci)) hit++;
  }
  return hit;
};
log(`④ 探针原码复现：kw@12=${faithful('kw', 12)}/13 para@6=${faithful('para', 6)}/13 para@12=${faithful('para', 12)}/13` +
  `（§10.2 记的是 13/13、5/13、8/13）⇒ ${faithful('para', 12) === 8 ? '**历史读数可复现，契约正文无需改写**' : '**历史读数复现失败，必须重述 §10.2**'}`);

/* ⑤ 2×2：切块口径 × 平局次序（都用产品分词与公式） */
type ChunkList = Array<{ seq: number; from: number; to: number; text: string }>;
function rankCell(chunks: ChunkList, tie: 'index' | 'insert') {
  const idx = buildBm25Index(chunks);
  const rankOf = (q: string, want: number): number => {
    const ci = chunks.findIndex((c) => c.text.includes(probe.FACTS[want - 1]));
    const r = scoreChunks(idx, q);
    const ordered = tie === 'index' ? r.slice().sort((x, y) => y.s - x.s || x.i - y.i) : r;
    return ordered.findIndex((x) => x.i === ci) + 1;
  };
  const recall = (arm: 'kw' | 'para', k: number): number =>
    probe.QUERIES.reduce((h, q) => {
      const r = rankOf(q[arm], q.want);
      return r > 0 && r <= k ? h + 1 : h;
    }, 0);
  return { rankOf, recall };
}
const cells = [
  ['探针切块 · 名次按块号升序（探针口径）', rankCell(pchunks, 'index')],
  ['探针切块 · 名次按插入序（产品口径）  ', rankCell(pchunks, 'insert')],
  ['产品切块 · 名次按块号升序          ', rankCell(mchunks, 'index')],
  ['产品切块 · 名次按插入序（＝产品真实排序）', rankCell(mchunks, 'insert')],
] as const;
log('⑤ 2×2（产品分词/公式，只换切块与平局次序）：');
for (const [name, c] of cells) {
  log(`   ${name}：kw@12=${c.recall('kw', 12)}/13 para@6=${c.recall('para', 6)}/13 para@12=${c.recall('para', 12)}/13`);
}

/* ⑥ 逐例：para@12 名次，点名到底是哪一章被块边界挪出前 k */
const A = rankCell(pchunks, 'index');
const B = rankCell(mchunks, 'index');
log('⑥ para@12 逐例名次（同分平台＝与该块同分的块数，平台大说明名次靠的是次序不是相关性）：');
for (const q of probe.QUERIES) {
  const idxM = buildBm25Index(mchunks);
  const ciM = mchunks.findIndex((c) => c.text.includes(probe.FACTS[q.want - 1]));
  const tgt = scoreChunks(idxM, q.para).find((r) => r.i === ciM);
  const plateau = tgt ? scoreChunks(idxM, q.para).filter((r) => r.s === tgt.s).length : 0;
  const ra = A.rankOf(q.para, q.want);
  const rb = B.rankOf(q.para, q.want);
  const flip = ra <= 12 !== rb <= 12 ? '  ★ 被块边界挪出/挪进前 12' : '';
  log(`   第${String(q.want).padStart(2)}章 块号 探针=${chunks2idx(pchunks, q.want)} 产品=${ciM}` +
    `｜para 名次 探针块=${ra || '-'} 产品块=${rb || '-'}｜同分平台=${plateau}${flip}`);
}
fs.writeFileSync(path.join(HERE, 'doc-rag-parity.result.txt'), out.join('\n') + '\n', 'utf8');
process.stdout.write(`\ndone -> tools/probes/doc-rag-parity.result.txt（${out.length} 行）\n`);

function chunks2idx(list: ChunkList, want: number): number {
  return list.findIndex((c) => c.text.includes(probe.FACTS[want - 1]));
}
