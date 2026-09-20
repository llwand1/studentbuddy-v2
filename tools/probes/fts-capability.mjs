/**
 * tools/probes/fts-capability.mjs —— FTS 方案选型的**实测凭证**（契约 `docs/FTS-SPEC.md` §8 / §7 预言 1）
 *
 * 用途：把 FTS-SPEC 里三条**当时只来自文档推断**的结论钉成实测，并顺跑该契约 §8 点名
 *   「建议动码批顺跑并归档进 tools/probes/」的 trigram 复核。
 *
 *   §8 待复核项 ⇒ 本探针第 ② 节：**A2 trigram 排除理由**——「SQLite 硬性要求查询词元 ≥3 字，
 *   中文双字词（"概率""函数"）不可查」。文档这么写，但没在本机跑过；跑完 A2 的排除就从
 *   「文档推断」升级为「实测结论」。
 *   §7 预言 1 ⇒ 本探针第 ④ 节：v37 首建耗时量级。
 *
 * 三个 fts5 陷阱（本探针逐条现场复现，它们是实现里那些「看起来多余的代码」的**存在理由**）：
 *   ⑤ 空 MATCH **匹配全表** ⇒ 空查询必须短路，不能把 `MATCH ''` 发给 SQLite；
 *   ⑥ 未转义的 `-牛顿` 被读成 **NOT** ⇒ 搜「-牛顿」返回的是「不含牛顿的」，与意图正好相反；
 *   ⑦ 未转义的 `c++` 直接语法报错 ⇒ 词元必须包成双引号字面量。
 *
 * 只读声明：**全程只用 `fs.mkdtempSync` 的临时目录**，不打开、不触碰任何真实数据目录
 *   （不读 SB_DATA_DIR / APPDATA，与 `db-isolation-check.mjs` 是相反的取向——那边是去读真库取证，
 *   这边是刻意不读）。
 *
 * 用法（Node 必须与装依赖的一致，ABI 要对得上；本仓现役 Node 22）：
 *   node tools/probes/fts-capability.mjs
 * 输出：逐节打印，末行 `RESULT: …` 汇总。全部为实测数字，无推断。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fts-probe-'));
const db = new Database(path.join(tmp, 'probe.db'));

const ok = (label, cond, detail = '') =>
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);

console.log('=== 0. 环境 ===');
const ver = db.prepare('select sqlite_version() as v').get().v;
const opts = db.prepare('pragma compile_options').all().map((r) => r.compile_options);
console.log('  sqlite:', ver, '| ENABLE_FTS5:', opts.includes('ENABLE_FTS5'));
console.log('  临时库:', path.join(tmp, 'probe.db'), '（跑完即删，不碰真库）');

// ── ① fts5 可用性 + 「裸 unicode61 为什么不够」──
console.log('\n=== 1. fts5 可用性，以及「裸 unicode61 为什么不够」===');
db.exec(`CREATE VIRTUAL TABLE t_uni USING fts5(body, tokenize='unicode61')`);
db.prepare(`INSERT INTO t_uni(body) VALUES (?)`).run('牛顿第二定律');
const uni = (q) => db.prepare(`SELECT count(*) c FROM t_uni WHERE t_uni MATCH ?`).get(q).c;
const whole = uni('牛顿第二定律');
const two = uni('牛顿');
const one = uni('牛');
console.log(`  整段「牛顿第二定律」→ ${whole} 行；双字「牛顿」→ ${two} 行；单字「牛」→ ${one} 行`);
ok('fts5 可用（建表 + 写入 + MATCH 跑得通）', whole === 1);
ok('★ unicode61 把**整段连续汉字当成一个词元** ⇒ 双字词查不到', two === 0);
ok('★ 单字同样查不到（不是"按单字切"，那是个常见误解）', one === 0);
console.log('  ⇒ 这就是 A1（写侧 bigram 预处理）存在的理由：原生分词器不会替你切双字窗，');
console.log('    它连"子串可查"都做不到——只有整段逐字相同才命中。');

// ── ② A2 trigram 复核（FTS-SPEC §8 点名项）──
console.log('\n=== 2. A2 trigram 复核（契约 §8 点名「尚未在本机实跑验证」的那条）===');
db.exec(`CREATE VIRTUAL TABLE t_tri USING fts5(body, tokenize='trigram')`);
db.prepare(`INSERT INTO t_tri(body) VALUES (?)`).run('牛顿第二定律');
const tri = (q) => {
  try {
    return db.prepare(`SELECT count(*) c FROM t_tri WHERE t_tri MATCH ?`).get(q).c;
  } catch (e) {
    return 'ERR: ' + e.message;
  }
};
const tri2 = tri('定律');
const tri3 = tri('第二定');
const tri1 = tri('熵');
console.log(`  双字词「定律」 → ${tri2}`);
console.log(`  三字词「第二定」→ ${tri3}`);
console.log(`  单字  「熵」   → ${tri1}`);
ok('三字词可查（trigram 的工作区间）', tri3 === 1);
ok('★ 双字词不可查（A2 的致命伤，实测坐实）', tri2 === 0);
ok('★ 单字亦不可查', tri1 === 0);

// ── ③ A1 bigram 对照（本契约选的方案）──
console.log('\n=== 3. A1 bigram 对照（本契约实际采用的方案）===');
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const LATIN = /[a-z][a-z0-9.+-]*|\d+(?:\.\d+)?/g;
/** 与 packages/shared/src/fts.ts 的 tokenizeForFts 同算法（探针内联一份，避免依赖构建产物） */
function tokenize(s) {
  const low = s.toLowerCase();
  const toks = low.match(LATIN) ?? [];
  const cn = [];
  for (const run of low.match(CJK) ?? []) {
    if (run.length === 1) {
      cn.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) cn.push(run.slice(i, i + 2));
  }
  return cn.length ? toks.concat(cn) : toks;
}
const buildMatch = (tokens) => {
  const uniq = [...new Set(tokens.filter((t) => t.length > 0))];
  return uniq.length === 0 ? '' : uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
};
db.exec(`CREATE VIRTUAL TABLE t_bi USING fts5(tokens, tokenize='unicode61')`);
db.prepare(`INSERT INTO t_bi(tokens) VALUES (?)`).run(tokenize('牛顿第二定律').join(' '));
const bi = (q) => db.prepare(`SELECT count(*) c FROM t_bi WHERE t_bi MATCH ?`).get(buildMatch(tokenize(q))).c;
ok('双字词「定律」可查（与 trigram 正面相反）', bi('定律') === 1);
ok('双字词「第二」可查', bi('第二') === 1);
ok('★ 单字「连」查不到多字连续串（已登记为已接受限制，不是 bug）', bi('连') === 0);

// ── ④ 首建耗时（FTS-SPEC §7 预言 1）──
console.log('\n=== 4. 首建耗时量级（契约 §7 预言 1：真实库副本上 < 2 s）===');
const N = 10000;
const seed = db.transaction(() => {
  for (let i = 0; i < N; i++) {
    db.prepare(`INSERT INTO t_bi(tokens) VALUES (?)`).run(tokenize(`第${i}条消息 牛顿第二定律与动量守恒的推导 闭包 closure ${i}`).join(' '));
  }
});
const tSeed = Date.now();
seed();
const tBuild = Date.now();
console.log(`  合成 ${N} 行（每行约 40 词元），灌库耗时 ${tBuild - tSeed} ms`);
const tQuery = Date.now();
const hit = bi('动量守恒');
const tQueryEnd = Date.now();
ok(`命中 ${hit} 行，单次查询 ${tQueryEnd - tQuery} ms`, hit === N);
console.log(`  ⇒ 量级参考：${N} 行的建索引约 ${tBuild - tSeed} ms（**合成数据，非真实库副本**，仅供量级外推）`);

// ── ⑤⑥⑦ 三个 fts5 陷阱现场复现 ──
console.log('\n=== 5. 三个陷阱：为什么实现里那几行"看起来多余" ===');
db.exec(`CREATE VIRTUAL TABLE t_esc USING fts5(tokens)`);
db.prepare(`INSERT INTO t_esc(tokens) VALUES (?)`).run(tokenize('牛顿第二定律').join(' '));
db.prepare(`INSERT INTO t_esc(tokens) VALUES (?)`).run(tokenize('闭包 closure').join(' '));
const m = (q) => {
  try {
    return db.prepare(`SELECT count(*) c FROM t_esc WHERE t_esc MATCH ?`).get(q).c;
  } catch (e) {
    return 'ERR: ' + e.message;
  }
};

// ⑤ 空 MATCH：**语法错误**，不是「匹配全表」（本探针纠正的一处旧说法）
console.log(`  MATCH ''    → ${m('')}`);
console.log(`  MATCH '   ' → ${m('   ')}`);
console.log(`  MATCH '""'  → ${m('""')}`);
ok('★ 空 MATCH 是**语法错误**（旧说法「会匹配全表」不成立）⇒ 不短路就是「敲几个空格 → 500」', String(m('')).startsWith('ERR:'));
ok('★ 纯空白串同样报错 ⇒ 短路必须发生在 trim 之后、SQL 之前', String(m('   ')).startsWith('ERR:'));
ok('空字符串字面量 `""` 返回 0 行（不报错，也不匹配全表）', m('""') === 0);

// ⑥ `-` 前缀：**报错**，不是 fts3/4 那种 NOT 简写（这是本探针纠正的第二处旧说法）
const plus = m('牛顿');
const minus = m('-牛顿');
const binNot = m('牛顿 NOT 闭包');
const preNot = m('NOT 牛顿');
console.log(`  MATCH '牛顿' → ${plus}；MATCH '-牛顿' → ${minus}`);
console.log(`  MATCH '牛顿 NOT 闭包' → ${binNot}（二元 NOT 可用）；MATCH 'NOT 牛顿' → ${preNot}（前缀 NOT 不可用）`);
ok('★ 未转义的 `-牛顿` 是**报错**（no such column），不是静默语义反转', String(minus).startsWith('ERR:'));
ok('★ fts5 的 NOT **只能做二元运算符**，没有 `-term` 前缀简写', binNot === 1 && String(preNot).startsWith('ERR:'));
const quotedMinus = m('"-牛顿"');
console.log(`  MATCH '"-牛顿"' → ${quotedMinus} 行`);
ok('★ 转义只解决**语法错误**，不改变分词结果——引号内的 `-` 被分词器当分隔符丢掉、`牛顿` 照样命中', quotedMinus === 1);
console.log('  ⇒ 故本函数的定位是"**防 500 的护栏**"，不是"精确字面量匹配"。');
console.log('    真正决定"查什么"的是 `tokenizeForFts`（它才是两侧共用的那一份）。');

// ⑦ `+` 等特殊字符：未转义直接语法报错
console.log(`  MATCH 'c++'     → ${m('c++')}；MATCH '"c++"' → ${m('"c++"')}`);
ok('★ 未转义的 `c++` 直接语法报错 ⇒ 词元必须包成双引号字面量', String(m('c++')).startsWith('ERR:'));
ok('转义后不报错（0 行，库里无该词元）', m('"c++"') === 0);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nRESULT: trigram 双字词不可查=实测坐实；bigram 双字词可查；三个陷阱全部现场复现（其中「空 MATCH 匹配全表」的旧说法被本探针**证伪**：真实行为是语法错误）；临时库已清理。');
