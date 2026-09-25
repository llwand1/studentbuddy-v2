#!/usr/bin/env node
/**
 * tools/metrics.mjs — 工程量化的唯一产出器。
 *
 * 为什么要有它：`docs/metrics.md` 原先是手抄快照（2026-09-06 一次采集后未刷新），
 * README 里同一件事在不同小节被抄成两组数字。手抄的数字必然腐烂，所以：
 *   数字由本脚本产出 → 写进 docs/metrics.json + docs/metrics.md 的标记区 →
 *   README 只允许引用「本脚本刚测出的值」，漂移由 `--check` 拦。
 *
 * 用法：
 *   node tools/metrics.mjs                静态计数，打印 + 写 docs/metrics.json
 *   node tools/metrics.mjs --tests        额外跑一遍 vitest（json reporter）取真实用例数
 *   node tools/metrics.mjs --write-docs   把数字回填进 docs/metrics.md 的标记区
 *   node tools/metrics.mjs --check        对账 README/首屏手抄数字；有漂移则退出码 1（供 CI/门禁调用）
 *                                         ★ **只读**：不写 docs/metrics.json（要刷快照请不带标志跑一次）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = new Set(process.argv.slice(2));
const PKGS = ['shared', 'server', 'web'];
const CODE_EXT = new Set(['.ts', '.tsx']);
const TEST_RE = /\.test\.tsx?$/;

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'test-results', 'coverage'].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replaceAll('\\', '/');
const linesOf = (p) => fs.readFileSync(p, 'utf8').split('\n').length;
const grepCount = (files, re) => {
  let n = 0;
  for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (re.test(line)) n++;
  return n;
};

/** 源码/测试体量：按包分列，测试行与源码行分开（口径：*.test.ts(x) 算测试，其余算源码）。 */
function codeSize() {
  const rows = [];
  let srcLines = 0;
  let testLines = 0;
  let srcFiles = 0;
  let testFiles = 0;
  for (const pkg of PKGS) {
    const files = walk(path.join(ROOT, 'packages', pkg, 'src')).filter((f) => CODE_EXT.has(path.extname(f)));
    const tests = files.filter((f) => TEST_RE.test(f));
    const src = files.filter((f) => !TEST_RE.test(f));
    const s = src.reduce((a, f) => a + linesOf(f), 0);
    const t = tests.reduce((a, f) => a + linesOf(f), 0);
    rows.push({ pkg, srcFiles: src.length, testFiles: tests.length, srcLines: s, testLines: t });
    srcLines += s;
    testLines += t;
    srcFiles += src.length;
    testFiles += tests.length;
  }
  const tsxTests = walk(path.join(ROOT, 'packages')).filter((f) => f.endsWith('.test.tsx'));
  return { rows, srcFiles, testFiles, srcLines, testLines, tsxTestFiles: tsxTests.length };
}

/** REST 路由：口径 = `<x>Router.(get|post|put|delete|patch)(` 的注册次数（不含 app.use 中间件挂载）。 */
function restRoutes() {
  const files = walk(path.join(ROOT, 'packages', 'server', 'src')).filter((f) => f.endsWith('.ts') && !TEST_RE.test(f));
  const byMethod = {};
  let total = 0;
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /[A-Za-z]+Router\.(get|post|put|delete|patch)\(/.exec(line);
      if (!m) continue;
      byMethod[m[1]] = (byMethod[m[1]] ?? 0) + 1;
      total++;
    }
  }
  const mounts = grepCount(
    files.filter((f) => rel(f).endsWith('server/src/index.ts')),
    /^app\.use\('\/api/
  );
  return { total, byMethod, apiMounts: mounts + grepCount(files, /^app\.(get|post)\('/) };
}

/** shared 契约：export interface / export type 各计一次（口径与旧 metrics.md 的「契约类型」一致但改为机器数）。 */
function contracts() {
  const files = walk(path.join(ROOT, 'packages', 'shared', 'src')).filter((f) => CODE_EXT.has(path.extname(f)) && !TEST_RE.test(f));
  return {
    iface: grepCount(files, /^export interface /),
    type: grepCount(files, /^export type /),
    get total() {
      return this.iface + this.type;
    },
  };
}

/** 依赖：包内 dependencies 去掉 workspace 内部引用 = 外部运行时依赖。 */
function deps() {
  const per = {};
  const external = new Set();
  for (const pkg of ['root', ...PKGS]) {
    const p = path.join(ROOT, pkg === 'root' ? 'package.json' : path.join('packages', pkg, 'package.json'));
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const d = Object.keys(j.dependencies ?? {});
    per[pkg] = { runtime: d.length, dev: Object.keys(j.devDependencies ?? {}).length };
    for (const name of d) if (!name.startsWith('@sb/')) external.add(name);
  }
  return { per, externalRuntime: [...external].sort() };
}

/** 迁移水位：所有 migrations-list*.ts 里的 version 数字（代码侧应有值，与线上库实测值分开记）。 */
function migrations() {
  const versions = new Set();
  for (const f of walk(path.join(ROOT, 'packages', 'server', 'src', 'storage'))) {
    if (!/migrations[^/]*\.ts$/.test(f) || TEST_RE.test(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bversion:\s*(\d+)/g)) versions.add(Number(m[1]));
  }
  const v = [...versions].sort((a, b) => a - b);
  return { count: v.length, max: v.at(-1) ?? 0, gaps: v.filter((n, i) => i && n !== v[i - 1] + 1).length };
}

function docs() {
  const top = walk(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md'));
  return {
    specs: top.filter((f) => path.basename(f).includes('SPEC')).length,
    all: top.length,
    dev: top.filter((f) => rel(f).startsWith('docs/dev/')).length,
    probes: walk(path.join(ROOT, 'tools', 'probes')).filter((f) => f.endsWith('.mjs')).length,
  };
}

function repo() {
  const days = 14;
  return {
    head: git(['rev-parse', '--short', 'HEAD']),
    headDate: git(['log', '-1', '--format=%cd', '--date=short']),
    commitsLast14d: Number(git(['rev-list', '--count', `--since=${days} days ago`, 'HEAD']) || 0),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyFiles: git(['status', '--porcelain']).split('\n').filter(Boolean).length,
  };
}

/** vitest 真实结果：--tests 现跑；否则读上一次的 json 产物（读不到就标 null，绝不编数）。 */
function testRun() {
  const out = path.join(ROOT, 'test-results', 'metrics-vitest.json');
  let wallSec = 0;
  if (argv.has('--tests')) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const cli = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    const extra = argv.has('--coverage')
      ? ['--coverage', '--coverage.provider=v8', '--coverage.reporter=json-summary', '--coverage.reportDir=coverage']
      : [];
    const t0 = Date.now();
    try {
      execFileSync(process.execPath, [cli, 'run', '--reporter=json', `--outputFile=${out}`, ...extra], {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
    } catch (e) {
      // vitest 有用例红时退出码非 0——报告文件仍已落盘，照常读，红数由下面如实呈现
      console.error(`⚠️ vitest 退出码非 0（${e.status ?? e.message}），按已写出的报告继续计数`);
    }
    wallSec = +((Date.now() - t0) / 1000).toFixed(1);
  }
  if (!fs.existsSync(out)) return { available: false };
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  const files = j.testResults ?? [];
  return {
    available: true,
    ranNow: wallSec > 0,
    wallSec,
    staleDays: Math.floor((Date.now() - fs.statSync(out).mtimeMs) / 86400000),
    files: files.length,
    cases: j.numTotalTests ?? 0,
    passed: j.numPassedTests ?? 0,
    skipped: (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0),
    failed: j.numFailedTests ?? 0,
    success: j.success === true,
  };
}

/** 覆盖率：读 vitest 的 json-summary，按包做加权（covered/total），不平均百分比。 */
function coverage() {
  const p = path.join(ROOT, 'coverage', 'coverage-summary.json');
  if (!fs.existsSync(p)) return { available: false };
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const mk = () => ({ lines: [0, 0], branches: [0, 0], stmts: [0, 0], funcs: [0, 0] });
  const buckets = { pkg: mk(), total: mk() };
  for (const r of PKGS) buckets[r] = mk();
  const add = (b, key, v) => {
    if (!v) return;
    b[key][0] += v.covered ?? 0;
    b[key][1] += v.total ?? 0;
  };
  const harvest = (b, v) => {
    add(b, 'lines', v.lines);
    add(b, 'branches', v.branches);
    add(b, 'stmts', v.statements);
    add(b, 'funcs', v.functions);
  };
  for (const [file, v] of Object.entries(j)) {
    if (file === 'total') {
      harvest(buckets.total, v);
      continue;
    }
    const m2 = /packages\/(shared|server|web)\//.exec(rel(file));
    if (!m2) continue;
    harvest(buckets[m2[1]], v);
    harvest(buckets.pkg, v);
  }
  const pct = ([c, t]) => (t ? +((c / t) * 100).toFixed(1) : null);
  const fmt = (b) => ({ lines: pct(b.lines), branches: pct(b.branches), stmts: pct(b.stmts), funcs: pct(b.funcs) });
  return {
    available: true,
    staleDays: Math.floor((Date.now() - fs.statSync(p).mtimeMs) / 86400000),
    perPkg: Object.fromEntries(PKGS.map((r) => [r, fmt(buckets[r])])),
    allPackages: fmt(buckets.pkg),
    repoTotal: fmt(buckets.total),
  };
}

/** README 里手抄的数字 vs 实测：只抽徽章与两处基线句，逐条比。漂移即报。 */
function readmeDrift(m) {
  const p = path.join(ROOT, 'README.md');
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  const claims = [];
  const badgeTests = /badge\/tests-([0-9]+)%20files%20%2F%20([0-9]+)%20cases/.exec(text);
  if (badgeTests && m.tests.available) {
    claims.push({
      label: 'badge 测试文件',
      claimed: badgeTests[1],
      measured: String(m.tests.files),
      ok: badgeTests[1] === String(m.tests.files),
    });
    claims.push({
      label: 'badge 测试用例',
      claimed: badgeTests[2],
      measured: String(m.tests.cases),
      ok: badgeTests[2] === String(m.tests.cases),
    });
  }
  const badgeRoutes = /badge\/REST%20routes-([0-9]+)/.exec(text);
  if (badgeRoutes) claims.push({ label: 'badge REST 路由', claimed: badgeRoutes[1], measured: String(m.routes.total), ok: badgeRoutes[1] === String(m.routes.total) });
  const badgeContracts = /badge\/shared%20contracts-([0-9]+)/.exec(text);
  if (badgeContracts) claims.push({ label: 'badge 契约类型', claimed: badgeContracts[1], measured: String(m.contracts.total), ok: badgeContracts[1] === String(m.contracts.total) });
  const badgeDeps = /badge\/external%20runtime%20deps-([0-9]+)/.exec(text);
  if (badgeDeps) claims.push({ label: 'badge 外部运行时依赖', claimed: badgeDeps[1], measured: String(m.deps.externalRuntime.length), ok: badgeDeps[1] === String(m.deps.externalRuntime.length) });
  // ★ 2026-09-21 修：原实现 `/badge\/node-[^-]+-([0-9.]+)/` **匹配不上本仓徽章的真实格式**
  //   （README 写的是 `badge/node-%E2%89%A522.11-blue`，`%E2%89%A5` ＝ URL 编码的 `≥`）
  //   ⇒ 该条**从未入列**；而且它的 `ok: true` 是**硬编码** ⇒ 即便入列也永远不可能红。
  //   ★ 实测取证：把 README 的 `≥22.11` 改成 `≥18`（严重违反 `engines`）⇒ `--check` 仍 **EXIT=0**、
  //   输出里没有这一行；对照把 `REST routes-149` 改成 `148` ⇒ **EXIT=1** 且该行 ❌。
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const majMin = (v) => (v ? String(v).match(/\d+(?:\.\d+)*/)?.[0]?.split('.').slice(0, 2).join('.') ?? null : null);
  const badgeNode = /badge\/node-([^)]+?)-([a-zA-Z0-9_]+)\)/.exec(text);
  if (badgeNode) {
    const claimed = majMin(decodeURIComponent(badgeNode[1]));   // "≥22.11" → "22.11"
    const engines = pkg.engines?.node ?? '';
    claims.push({ label: 'badge Node 下限', claimed, measured: engines, ok: !!claimed && claimed === majMin(engines) });
  }
  // 版本徽章：`version-2.0.0--alpha.0`（shields 用 `--` 转义 `-`）vs `package.json` 的 version
  const badgeVer = /badge\/version-([^)]+?)-([a-zA-Z0-9_]+)\)/.exec(text);
  if (badgeVer) {
    const claimed = badgeVer[1].replace(/--/g, '-');
    claims.push({ label: 'badge 版本', claimed, measured: pkg.version, ok: claimed === pkg.version });
  }
  // ★ 2026-09-24 加：**线上现况版本**（README 导语「已上线到 vX.Y.Z」）。
  //   起因是实测到的一个**自我矛盾**：README 同一格里的导语写着 `v0.2.112`，而紧跟它的两句已经自纠到 v0.2.118
  //   ⇒ 那不是假事实，是**旧导语**，所以只查「数字对不对得上实测」的这几条一条都没拦到（`v0.2.112` 曾是真实现况）。
  //   对账点选**公开清洗表 `PUBLIC_RELEASES` 的最高版本**而不是 `package.json` 的 version：
  //   那页是全站唯一对外宣称「线上有什么」的一份内容，而 `package.json` 是本地安装包版——**它通常领先线上**，拿它当现况会把导语推向另一个错处。
  const changelogPublic = path.join(ROOT, 'packages/web/src/seo/changelog-public.ts');
  if (fs.existsSync(changelogPublic)) {
    const nums = [...fs.readFileSync(changelogPublic, 'utf8').matchAll(/version:\s*'v(\d+)\.(\d+)\.(\d+)'/g)]
      .map((g) => [Number(g[1]), Number(g[2]), Number(g[3])])
      .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
    const top = nums.length ? `v${nums[0].join('.')}` : '(清洗表里没有 version 条目)';
    const liveVer = /已上线到\s*\*{0,2}\s*v(\d+\.\d+\.\d+)/.exec(text);
    if (liveVer) claims.push({ label: '线上现况版本', claimed: `v${liveVer[1]}`, measured: top, ok: `v${liveVer[1]}` === top });
  }
  // ★ 同批加：**正文那句 `N passed + M skipped + K failed`**。
  //   它紧邻的「N 文件 / M 例」有「正文基线句」守着，这一半**从来没有对账** ⇒ 实测抓到它是上一批留下的旧数
  //   （基线已写成 2886 例，同一句里还写着 2869 passed；正确值 2885）——**新基线旁边挂着旧明细，肉眼看不出来**。
  if (m.tests.available) {
    for (const g of text.matchAll(/(\d+) passed \+ (\d+) skipped \+ (\d+) failed/g)) {
      claims.push({
        label: '正文 passed 口径',
        claimed: `${g[1]} passed + ${g[2]} skipped + ${g[3]} failed`,
        measured: `${m.tests.passed} passed + ${m.tests.skipped} skipped + ${m.tests.failed} failed`,
        ok: g[1] === String(m.tests.passed) && g[2] === String(m.tests.skipped) && g[3] === String(m.tests.failed),
      });
    }
  }
  const prose = [...text.matchAll(/(\d+) 文件 \/ (\d+) 例/g)];
  for (const g of prose) {
    if (!m.tests.available) break;
    claims.push({
      label: '正文基线句',
      claimed: `${g[1]} 文件 / ${g[2]} 例`,
      measured: `${m.tests.files} 文件 / ${m.tests.cases} 例`,
      ok: g[1] === String(m.tests.files) && g[2] === String(m.tests.cases),
    });
  }
  // ★ 2026-09-21 加：**防「静默消失」** —— 上面每条都是「找得到才入列」，于是徽章被改名/删掉时
  //   检查会**无声地不存在**（本仓刚发生过：Node 那条就是这么没的，谁都没发现）。
  //   故对「实测值必然可得」的几条做**存在性断言**：该在的没在 ⇒ 报 ❌，而不是当作通过。
  const REQUIRED = ['badge REST 路由', 'badge 契约类型', 'badge 外部运行时依赖', 'badge Node 下限', 'badge 版本', '线上现况版本'];
  if (m.tests.available) REQUIRED.push('badge 测试文件', 'badge 测试用例');
  const seen = new Set(claims.map((c) => c.label));
  for (const label of REQUIRED) {
    if (!seen.has(label)) claims.push({ label, claimed: '(README 里找不到该对账项)', measured: '—', ok: false });
  }
  return claims.filter((c) => c.claimed !== null);
}

/**
 * `Landing.tsx` 首屏那四个统计数字 vs 实测：漂移即报。
 *
 * 为什么单列一条：README 徽章与正文有 `readmeDrift` 守着，而**首屏数字此前没有任何东西守着**
 * （`Landing.tsx` 自己的注释就写着「这里没有」）—— 它已经漂移过一次
 * （`2300+ 自动化测试` / `140 个 REST 接口` → `2600+` / `149`）。
 * **精确的旧值比模糊表述更危险**：它看起来像真的，而首屏是访客第一眼看到的地方。
 *
 * 两条口径不同，别混：
 *   - **精确档**（`6 个运行时依赖` / `149 个 REST 接口` / `0 个第三方 UI 库`）：与实测**逐字相等**。
 *   - **模糊档**（`2600+ 自动化测试`）：语义是「**至少** N」⇒ 只要求实测落在 `[N, N+100)`；
 *     涨到下一档就该更新文案，掉下来则说明这个数字吹了。
 */
function landingDrift(m) {
  const p = path.join(ROOT, 'packages/web/src/app/Landing.tsx');
  if (!fs.existsSync(p)) return [];
  const block = /<div className="landing-stats"[^>]*>([\s\S]*?)<\/div>/.exec(fs.readFileSync(p, 'utf8'));
  if (!block) return [{ label: '首屏统计块', claimed: 'landing-stats', measured: '(未找到)', ok: false }];
  const claims = [];
  for (const span of [...block[1].matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1].trim())) {
    let g;
    if ((g = /^(\d+)\+ 自动化测试$/.exec(span))) {
      const low = Number(g[1]);
      claims.push({
        label: '首屏 自动化测试（模糊档）',
        claimed: `${low}+`,
        measured: m.tests.available ? String(m.tests.cases) : '(未测)',
        ok: m.tests.available && m.tests.cases >= low && m.tests.cases < low + 100,
      });
    } else if ((g = /^(\d+) 个运行时依赖$/.exec(span))) {
      claims.push({ label: '首屏 运行时依赖', claimed: g[1], measured: String(m.deps.externalRuntime.length), ok: g[1] === String(m.deps.externalRuntime.length) });
    } else if ((g = /^(\d+) 个 REST 接口$/.exec(span))) {
      claims.push({ label: '首屏 REST 接口', claimed: g[1], measured: String(m.routes.total), ok: g[1] === String(m.routes.total) });
    } else if ((g = /^(\d+) 个第三方 UI 库$/.exec(span))) {
      const wdeps = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/web/package.json'), 'utf8')).dependencies ?? {};
      const thirdPartyUi = Object.keys(wdeps).filter((d) => d !== 'react' && d !== 'react-dom' && !d.startsWith('@sb/')).length;
      claims.push({ label: '首屏 第三方 UI 库', claimed: g[1], measured: String(thirdPartyUi), ok: g[1] === String(thirdPartyUi) });
    } else {
      claims.push({ label: '首屏 未识别项', claimed: span, measured: '(无对应实测口径)', ok: false });
    }
  }
  return claims;
}

function table(m) {
  const L = [];
  const pad = (s, n) => String(s).padEnd(n);
  L.push('## 工程规模（源码 / 测试行数，按包）');
  L.push('');
  L.push(`| 包 | 源码文件 | 源码行 | 测试文件 | 测试行 | 测试/源码 |`);
  L.push('|---|---|---|---|---|---|');
  for (const r of m.code.rows) {
    L.push(`| ${r.pkg} | ${r.srcFiles} | ${r.srcLines.toLocaleString()} | ${r.testFiles} | ${r.testLines.toLocaleString()} | ${r.srcLines ? ((r.testLines / r.srcLines) * 100).toFixed(0) : 0}% |`);
  }
  L.push(`| **合计** | **${m.code.srcFiles}** | **${m.code.srcLines.toLocaleString()}** | **${m.code.testFiles}** | **${m.code.testLines.toLocaleString()}** | **${((m.code.testLines / m.code.srcLines) * 100).toFixed(0)}%** |`);
  L.push('');
  L.push('## 接口与契约');
  L.push('');
  L.push(`- REST 路由注册：**${m.routes.total}**（${Object.entries(m.routes.byMethod).map(([k, v]) => `${k} ${v}`).join(' / ')}）· 另 /api 挂载点 ${m.routes.apiMounts} 个`);
  L.push(`- shared 契约类型：**${m.contracts.total}**（export interface ${m.contracts.iface} + export type ${m.contracts.type}）`);
  L.push(`- 外部运行时依赖：**${m.deps.externalRuntime.length}** 个 —— ${m.deps.externalRuntime.join(', ')}`);
  L.push(`- 迁移水位：代码侧 **v${m.migrations.max}**（${m.migrations.count} 个 version 条目，非连续号 ${m.migrations.gaps} 处）`);
  L.push('');
  L.push('## 测试基线（vitest 实跑）');
  L.push('');
  if (m.tests.available) {
    const verdict = m.tests.failed === 0 && m.tests.success ? '全绿' : `**${m.tests.failed} 红**`;
    L.push(`- **${m.tests.files} 文件 / ${m.tests.cases} 例**（${m.tests.passed} passed + ${m.tests.skipped} skipped + ${m.tests.failed} failed）⇒ ${verdict}`);
    if (m.tests.ranNow) L.push(`- 本次本机实跑（Node ${process.version}）全量耗时 ${m.tests.wallSec}s`);
    else L.push(`- ⚠️ 本次未重跑 vitest，读的是 ${m.tests.staleDays === 0 ? '今日' : m.tests.staleDays + ' 天前'}的 test-results 产物——要新鲜数字加 \`--tests\``);
  } else {
    L.push('- ⬜ 无 vitest 产物（跑 `node tools/metrics.mjs --tests` 生成，**不编数**）');
  }
  L.push(`- jsdom 交互测试文件（\`.test.tsx\`）${m.code.tsxTestFiles} 个`);
  L.push('');
  L.push('## 覆盖率（v8，按包加权 covered/total，非百分比平均）');
  L.push('');
  if (m.coverage.available) {
    L.push('| 范围 | Lines | Branches | Stmts | Funcs |');
    L.push('|---|---|---|---|---|');
    const row = (name, o) => `| ${name} | ${o.lines ?? '—'}% | ${o.branches ?? '—'}% | ${o.stmts ?? '—'}% | ${o.funcs ?? '—'}% |`;
    for (const r of PKGS) L.push(row(r, m.coverage.perPkg[r]));
    L.push(row(`**三包合计**`, m.coverage.allPackages));
    L.push(`- ⚠️ 口径：分母只含 vitest 实际 import 到的源文件（未跑到 0% 的模块不进 json-summary 的按包聚合），故本表**只能用于同版本自身纵向对比**，不能与外部项目横比。`);
    if (m.coverage.staleDays > 0) L.push(`- ⚠️ 覆盖率产物是 ${m.coverage.staleDays} 天前的（本次未跑 \`--coverage\`）`);
  } else {
    L.push('- ⬜ 无覆盖率产物（跑 `node tools/metrics.mjs --tests --coverage` 生成，**不编数**）');
  }
  L.push('');
  L.push('## 文档与仓库');
  L.push(`- docs/：SPEC 契约 ${m.docs.specs} 份 · md 共 ${m.docs.all} 份（dev/ ${m.docs.dev}）· 真机探针 ${m.docs.probes} 个`);
  L.push(`- git：${m.repo.branch} @ \`${m.repo.head}\`（${m.repo.headDate}）· 近 14 天 ${m.repo.commitsLast14d} commits · 工作区未提交 ${m.repo.dirtyFiles} 文件`);
  return L.join('\n');
}

function writeDocs(m, body) {
  const p = path.join(ROOT, 'docs', 'metrics.md');
  const B = '<!-- metrics:begin —— 以下由 tools/metrics.mjs --write-docs 回填，勿手改 -->';
  const E = '<!-- metrics:end -->';
  let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : `${B}\n${E}\n`;
  const block = `${B}\n\n> 采集：${new Date().toLocaleString('sv-SE')}（本机时区）｜ 基准 \`${m.repo.head}\` ｜ 复现：\`node tools/metrics.mjs --tests --coverage\`\n\n${body}\n\n${E}`;
  if (text.includes(B) && text.includes(E)) {
    text = text.slice(0, text.indexOf(B)) + block + text.slice(text.indexOf(E) + E.length);
  } else {
    text = `${text.trimEnd()}\n\n${block}\n`;
  }
  fs.writeFileSync(p, text);
  return p;
}

const m = {
  generatedAt: new Date().toISOString(),
  code: codeSize(),
  routes: restRoutes(),
  contracts: contracts(),
  migrations: migrations(),
  deps: deps(),
  docs: docs(),
  repo: repo(),
};
m.tests = testRun();
m.coverage = coverage();
m.readmeDrift = readmeDrift(m);
m.landingDrift = landingDrift(m);

const body = table(m);
// ★ 2026-09-21 修：`--check` 必须**只读**。原实现无条件写 `docs/metrics.json`，
//   于是「跑一次对账就把工作树弄脏」（实测：刚提交完该文件，连跑两次 `--check` 它就立刻变 `M`），
//   而且会把**当次的瞬时状态**（`dirtyFiles` / `generatedAt`）刷进快照 ⇒ 提交进去的
//   到底是「哪一刻的仓库」全凭最后一次 `--check` 落在什么时候。
//   一个「检查」命令改工作区，还会让 diff 混进与本次改动无关的噪声、容易被误提交。
//   （同文件里 `writeDocs` 用的就是 opt-in 范式：只在 `--write-docs` 时才写 `docs/metrics.md`。）
if (argv.has('--check')) {
  // 只读：不写 docs/metrics.json（提示语在末尾打印，免得插在对账表前面）
} else {
  fs.writeFileSync(path.join(ROOT, 'docs', 'metrics.json'), JSON.stringify(m, null, 2) + '\n');
}
if (argv.has('--write-docs')) writeDocs(m, body);

console.log(body);
const drift = m.readmeDrift.filter((c) => !c.ok);
if (m.readmeDrift.length) {
  console.log('\n## README 手抄数字对账');
  for (const c of m.readmeDrift) {
    console.log(`| ${c.ok ? '✅' : '❌'} | ${c.label} | README: ${c.claimed} | 实测: ${c.measured} |`);
  }
}
if (drift.length) console.log(`\n✗ README 有 ${drift.length} 处数字与实测不符`);
else console.log('\n✓ README 可核对数字与实测一致');

// ★ 首屏（Landing.tsx）那四个数字：此前没有任何东西守着，它已经漂移过一次
const landingBad = m.landingDrift.filter((c) => !c.ok);
if (m.landingDrift.length) {
  console.log('\n## 首屏（Landing.tsx）统计数字对账');
  for (const c of m.landingDrift) {
    console.log(`| ${c.ok ? '✅' : '❌'} | ${c.label} | 首屏: ${c.claimed} | 实测: ${c.measured} |`);
  }
}
if (landingBad.length) console.log(`\n✗ 首屏有 ${landingBad.length} 处数字与实测不符`);
else console.log('\n✓ 首屏可核对数字与实测一致');
if (argv.has('--check')) {
  console.log('\n(--check：只读，未写 docs/metrics.json；要刷新快照请不带标志跑一次 `node tools/metrics.mjs`)');
  if (drift.length || landingBad.length) process.exitCode = 1;
}
