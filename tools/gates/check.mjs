/**
 * v2 工程红线门禁（G2）：行数 / 内联样式 / any —— eslint/tsc 之外的机器检查。
 * 规则：server 单文件 ≤400 行；web 组件(.tsx) ≤300 行；web 源码禁 style={{；
 *       全部源码禁 `: any` / `as any`（ts 层面 tsc+eslint 已拦，此处兜底扫描）。
 * 退出码非 0 = 门禁红（CI 拒绝合并）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

if (violations.length) {
  console.error(`✗ gates 红线 ${violations.length} 处：`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('✓ gates 全绿（行数/内联样式/any）');
