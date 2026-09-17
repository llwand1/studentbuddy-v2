/**
 * storage/migrations — 迁移执行器（应用 `MIGRATIONS` 的那一段逻辑）。
 *
 * 2026-09-16 二次拆分：清单搬到 `storage/migrations-list.ts`。理由与 2026-09-14 从 `db.ts`
 * 搬出时**完全一致**——迁移清单是**只会单向增长**的数据（v17 看图加列后本文件到 404 行，
 * 再次触 AGENTS.md「.ts ≤400 行」红线），而执行器逻辑自那次拆分后一行未改。
 * 两者生命周期不同：清单每加一个版本就变，执行器几年不动一次。
 *
 * v2 铁律（ADR-6）：不用大模板字符串批量 exec（v1 TS1434 坑根除）；每版迁移一个数组。
 * ⚠️ 若 `migrations-list.ts` 再涨到 400 行：按版本区间再切（如 `-list-v1-10` / `-list-v11+`），
 * 不要用「压注释」换行数——这些注释记录的是每张表为什么这么建，价值远高于行数。
 */
import type Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations-list.js';

/** 逐版本幂等应用：已应用过的（≤ current）跳过；每版一个事务，失败即整体回滚。 */
export function migrate(d: Database.Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = d.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number | null };
  const current = row.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const apply = d.transaction(() => {
      for (const stmt of m.statements) d.exec(stmt);
      d.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(m.version);
    });
    apply();
  }
}
