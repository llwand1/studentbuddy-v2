/**
 * 认领孤儿行（契约 docs/TENANCY-SPEC.md §3 / §8.2）。
 *
 * 迁移给各表加归属列时，老库的行**无从知道属于谁**（迁移那一刻没人可问），故留成「无主行」：
 * 登录用户的查询都带 `owner_id = ?`，无主值天然不匹配 ⇒ 它们**不会泄露给别人**，
 * 代价是真正的主人自己也看不见了。本脚本就是那条认领路径。
 *
 * ★ 为什么不做「首个注册者自动认领」：并发注册时归属不确定，且无法撤销（SPEC §3）。
 *   认领是**显式动作**，跑之前先给你看清楚要认领多少条。
 *
 * ★★ 两套「无主」写法**并存且都对**，别统一（这是本脚本最容易改错的地方）：
 *   · `sessions.user_id`（v22）与 `term_mention_log.owner_id`（v26）：无主 = **NULL**
 *     （这两张表先落，当时的口径就是可空）；
 *   · `user_memory.user_id`（v24）与 M2d 的 `app_settings` / `daily_*` / `user_stats`
 *     （v30）：无主 = **空串 `''`**（v24 起改用「列值」而不是 `COALESCE` 表达式，
 *     因为 `ON CONFLICT` 的冲突目标必须匹配唯一索引的**列**）。
 *   ⇒ 每张表**声明自己的无主形态**，脚本不做猜测。★ 若某张表在「另一种形态」下也有行，
 *     脚本会打 `WARN`（否则一个写错形态的声明会变成**静默的 0 条认领**，最难查）。
 *
 * ★ 未来表（M2d-2 的 `term_*`、M2d-3 的 `quiz_*` / `flow_*`）已预先列入：**表或列不存在就跳过**，
 *   故本脚本现在可跑、迁移落地后无需改动即自动生效。
 *
 * 用法（**必须显式给 SB_DATA_DIR**，防止手滑认领到生产库）：
 *   SB_DATA_DIR=/tmp/sbauth node _probe/claim-legacy.mjs alice@example.com          # 只预览
 *   SB_DATA_DIR=/tmp/sbauth node _probe/claim-legacy.mjs alice@example.com --yes     # 执行
 *
 * ⚠️ 认领**不可撤销**：一旦把孤儿行判给某个账号，就再也分不清它们原本属于谁。
 *   若库里可能存在多个人的老数据，先备份再跑（复制 .db 文件即可）。
 *
 * 输出全 ASCII（同 `_probe/auth-smoke.mjs`，避免 Git Bash 下中文乱码）。
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const email = process.argv[2];
const apply = process.argv.includes('--yes');
const dataDir = process.env.SB_DATA_DIR;

if (!email || !dataDir) {
  console.log('USAGE: SB_DATA_DIR=<dir> node _probe/claim-legacy.mjs <email> [--yes]');
  console.log('  --yes   actually write (without it this is a dry run)');
  console.log('  SB_DATA_DIR is REQUIRED: refusing to guess which database you mean.');
  process.exit(1);
}

/**
 * 每张待认领的表：`{ table, column, orphan }`。
 * `orphan` 是**无主行的判据**，逐表声明（见文件头注：两套写法并存）。
 */
const TARGETS = [
  // ── v22 / v24 / v26：M2a~M2b 已落地的 ──
  { table: 'sessions', column: 'user_id', orphan: 'NULL' },
  { table: 'user_memory', column: 'user_id', orphan: "''" },
  { table: 'term_mention_log', column: 'owner_id', orphan: 'NULL' },
  // ── v30：M2d-1（设置与反馈环归主）──
  { table: 'app_settings', column: 'owner_id', orphan: "''" },
  { table: 'daily_activity', column: 'owner_id', orphan: "''" },
  { table: 'daily_summaries', column: 'owner_id', orphan: "''" },
  { table: 'user_stats', column: 'owner_id', orphan: "''" },
  // ── M2d-2 / M2d-3 落地后自动生效（表或列不存在即跳过）──
  // ★ 这两批的迁移还没写，故 `orphan` 是**按 v24/v30 的既定口径预留的**；
  //   落地后请回来看一眼实际建表语句，若某张表选了 NULL 就改这里（脚本会 WARN 提醒）。
  { table: 'term_library', column: 'owner_id', orphan: "''" },
  { table: 'term_domain', column: 'owner_id', orphan: "''" },
  { table: 'quiz_bank', column: 'owner_id', orphan: "''" },
  { table: 'quiz_stats', column: 'owner_id', orphan: "''" },
  { table: 'quiz_notes', column: 'owner_id', orphan: "''" },
  { table: 'flow_def', column: 'owner_id', orphan: "''" },
  { table: 'flow_run', column: 'owner_id', orphan: "''" },
  { table: 'knowledge_node', column: 'owner_id', orphan: "''" },
];

const db = new Database(path.join(dataDir, 'studentbuddy.db'));

// 与服务端同一口径：注册时邮箱经 normalizeEmail 转小写 + trim，故这里照做才能命中
const user = db.prepare(`SELECT id, nickname FROM users WHERE email = ?`).get(email.trim().toLowerCase());
if (!user) {
  console.log(`NO_SUCH_USER: ${email.trim().toLowerCase()}`);
  console.log('HINT: register the account first (POST /api/auth/register), then claim.');
  process.exit(1);
}

/** 表是否存在、列是否存在（不存在的直接跳过 ⇒ 未来表落地前后都能跑） */
const hasColumn = (table, column) => {
  const t = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  if (!t) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
};

const count = (sql, ...args) => db.prepare(sql).get(...args).n;

/** 该表在两种无主形态下各有几行（用来抓"声明形态写错 ⇒ 静默 0 条"） */
const survey = (table, column) => ({
  nulls: count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IS NULL`),
  empties: count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ''`),
  total: count(`SELECT COUNT(*) AS n FROM ${table}`),
});

console.log(`db=${dataDir}`);
console.log(`user=${user.id} (${user.nickname || email})`);
console.log('');

const plan = [];
let warned = 0;
for (const t of TARGETS) {
  if (!hasColumn(t.table, t.column)) continue; // 未来表还没迁移到 ⇒ 静默跳过是**正确**的
  const s = survey(t.table, t.column);
  const n = t.orphan === 'NULL' ? s.nulls : s.empties;
  const other = t.orphan === 'NULL' ? s.empties : s.nulls;
  const flag = other > 0 ? ` WARN other-form(${t.orphan === 'NULL' ? "''" : 'NULL'})=${other}` : '';
  if (other > 0) warned += 1;
  console.log(
    `  ${t.table.padEnd(20)} total=${String(s.total).padStart(5)} orphan(${t.orphan})=${String(n).padStart(5)}${flag}`,
  );
  if (n > 0) plan.push({ ...t, n });
}

const total = plan.reduce((a, p) => a + p.n, 0);
console.log('');
if (warned > 0) {
  console.log(
    `WARN: ${warned} table(s) also have rows under the OTHER orphan form. Those will NOT be claimed.`,
  );
  console.log('      Either the declared form is wrong for that table, or it really has both.');
  console.log('      Check the table migration header before trusting a 0-claim result.');
}

if (total === 0) {
  console.log('NOTHING_TO_CLAIM');
  process.exit(0);
}

if (!apply) {
  console.log(`DRY_RUN: would claim ${total} row(s) across ${plan.length} table(s) to ${user.id}.`);
  console.log('        Re-run with --yes to apply.');
  process.exit(0);
}

// ★ 只认领无主行：已经归属别人的行**绝不改**（那才是数据泄露）。
//   逐表单独 UPDATE（不是一个大事务）——某张表失败时前面的成果仍可见，便于按表排查。
console.log('');
let claimed = 0;
for (const p of plan) {
  const where = p.orphan === 'NULL' ? `${p.column} IS NULL` : `${p.column} = ''`;
  const res = db.prepare(`UPDATE ${p.table} SET ${p.column} = ? WHERE ${where}`).run(user.id);
  const left = count(
    `SELECT COUNT(*) AS n FROM ${p.table} WHERE ${p.orphan === 'NULL' ? `${p.column} IS NULL` : `${p.column} = ''`}`,
  );
  claimed += res.changes;
  console.log(`  CLAIMED ${p.table.padEnd(20)} ${String(res.changes).padStart(5)}  orphan_left=${left}`);
}
console.log('');
console.log(`TOTAL_CLAIMED=${claimed} -> ${user.id}`);
