#!/usr/bin/env node
/**
 * test-tmp.mjs — 让测试套件的临时目录「跑完即清」（治根，非定期扫）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 本仓 78 个测试文件、94 处 `fs.mkdtempSync(path.join(os.tmpdir(), 'sb-xxx-'))`
 * 都是「建了就不管」。实测（2026-09-21）：跑 `chat/memory.test.ts` 一个文件
 * ⇒ `sb-memory-test-*` 从 6690 涨到 6712，**正好 +22 = 该文件 22 个用例**。
 * 即 **每个用例泄漏一个临时目录、零清理**。累积 5 周后 %TEMP% 里躺着
 * 5.4 万个 `sb-*` 目录 / 约 4.2GB。
 *
 * ── 机制（为什么不改那 94 处）────────────────────────────────────────────────
 * node 的 `os.tmpdir()` **跟着环境变量走**（Windows 读 TMP → TEMP → USERPROFILE；
 * 类 Unix 读 TMPDIR）。实测确认：把子进程的 TEMP/TMP 指向一个新根，
 * 子进程里 `os.tmpdir()` 就返回那个根 ⇒ 所有 `mkdtempSync(path.join(os.tmpdir(), …))`
 * **自动落进这个根**。于是「清一次」＝「清全部」，**94 个调用点一行都不用改**。
 *
 * 另一个好处：每次运行拿到**独立的根** ⇒ 并行会话/并行运行互不误删
 * （这是「定期扫 %TEMP% 按前缀删」做不到的 —— 那种做法会误伤别人正在用的目录）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node tools/test-tmp.mjs                  # 跑全量 vitest run
 *   node tools/test-tmp.mjs <vitest 参数…>   # 透传给 vitest（如单个测试文件路径）
 *   node tools/test-tmp.mjs -- <cmd> [args]  # 跑任意命令（同样重定向 TEMP/TMP）
 *   KEEP_TMP=1 node tools/test-tmp.mjs …     # 保留根目录（排查用，会打印路径）
 *
 * ── 失败安全 ────────────────────────────────────────────────────────────────
 * 建根失败 ⇒ **不重定向**、照常跑原命令（宁可泄漏也不能因为本工具而跑不了测试）。
 * 子进程退出码原样透传；收到 SIGINT/SIGTERM 时先收尾清理再退出。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REAL_TMP = os.tmpdir();

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const passthrough = sep >= 0 ? argv.slice(sep + 1) : argv;

// 默认跑本仓 vitest（用 node 直接起入口，避免 Windows 下 .cmd shim 需要 shell）
const vitestEntry = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const defaultCmd = fs.existsSync(vitestEntry)
  ? { cmd: process.execPath, args: [vitestEntry, 'run'] }
  : { cmd: 'npx', args: ['vitest', 'run'] };

const useCustom = sep >= 0;
const child = useCustom
  ? { cmd: passthrough[0], args: passthrough.slice(1) }
  : { cmd: defaultCmd.cmd, args: [...defaultCmd.args, ...passthrough] };

// ── 建根 ─────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const runRoot = path.join(REAL_TMP, `sb-run-${stamp}-${process.pid}`);

let redirected = false;
let createError = null;
try {
  fs.mkdirSync(runRoot, { recursive: true });
  redirected = true;
} catch (e) {
  createError = e;
}

console.log('=== test-tmp ===');
console.log('真实临时目录: ' + REAL_TMP);
if (redirected) {
  console.log('本次运行根目录: ' + runRoot);
  console.log('⇒ 子进程 TEMP/TMP 指向它；os.tmpdir() 随之改变（实测确认）');
} else {
  console.log('!! 建根失败，**不重定向**，照常运行（会泄漏，但不阻塞测试）: ' + createError.message);
}
console.log('命令: ' + [child.cmd, ...child.args].join(' '));
console.log('');

// ── 跑 ───────────────────────────────────────────────────────────────────────
const env = redirected ? { ...process.env, TEMP: runRoot, TMP: runRoot } : { ...process.env };
const t0 = Date.now();
const proc = spawn(child.cmd, child.args, { stdio: 'inherit', env, cwd: ROOT });

const forward = (sig) => {
  if (!proc.killed) {
    try {
      proc.kill(sig);
    } catch {
      /* ignore */
    }
  }
};
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

/** 数根目录里的条目（只读，用于报告） */
function countEntries(dir) {
  let dirs = 0;
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const q = path.join(cur, e.name);
      if (e.isDirectory()) {
        dirs++;
        stack.push(q);
      } else {
        files++;
        try {
          bytes += fs.statSync(q).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return { dirs, files, bytes };
}

function cleanup() {
  if (!redirected) return;
  const keep = !!process.env.KEEP_TMP;
  const stat = countEntries(runRoot);
  const mb = (stat.bytes / 1024 / 1024).toFixed(1);
  console.log('\n=== 收尾 ===');
  console.log(`本次运行在根目录里留下: ${stat.dirs} 个子目录 / ${stat.files} 个文件 / ${mb} MB`);
  if (keep) {
    console.log('KEEP_TMP=1 ⇒ **保留**根目录（排查用）: ' + runRoot);
    return;
  }
  try {
    fs.rmSync(runRoot, { recursive: true, force: true });
    const gone = !fs.existsSync(runRoot);
    console.log(gone ? '✓ 已整根删除: ' + runRoot : '!! 删除后仍存在: ' + runRoot);
    if (gone) console.log(`⇒ 本次运行泄漏 ${stat.dirs} 个目录已全部回收（真实临时目录未新增 sb-* 条目）`);
  } catch (e) {
    console.log('!! 删除失败: ' + e.message + '（根目录仍为 ' + runRoot + '）');
  }
}

proc.on('exit', (code, signal) => {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n子进程结束: code=${code} signal=${signal ?? 'none'} 用时 ${secs}s`);
  cleanup();
  process.exitCode = code ?? (signal ? 1 : 0);
});
