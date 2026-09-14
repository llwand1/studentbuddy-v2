/**
 * storage/db — SQLite 单文件（WAL + 外键）连接与生命周期管理。
 *
 * 迁移定义（v1~v14 建表/加列语句）已按职责拆到 ./migrations.ts（2026-09-14）：
 * 迁移清单只会单向增长，与「解析数据目录 / 开关连接」不是同一种生命周期，
 * 混在一个文件里会让本文件必然撞上 AGENTS.md 的「.ts ≤400 行」红线。
 *
 * v2 铁律（ADR-6）：不用大模板字符串批量 exec（v1 TS1434 坑根除）；每版迁移一个数组；
 * 索引与建表同批；messages(session_id, ts) 索引第一天就有（v1 欠账）。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from './migrations.js';

/**
 * 数据目录解析（ADR-6：不碰用户数据，且**不能静默落到错误位置**）。
 *
 * 优先级：
 *   1. `SB_DATA_DIR` 显式覆盖（测试 / 多实例场景，最高优先级，原样保留）。
 *   2. `APPDATA` / `LOCALAPPDATA`（正常 Windows 终端一定存在）→ 各自下的 `studentbuddy-v2`。
 *   3. **即便上述环境变量缺失**，Windows 上真实数据几乎总在用户目录下的
 *      `AppData/Roaming/studentbuddy-v2`；末位再保留 `os.homedir()/studentbuddy-v2`
 *      这一历史兜底（2026-09-05 引入，防库写进源码树）。
 *
 * ★ 关键修正（根治「反复启动后没数据」）：不再直接拿首个候选去**新建**空库，
 * 而是先扫描候选列表、优先挑**已经存在 `studentbuddy.db` 的那个**真实库。
 * 这样即使启动环境没有 `APPDATA`（CI / 精简 shell / 部分沙箱 Bash，已反复踩到），
 * 也能自动找回真实库，而不是在 homedir 下新建一个空壳库把用户数据「藏起来」。
 * 只有当所有候选都不存在库文件时，才在首个候选处新建。
 */
export function resolveDataDir(): string {
  if (process.env.SB_DATA_DIR) return process.env.SB_DATA_DIR;
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'studentbuddy-v2'));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'studentbuddy-v2'));
  candidates.push(path.join(home, 'AppData', 'Roaming', 'studentbuddy-v2'));
  candidates.push(path.join(home, 'studentbuddy-v2')); // 历史兜底（09-05 引入）
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'studentbuddy.db'))) return dir;
  }
  return candidates[0] ?? path.join(home, 'studentbuddy-v2');
}

export const DATA_DIR = resolveDataDir();

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, 'studentbuddy.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** 测试辅助：用临时目录开独立实例（不污染真实库）；同时让 getDb() 指向它。 */
export function openIsolated(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const d = new Database(path.join(dataDir, 'studentbuddy.db'));
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  migrate(d);
  db = d;
  return d;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
