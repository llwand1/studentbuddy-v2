#!/usr/bin/env node
/**
 * tools/guard-audit.mjs — 守门判别力审计器。
 *
 * 为什么要有它（2026-09-21 的教训）：本仓的「守门」（`metrics --check` 的手抄数字对账、
 * `gates` 的红线）会打出 `✅`，但**打出 ✅ 不等于它真的在守**。当天实测逮到一条：
 * `metrics.mjs` 的 `badge Node 下限` —— 正则匹配不上徽章真实格式（从未入列）＋ `ok: true`
 * 是硬编码（即便入列也永远不可能红）。**两条毛病都不报错，输出里那一行还老老实实打着 ✅。**
 *
 * ⇒ 结论：**光看输出永远分辨不出「真守门」和「空气」**。唯一的手段是
 *   **对每一条守门逐个「改坏 → 看它是否报红 → 恢复」**，并且**一条不落**（不能抽查：
 *   抽查只能证明抽到的那几条是真的，而空气恰恰藏在没抽到的地方）。
 *
 * 本脚本就是把那件事固化成一条命令。
 *
 * ★★ 隔离原则（本仓常有并行会话在写，改坏守门要动真文件 ⇒ 一律在副本里做）：
 *   把「被测工具会读的那几样」拷到临时目录，在**副本**里改坏、跑**副本**里的工具。
 *   两个被测工具的 ROOT 都是由脚本自身位置推导的（`import.meta.dirname/..`、
 *   `new URL('../..', import.meta.url)`）⇒ 拷过去就自成一套，**不需要 node_modules**。
 *   因此本脚本**全程不写工作树**（收尾还会用 git 双向核对证明这一点）。
 *
 * 用法：
 *   node tools/guard-audit.mjs           全量审计（metrics 的 13 条 claim + gates 的 4 条红线）
 *   node tools/guard-audit.mjs --list    只列守门清单，不跑
 *   node tools/guard-audit.mjs --metrics 只审 metrics
 *   node tools/guard-audit.mjs --gates   只审 gates
 *   node tools/guard-audit.mjs --keep    保留临时副本（排障用）
 *
 * 退出码：0 = 全部守门都有判别力；1 = 有守门是空气（或基线就不绿）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = new Set(process.argv.slice(2));
const KEEP = argv.has('--keep');
const ONLY = argv.has('--metrics') ? 'metrics' : argv.has('--gates') ? 'gates' : 'all';

// ── 副本要拷的东西 ────────────────────────────────────────────────────────────
// metrics 读：README / 各 package.json / packages/*/src / docs/*.md / tools/probes / test-results / coverage
// gates   读：packages/*/src / docs/dev/test-plan.md
// node_modules 是唯一的大件，必须排除（两个工具都只用 node 内置模块）。
const COPY_RELS = [
  'README.md',
  'package.json',
  'packages',
  'docs',
  'tools',
  'test-results/metrics-vitest.json',
  'coverage/coverage-summary.json',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const copyFilter = (src) => !SKIP_DIRS.has(path.basename(src));

// ── 断言用的字面量（与两个被测脚本里的 label / 违规前缀对齐；基线会逐条校验它们都在）──
const METRICS_LABELS = [
  'badge 测试文件',
  'badge 测试用例',
  'badge REST 路由',
  'badge 契约类型',
  'badge 外部运行时依赖',
  'badge Node 下限',
  'badge 版本',
  '正文基线句', // 出现 2 次
  '首屏 自动化测试（模糊档）',
  '首屏 运行时依赖',
  '首屏 REST 接口',
  '首屏 第三方 UI 库',
];
const METRICS_ROW_TOTAL = 13;

// ── 工具函数 ──────────────────────────────────────────────────────────────────
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const rmIf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } };

/** 替换第 nth（0 基）个匹配；re 必须带 g 标志 */
function replaceNth(text, re, nth, fn) {
  let i = 0;
  return text.replace(re, (...args) => (i++ === nth ? fn(...args) : args[0]));
}

/** 把 `N` 挪成 `N+delta`（字符串形态，保留原样） */
const shift = (n, delta) => String(Number(n) + delta);

/**
 * ★★ 只在 `landing-stats` 块**内部**改坏（2026-09-21 踩过的坑）。
 *
 * 首屏那四个数字被两处文字提到：① 真正被守门读的 `<span>`；② `Landing.tsx` 里的**注释**
 * （写着「此前 2300+ 自动化测试 / 140 个 REST 接口」这类历史值）。
 * 用 `/(\d+)\+ 自动化测试/` 这种"全文件第一个匹配"去改坏，会**改到注释**上 ——
 * 文件确实变了（`after !== before` 也成立），但**守门读的那块没动** ⇒ 检查照样 EXIT=0，
 * 于是**误判「这条守门没判别力」**。教训：**改坏必须落在守门真正读的那段文本上**。
 * ⇒ 先取出块，块内改坏，再拼回；并断言**块内确实变了**（不是文件变了就算数）。
 */
function mutateInLandingBlock(text, fn) {
  const re = /(<div className="landing-stats"[^>]*>)([\s\S]*?)(<\/div>)/;
  const m = re.exec(text);
  if (!m) throw new Error('找不到 landing-stats 块');
  const mutated = fn(m[2]);
  if (mutated === m[2]) throw new Error('块内改坏未生效（正则没匹配到块里的内容）');
  return text.slice(0, m.index) + m[1] + mutated + m[3] + text.slice(m.index + m[0].length);
}

// ── 用例定义 ──────────────────────────────────────────────────────────────────
// 每条：{ group, name, label（期望报红的 claim label 或违规前缀）, file, mutate(text) -> text }
// ★ 改坏量都**从当前内容现算**（不写死数字）⇒ 以后 README 数字更新了，本脚本不用改。
const METRICS_CASES = [
  {
    name: 'badge 测试文件（文件数 −1）',
    label: 'badge 测试文件',
    file: 'README.md',
    mutate: (t) => t.replace(/(badge\/tests-)(\d+)(%20files)/, (m, a, n, b) => a + shift(n, -1) + b),
  },
  {
    name: 'badge 测试用例（例数 −1）',
    label: 'badge 测试用例',
    file: 'README.md',
    mutate: (t) => t.replace(/(%2F%20)(\d+)(%20cases)/, (m, a, n, b) => a + shift(n, -1) + b),
  },
  {
    name: 'badge REST 路由（−1）',
    label: 'badge REST 路由',
    file: 'README.md',
    mutate: (t) => t.replace(/(badge\/REST%20routes-)(\d+)/, (m, a, n) => a + shift(n, -1)),
  },
  {
    name: 'badge 契约类型（−1）',
    label: 'badge 契约类型',
    file: 'README.md',
    mutate: (t) => t.replace(/(badge\/shared%20contracts-)(\d+)/, (m, a, n) => a + shift(n, -1)),
  },
  {
    name: 'badge 外部运行时依赖（+1）',
    label: 'badge 外部运行时依赖',
    file: 'README.md',
    mutate: (t) => t.replace(/(badge\/external%20runtime%20deps-)(\d+)/, (m, a, n) => a + shift(n, 1)),
  },
  {
    name: 'badge Node 下限（改成 ≥1.0）',
    label: 'badge Node 下限',
    file: 'README.md',
    mutate: (t) => t.replace(/(badge\/node-)[^)]+?(-[a-zA-Z0-9_]+\))/, '$1%E2%89%A51.0$2'),
  },
  {
    name: 'badge 版本（改成 0.0.0）',
    label: 'badge 版本',
    file: 'README.md',
    mutate: (t) => t.replace(/(badge\/version-)[^)]+?(-[a-zA-Z0-9_]+\))/, '$10.0.0$2'),
  },
  {
    name: '正文基线句 #1（第 1 处的文件数 −1）',
    label: '正文基线句',
    file: 'README.md',
    mutate: (t) => replaceNth(t, /(\d+) 文件 \/ (\d+) 例/g, 0, (m, a, b) => `${shift(a, -1)} 文件 / ${b} 例`),
  },
  {
    name: '正文基线句 #2（第 2 处的例数 −1）',
    label: '正文基线句',
    file: 'README.md',
    mutate: (t) => replaceNth(t, /(\d+) 文件 \/ (\d+) 例/g, 1, (m, a, b) => `${a} 文件 / ${shift(b, -1)} 例`),
  },
  {
    name: '★ 防静默消失：删掉 node 徽章（整行只剩图片语法壳）',
    label: 'badge Node 下限',
    file: 'README.md',
    mutate: (t) => t.replace(/!\[node\]\([^)]*\)/, '![node]()'),
  },
  {
    name: '首屏 自动化测试（模糊档下越界：−1000）',
    label: '首屏 自动化测试（模糊档）',
    file: 'packages/web/src/app/Landing.tsx',
    mutate: (t) => mutateInLandingBlock(t, (b) => b.replace(/(\d+)\+ 自动化测试/, (m, n) => `${shift(n, -1000)}+ 自动化测试`)),
  },
  {
    name: '首屏 自动化测试（模糊档上越界：+100）',
    label: '首屏 自动化测试（模糊档）',
    file: 'packages/web/src/app/Landing.tsx',
    mutate: (t) => mutateInLandingBlock(t, (b) => b.replace(/(\d+)\+ 自动化测试/, (m, n) => `${shift(n, 100)}+ 自动化测试`)),
  },
  {
    name: '首屏 运行时依赖（+1）',
    label: '首屏 运行时依赖',
    file: 'packages/web/src/app/Landing.tsx',
    mutate: (t) => mutateInLandingBlock(t, (b) => b.replace(/(\d+) 个运行时依赖/, (m, n) => `${shift(n, 1)} 个运行时依赖`)),
  },
  {
    name: '首屏 REST 接口（−1）',
    label: '首屏 REST 接口',
    file: 'packages/web/src/app/Landing.tsx',
    mutate: (t) => mutateInLandingBlock(t, (b) => b.replace(/(\d+) 个 REST 接口/, (m, n) => `${shift(n, -1)} 个 REST 接口`)),
  },
  {
    name: '首屏 第三方 UI 库（+1）',
    label: '首屏 第三方 UI 库',
    file: 'packages/web/src/app/Landing.tsx',
    mutate: (t) => mutateInLandingBlock(t, (b) => b.replace(/(\d+) 个第三方 UI 库/, (m, n) => `${shift(n, 1)} 个第三方 UI 库`)),
  },
  {
    name: '首屏 未识别项（span 改成无法解析的文案）',
    label: '首屏 未识别项',
    file: 'packages/web/src/app/Landing.tsx',
    mutate: (t) => mutateInLandingBlock(t, (b) => b.replace(/<span>\d+ 个运行时依赖<\/span>/, '<span>六个依赖</span>')),
  },
];

const GATES_CASES = [
  {
    name: '① 行数红线（web .tsx 306 行）',
    expect: '[行数]',
    probe: 'packages/web/src/__guard_audit_long.tsx',
    content: () => ['export const A = () => <div />;', ...Array.from({ length: 305 }, (_, i) => `// pad ${i + 1}`)].join('\n'),
  },
  {
    name: '② 内联样式红线（style={{）',
    expect: '[内联样式]',
    probe: 'packages/web/src/__guard_audit_style.tsx',
    content: () => "export const B = () => <div style={{ color: 'red' }} />;\n",
  },
  {
    name: '③ any 红线（: any）',
    expect: '[any]',
    probe: 'packages/web/src/__guard_audit_any.ts',
    content: () => 'export const c: any = 1;\n',
  },
  {
    name: '④ 测试登记红线（新测试未在 test-plan 成行）',
    expect: '[测试登记]',
    probe: 'packages/web/src/__guard_audit.test.ts',
    content: () => "import { it } from 'vitest';\nit('x', () => {});\n",
  },
  {
    name: '④b 测试登记红线（幽灵行：登记了但文件不在）',
    expect: '幽灵行',
    append: { file: 'docs/dev/test-plan.md', text: '\n幽灵探针：`src/__guard_audit_ghost.test.ts`\n' },
  },
];

// ── 副本准备 ──────────────────────────────────────────────────────────────────
function buildTemplate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-guard-audit-'));
  for (const rel of COPY_RELS) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, filter: copyFilter });
  }
  return dir;
}

let WORK = null;
let TEMPLATE = null;

/** 把工作副本里的若干文件恢复成模板态；并**自证**恢复成功（本仓踩过「清理没生效 ⇒ 用例互相污染」）*/
function restore(rels) {
  for (const rel of rels) {
    const w = path.join(WORK, rel);
    const t = path.join(TEMPLATE, rel);
    if (fs.existsSync(t)) {
      fs.copyFileSync(t, w);
      if (!fs.readFileSync(t).equals(fs.readFileSync(w))) throw new Error(`恢复失败（内容不一致）：${rel}`);
    } else {
      rmIf(w);
      if (fs.existsSync(w)) throw new Error(`恢复失败（未删掉）：${rel}`);
    }
  }
}

const runIn = (rel, args = []) => {
  const r = spawnSync(process.execPath, [path.join(WORK, rel), ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const metricsRows = (out) => out.split(/\r?\n/).filter((l) => /^\| (✅|❌) \|/.test(l));
const rowCount = (out, mark, label) => metricsRows(out).filter((l) => l.startsWith(`| ${mark} |`) && l.includes(`| ${label} |`)).length;

/**
 * 把对账表解析成 {mark, label, claimed, measured}。
 * ★★ 为什么需要它：**「文件被改了」不等于「守门读的那段被改了」**（见 mutateInLandingBlock 的教训）。
 * 所以每例改坏后要断言「该 label 的 `claimed` 相对基线**真的变了**」——
 * 这才是「改坏落到了守门读的文本上」的证据；否则该例结论无效（是脚本没改对地方，不是守门不行）。
 */
const parseRows = (out) => out.split(/\r?\n/)
  .map((l) => /^\| (✅|❌) \| (.+?) \| (?:README|首屏): (.*?) \| 实测: (.*?) \|$/.exec(l))
  .filter(Boolean)
  .map((m) => ({ mark: m[1], label: m[2], claimed: m[3], measured: m[4] }));

// ── --list ────────────────────────────────────────────────────────────────────
if (argv.has('--list')) {
  console.log(`metrics --check：${METRICS_LABELS.length} 类 label（含「正文基线句」出现 2 次）⇒ 基线应 ${METRICS_ROW_TOTAL} 行`);
  for (const c of METRICS_CASES) console.log(`  · [metrics] ${c.name}`);
  console.log(`gates/check.mjs：4 条红线`);
  for (const c of GATES_CASES) console.log(`  · [gates]   ${c.name}`);
  console.log(`\n合计 ${METRICS_CASES.length + GATES_CASES.length} 个改坏场景。`);
  process.exit(0);
}

// ── --selftest：审计器自己的判别力（谁来审计审计器）────────────────────────────
// ★★ 不做这一步，本脚本就**正好是本脚本要防的那种东西**：一个自称在检查、却从未被检查过的守门。
// 手法同本脚本对别人的手法：**在副本里故意把一条守门弄成空气，看本脚本会不会报出来。**
// 三个方向各打一枪：① 结论写死（ok: true）② 红线放宽 ③ label 改名（守门静默消失）。
if (argv.has('--selftest')) {
  const SABOTAGES = [
    {
      name: '把 metrics 的「badge 版本」守门改成恒真（`ok: true`）',
      file: 'tools/metrics.mjs',
      from: 'ok: claimed === pkg.version',
      to: 'ok: true',
      args: ['--metrics'],
      expect: '无判别力',
      expectName: 'badge 版本',
    },
    {
      name: '把 gates 的行数红线放宽到 9999',
      file: 'tools/gates/check.mjs',
      from: "ext === '.tsx' ? 300 :",
      to: "ext === '.tsx' ? 9999 :",
      args: ['--gates'],
      expect: '无判别力',
      expectName: '行数红线',
    },
    {
      name: '把 metrics 的「badge REST 路由」label 改名（守门静默消失）',
      file: 'tools/metrics.mjs',
      from: "label: 'badge REST 路由'",
      to: "label: 'badge REST 路由X'",
      args: ['--metrics'],
      // ★ 实测：这一枪由 **metrics 自己的存在性断言**先接住（REQUIRED 清单里仍写着原名
      //   ⇒ 补一行 `❌ (README 里找不到该徽章)`）⇒ 审计器报「基线不绿」并把那行打出来。
      //   本脚本的 label 契约检查因此被**遮蔽**（那行 ❌ 用的还是原 label）—— 属正常的纵深防御。
      expect: '基线不绿',
      expectName: 'badge REST 路由',
    },
    {
      name: '把首屏「REST 接口」label 改名（★ 这一类**没有**存在性断言保护）',
      file: 'tools/metrics.mjs',
      from: "label: '首屏 REST 接口'",
      to: "label: '首屏 REST 接口X'",
      args: ['--metrics'],
      // ★ 这一枪专门验「label 契约」检查**自己**有没有判别力：上一枪被 metrics 自己的
      //   存在性断言接住了（遮蔽），而首屏这四条没有那层保护 ⇒ 只能靠本脚本的契约检查。
      //   不补这一枪，契约检查就正好是「从未被检查过的检查」。
      expect: '找不到 label',
      expectName: '首屏 REST 接口',
    },
  ];

  const dir = buildTemplate();
  const runAudit = (args) => {
    const r = spawnSync(process.execPath, [path.join(dir, 'tools/guard-audit.mjs'), ...args], { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const pristine = (rel) => { const t = path.join(TEMPLATE_SRC, rel); fs.copyFileSync(t, path.join(dir, rel)); };
  const TEMPLATE_SRC = `${dir}-pristine`;
  fs.cpSync(dir, TEMPLATE_SRC, { recursive: true, filter: copyFilter });

  let bad = 0;
  try {
    console.log('=== 自测：先证明审计器在干净副本上判「全绿」===');
    const base = runAudit([]);
    const baseOk = base.code === 0 && base.out.includes('✓ 全部守门都有判别力');
    console.log(`干净副本全量审计：EXIT=${base.code}（期望 0）→ ${baseOk ? '✅' : '❌'}`);
    if (!baseOk) bad++;
    console.log();
    console.log('=== 自测：逐条制造空气守门，审计器必须报出来 ===');
    console.log('| 故意弄坏的守门 | 审计器 EXIT | 是否点出问题 | 判定 |');
    console.log('|---|---|---|---|');
    for (const s of SABOTAGES) {
      pristine(s.file);
      const p = path.join(dir, s.file);
      const src = fs.readFileSync(p, 'utf8');
      if (!src.includes(s.from)) {
        console.log(`| ${s.name} | — | — | ⚠️ 注入失败：模式未找到（被测脚本改过了，自测需同步） |`);
        bad++;
        continue;
      }
      fs.writeFileSync(p, src.replace(s.from, s.to));
      const r = runAudit(s.args);
      const caught = r.code === 1 && r.out.includes(s.expect) && r.out.includes(s.expectName);
      if (!caught) bad++;
      console.log(`| ${s.name} | ${r.code} | ${caught ? '✓' : '✗'} | ${caught ? '✅ 抓到了' : '❌ **漏报**'} |`);
      pristine(s.file);
    }
  } finally {
    rmIf(TEMPLATE_SRC);
    rmIf(dir);
  }
  console.log();
  console.log(bad === 0 ? '✓ 自测通过：审计器对「空气守门」有判别力' : `✗ 自测失败：${bad} 项`);
  process.exit(bad === 0 ? 0 : 1);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const gitStatus = () => {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout || '').trim();
};
const statusBefore = gitStatus();

let failed = 0;
try {
  TEMPLATE = buildTemplate();
  // ★ 工作副本必须是模板的**同级**目录：cpSync 不允许把目录拷进它自己的子目录
  WORK = `${TEMPLATE}-work`;
  fs.cpSync(TEMPLATE, WORK, { recursive: true, filter: copyFilter });
  console.log(`隔离副本：${WORK}`);
  console.log(`（不写工作树；被测工具的 ROOT 由自身位置推导 ⇒ 副本自成一套，不需要 node_modules）`);
  console.log();

  const rows = [];
  const note = (s = '') => console.log(s);
  let baseClaimed = new Map(); // label → Set(claimed)，供「改坏有没有落到守门读的文本上」断言用

  // ── 基线 ──
  if (ONLY !== 'gates') {
    const r = runIn('tools/metrics.mjs', ['--check']);
    const rows0 = metricsRows(r.out);
    const nPass = rows0.filter((l) => l.startsWith('| ✅ |')).length;
    const nFail = rows0.filter((l) => l.startsWith('| ❌ |')).length;
    note('=== 基线 A：metrics --check ===');
    note(`EXIT=${r.code}  ✅=${nPass}  ❌=${nFail}  （期望 EXIT=0、❌=0、✅=${METRICS_ROW_TOTAL}）`);
    if (r.code !== 0 || nFail !== 0 || nPass !== METRICS_ROW_TOTAL) {
      note('✗ 基线不绿 —— 先修基线再谈判别力（本脚本不背这个锅）');
      // ★ 光说「不绿」没用，把红的行打出来（否则读者不知道红在哪一条）
      for (const l of rows0.filter((x) => x.startsWith('| ❌ |'))) note('  ' + l);
      failed++;
    }
    // label 契约：应有的 label 一条都不能少（防「守门静默消失」）
    for (const label of METRICS_LABELS) {
      const seen = rows0.filter((l) => l.includes(`| ${label} |`)).length;
      if (seen === 0) { note(`✗ 基线里找不到 label「${label}」⇒ 该守门已静默消失`); failed++; }
    }
    for (const row of parseRows(r.out)) {
      if (!baseClaimed.has(row.label)) baseClaimed.set(row.label, new Set());
      baseClaimed.get(row.label).add(row.claimed);
    }
    note();
  }
  if (ONLY !== 'metrics') {
    const r = runIn('tools/gates/check.mjs');
    note('=== 基线 B：gates/check.mjs ===');
    note(`EXIT=${r.code}（期望 0）`);
    note(r.out.trim().split('\n').slice(-1)[0] || '(无输出)');
    if (r.code !== 0) failed++;
    note();
  }

  // ── metrics 逐条改坏 ──
  if (ONLY !== 'gates') {
    note('=== metrics --check：逐条改坏取证 ===');
    note('| 改坏对象 | EXIT | 目标那行 ❌ | 判定 |');
    note('|---|---|---|---|');
    for (const c of METRICS_CASES) {
      restore([c.file]);
      const before = fs.readFileSync(path.join(WORK, c.file), 'utf8');
      let after;
      try {
        after = c.mutate(before);
      } catch (e) {
        note(`| ${c.name} | — | — | ⚠️ **改坏失败**：${e.message} |`);
        failed++;
        restore([c.file]);
        continue;
      }
      if (after === before) {
        note(`| ${c.name} | — | — | ⚠️ **改坏没生效**（模式未匹配，守门可能已改名） |`);
        failed++;
        restore([c.file]);
        continue;
      }
      fs.writeFileSync(path.join(WORK, c.file), after);
      const r = runIn('tools/metrics.mjs', ['--check']);
      const hit = rowCount(r.out, '❌', c.label);
      // ★★ 「文件变了」≠「守门读的那段变了」：断言该 label 的 claimed 相对基线真的变了
      // ★ 注意：有些 label（如「首屏 未识别项」）在**基线里本来就不存在** —— 它是
      //   「解析不了才出现」的兜底分支。基线无记录时，只要该 label 现在**出现了**即算「已落到」。
      const targetRows = parseRows(r.out).filter((x) => x.label === c.label);
      const base = baseClaimed.get(c.label);
      const reached = base ? targetRows.some((x) => !base.has(x.claimed)) : targetRows.length > 0;
      if (!reached) {
        note(`| ${c.name} | ${r.code} | ${hit} | ⚠️ **改坏没落到守门读的那段文本上**（claimed 未变，结论无效） |`);
        failed++;
      } else {
        const ok = r.code === 1 && hit >= 1;
        if (!ok) failed++;
        note(`| ${c.name} | ${r.code} | ${hit} | ${ok ? '✅ 有判别力' : '❌ **无判别力**'} |`);
        rows.push({ ok, name: c.name });
      }
      restore([c.file]);
    }
    note();
  }

  // ── gates 逐条改坏 ──
  if (ONLY !== 'metrics') {
    note('=== gates/check.mjs：逐条改坏取证 ===');
    note('| 改坏对象 | EXIT | 命中关键字 | 判定 |');
    note('|---|---|---|---|');
    for (const c of GATES_CASES) {
      restore(c.probe ? [c.probe] : [c.append.file]);
      if (c.probe) {
        fs.mkdirSync(path.dirname(path.join(WORK, c.probe)), { recursive: true });
        fs.writeFileSync(path.join(WORK, c.probe), c.content());
      } else {
        fs.appendFileSync(path.join(WORK, c.append.file), c.append.text);
      }
      const r = runIn('tools/gates/check.mjs');
      const hit = r.out.includes(c.expect);
      const ok = r.code !== 0 && hit;
      if (!ok) failed++;
      note(`| ${c.name} | ${r.code} | ${hit ? '✓' : '✗'} | ${ok ? '✅ 有判别力' : '❌ **无判别力**'} |`);
      rows.push({ ok, name: c.name });
      restore(c.probe ? [c.probe] : [c.append.file]);
    }
    note();
  }

  // ── 收尾：干净态必须复绿 ──
  note('=== 收尾：副本恢复干净后复绿 ===');
  if (ONLY !== 'gates') {
    const r = runIn('tools/metrics.mjs', ['--check']);
    const nFail = metricsRows(r.out).filter((l) => l.startsWith('| ❌ |')).length;
    note(`metrics --check  EXIT=${r.code}  ❌=${nFail}（期望 0 / 0）`);
    if (r.code !== 0 || nFail !== 0) failed++;
  }
  if (ONLY !== 'metrics') {
    const r = runIn('tools/gates/check.mjs');
    note(`gates/check.mjs  EXIT=${r.code}（期望 0）`);
    if (r.code !== 0) failed++;
  }
  note();

  // ── 自证：全程没碰工作树 ──
  const statusAfter = gitStatus();
  const untouched = statusBefore === statusAfter;
  note(`工作树未被碰过（审计前后 git status 一致）：${untouched ? '✅' : '❌'}`);
  if (!untouched) {
    note('--- 之前 ---\n' + statusBefore);
    note('--- 之后 ---\n' + statusAfter);
    failed++;
  }

  const bad = rows.filter((x) => !x.ok);
  note();
  note(`共 ${rows.length} 个改坏场景；无判别力的 ${bad.length} 个。`);
  if (bad.length) for (const b of bad) note(`  ✗ ${b.name}`);
  note(failed === 0 ? '✓ 全部守门都有判别力' : `✗ 有 ${failed} 项问题`);
} finally {
  if (WORK) rmIf(WORK);
  if (TEMPLATE) { if (KEEP) console.log(`(--keep：保留副本 ${TEMPLATE})`); else rmIf(TEMPLATE); }
}
process.exitCode = failed === 0 ? 0 : 1;
