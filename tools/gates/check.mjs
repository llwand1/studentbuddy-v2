/**
 * 工程红线门禁：行数 / 内联样式 / any / 测试登记 —— eslint 与 tsc 之外的机器检查。
 * 规则：server 单文件 ≤400 行；web 组件(.tsx) ≤300 行；web 源码禁 style={{；
 *       全部源码禁 `: any` / `as any`（ts 层面 tsc+eslint 已拦，此处兜底扫描）；
 *       每个 *.test.ts(x) 都必须在 docs/TEST-PLAN.md §3 用例清单中成行。
 * 退出码非 0 = 门禁红（CI 拒绝合并）。
 *
 * 第 4 条为什么要机器拦：
 *   只写「改完代码要更新测试清单」这样的动作、不设校验点的话，
 *   清单的基线数会静默落后于实际，落后几批都没人发现。
 *   这条把「登记」变成拦得住的机器检查：新增测试文件未在清单成行 → 门禁直接红。
 *   例外处理：确属不该登记的临时件，在清单 §3 顶注点名隔离，不要删门禁。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const violations = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'dist' || name === 'node_modules' || name.endsWith('.test.ts')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function win(p) {
  return p.replace(/\//g, '\\');
}

// 1) 行数红线
for (const pkg of ['packages/server/src', 'packages/web/src']) {
  const limit = pkg.includes('web') ? null : 400;
  for (const file of walk(join(ROOT, pkg))) {
    const ext = extname(file);
    if (!['.ts', '.tsx'].includes(ext)) continue;
    const lines = readFileSync(file, 'utf8').split('\n').length;
    const max = ext === '.tsx' ? 300 : (limit ?? 400);
    if (lines > max) violations.push(`[行数] ${win(file)} ${lines} 行 > ${max}`);
  }
}

// 2) 内联样式红线（web）；「gates:style-ok」行注释 = 数据驱动样式的显式豁免
for (const file of walk(join(ROOT, 'packages/web/src'))) {
  if (extname(file) !== '.tsx') continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('style={{') && !lines[i - 1]?.includes('gates:style-ok') && !line.includes('gates:style-ok')) {
      violations.push(`[内联样式] ${win(file)}:${i + 1} 含 style={{，请用 tokens.css/class（数据驱动可加 gates:style-ok 豁免注释）`);
    }
  });
}

// 3) any 红线（兜底）
for (const pkg of ['packages/shared/src', 'packages/server/src', 'packages/web/src']) {
  for (const file of walk(join(ROOT, pkg))) {
    if (!['.ts', '.tsx'].includes(extname(file))) continue;
    const src = readFileSync(file, 'utf8');
    if (/:\s*any\b|as any\b/.test(src)) violations.push(`[any] ${win(file)} 含 any`);
  }
}

// 4) 测试登记红线：每个测试文件都必须在 docs/TEST-PLAN.md 里成行
{
  const TEST_PLAN = join(ROOT, 'docs/TEST-PLAN.md');
  if (!existsSync(TEST_PLAN)) {
    violations.push(`[测试登记] docs/TEST-PLAN.md 不存在，测试清单载体缺失`);
  } else {
    // 统一成「src/…」开头的相对路径，忽略 packages/<pkg>/ 前缀差异
    const norm = (p) => {
      const s = p.replace(/\\/g, '/');
      const i = s.indexOf('/src/');
      return i >= 0 ? s.slice(i + 1) : s;
    };
    const planText = readFileSync(TEST_PLAN, 'utf8');
    const registered = new Set(
      [...planText.matchAll(/`([^`\s]*\.test\.tsx?)`/g)].map((m) => norm(m[1])),
    );

    // 收集真实存在的测试文件（与 vitest include 口径一致：packages/*/src/**）
    const actual = [];
    for (const pkg of ['packages/shared/src', 'packages/server/src', 'packages/web/src']) {
      const dir = join(ROOT, pkg);
      if (!existsSync(dir)) continue;
      const stack = [dir];
      while (stack.length) {
        const cur = stack.pop();
        for (const name of readdirSync(cur)) {
          const p = join(cur, name);
          if (statSync(p).isDirectory()) stack.push(p);
          else if (/\.test\.tsx?$/.test(name)) actual.push(p);
        }
      }
    }

    const missing = actual.filter((f) => !registered.has(norm(f))); // 有测试没登记
    const ghosts = [...registered].filter(
      (r) => r.startsWith('src/') && !actual.some((f) => norm(f) === r),
    ); // 登记了但文件不在（幽灵行）

    for (const f of missing) {
      violations.push(
        `[测试登记] ${win(f)} 未在 docs/TEST-PLAN.md §3 成行（新增测试须同步登记）`,
      );
    }
    for (const g of ghosts) {
      violations.push(`[测试登记] docs/TEST-PLAN.md 里的 \`${g}\` 已无对应文件（幽灵行，请删行或补文件）`);
    }
    if (!missing.length && !ghosts.length) {
      console.log(`✓ 测试登记：${actual.length} 个测试文件全部在 docs/TEST-PLAN.md 成行`);
    }
  }
}

if (violations.length) {
  console.error(`✗ gates 红线 ${violations.length} 处：`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('✓ gates 全绿（行数/内联样式/any）');
