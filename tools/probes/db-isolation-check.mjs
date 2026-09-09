/**
 * tools/probes/db-isolation-check.mjs —— 真库快照只读探针（「测试不写真实数据目录」的凭证）
 *
 * 用途：test-plan §7 那条铁律「禁止测试写真实数据目录」此前只是约定，没有证据。
 * 用法：跑全量测试**前**一次、**后**一次，比对两次输出逐字段一致 ⇒ 隔离有效。
 *   $env:Path = "C:\nodejs22\node-v22.23.2-win-x64;" + $env:Path   # 必须与装依赖的 Node 一致（ABI 127）
 *   node tools/probes/db-isolation-check.mjs
 * 只读声明：以 { readonly: true } 打开，全程无写操作；库路径与 storage/db.ts 同口径
 *   （SB_DATA_DIR → APPDATA → homedir）。
 * 天然浮动项：size（WAL checkpoint 会变）不算结论；可复现的是各表行数与 daily_activity 内容。
 * 首次量测结论（2026-09-06 23:4x）：见 docs/dev/test-plan.md §7 该条与 §8 v0.2.7 行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir = process.env.SB_DATA_DIR ?? path.join(process.env.APPDATA ?? os.homedir(), 'studentbuddy-v2');
const file = path.join(dir, 'studentbuddy.db');
console.log('DB:', file, 'exists:', fs.existsSync(file));
if (!fs.existsSync(file)) process.exit(0);
const st = fs.statSync(file);
console.log('mtime:', st.mtime.toISOString(), 'size:', st.size);

const db = new Database(file, { readonly: true });
const q = (label, sql) => {
  try {
    console.log(label + ':', JSON.stringify(db.prepare(sql).all()));
  } catch (e) {
    console.log(label + ': ERR ' + e.message);
  }
};

q('schema_versions', 'SELECT version FROM schema_version ORDER BY version');
q('tables', "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
q(
  'counts',
  `SELECT (SELECT COUNT(*) FROM sessions) sessions, (SELECT COUNT(*) FROM messages) messages,
          (SELECT COUNT(*) FROM term_library) terms, (SELECT COUNT(*) FROM quiz_bank) quiz_bank,
          (SELECT COUNT(*) FROM quiz_stats) quiz_stats, (SELECT COUNT(*) FROM token_usage) token_usage,
          (SELECT COUNT(*) FROM event_log) event_log,
          (SELECT COUNT(*) FROM evolution_session) evo_session,
          (SELECT COUNT(*) FROM evolution_event) evo_event`,
);
q('daily_activity', 'SELECT day, type, count FROM daily_activity ORDER BY day, type');
q('app_settings_keys', 'SELECT key FROM app_settings ORDER BY key');
db.close();
