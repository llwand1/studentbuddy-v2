// 实测：SQLite 下 PRIMARY KEY / UNIQUE 是否对 NULL 去重（决定 role_bindings 复合主键能不能靠 PK 兜底）
// 结论用于 docs/TENANCY-SPEC.md §8.1.2
import Database from 'better-sqlite3';
const db = new Database(':memory:');
console.log('sqlite 版本：', db.prepare('SELECT sqlite_version() v').get().v);
db.exec(`CREATE TABLE rb (
  owner_id TEXT,
  role TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (owner_id, role)
)`);
const ins = db.prepare(`INSERT INTO rb (owner_id, role, provider_id, model) VALUES (?, ?, ?, ?)`);
const tryIns = (label, ...args) => {
  try { ins.run(...args); console.log(`${label}：**插入成功**`); }
  catch (e) { console.log(`${label}：被拦 (${e.code})`); }
};
console.log('\n--- ① 平台行（owner_id = NULL）插两次 ---');
tryIns('第 1 次', null, 'explain', 'p1', '');
tryIns('第 2 次', null, 'explain', 'p2', '');
console.log('  当前平台行数 =', db.prepare(`SELECT COUNT(*) c FROM rb WHERE owner_id IS NULL AND role='explain'`).get().c);
console.log('\n--- ② 用户行（owner_id = u1）插两次 ---');
tryIns('第 1 次', 'u1', 'explain', 'p3', '');
tryIns('第 2 次', 'u1', 'explain', 'p4', '');
console.log('\n--- ③ 现在尝试建「部分唯一索引」兜住平台行 ---');
try { db.exec(`CREATE UNIQUE INDEX idx_rb_platform ON rb(role) WHERE owner_id IS NULL`); console.log('索引建立成功（说明没有重复行可拦）'); }
catch (e) { console.log(`索引建立失败 (${e.code})：${e.message} ← 正因为表里已有 2 条 (NULL, explain)`); }
console.log('\n--- ④ 清掉重复平台行后重建索引，再验证它真能拦 ---');
db.exec(`DELETE FROM rb WHERE owner_id IS NULL`);
db.exec(`CREATE UNIQUE INDEX idx_rb_platform ON rb(role) WHERE owner_id IS NULL`);
tryIns('平台行第 1 次', null, 'explain', 'p5', '');
tryIns('平台行第 2 次', null, 'explain', 'p6', '');
tryIns('用户行第 3 次(u1/explain 已存在)', 'u1', 'explain', 'p7', '');
console.log('\n--- ⑤ 索引对「用户行」的影响：u2 能否正常插？ ---');
tryIns('u2/explain', 'u2', 'explain', 'p8', '');
console.log('\n--- 最终表内容 ---');
console.log(JSON.stringify(db.prepare('SELECT owner_id, role, provider_id FROM rb ORDER BY owner_id, role').all(), null, 0));
db.close();
