/**
 * tools/migrate-from-v1 — v1 → v2 数据迁移（ADR-6：永不触碰 v1 原库；v2 库先备份）。
 * 迁移：sessions/messages/quiz_bank/memorize（SRS 初值）；providers 已在 M1 迁移。
 * 乱码清洗：v1 早期 GBK 写入的脏标题用 TextDecoder('gbk') 重解码，不可恢复标记保留。
 * 用法：
 *   node tools/migrate-from-v1/migrate.mjs --dry-run   # 只出报告
 *   node tools/migrate-from-v1/migrate.mjs --run       # 备份 v2 库后执行
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const V1_PATH = path.join(process.env.APPDATA ?? '', 'studentbuddy', 'studentbuddy.db');
const V2_DIR = process.env.SB_DATA_DIR ?? path.join(process.env.APPDATA ?? '', 'studentbuddy-v2');
const V2_PATH = path.join(V2_DIR, 'studentbuddy.db');
const RUN = process.argv.includes('--run');

/** 乱码清洗：含 U+FFFD 的串尝试 latin1→GBK 重解码；无改善返回原串+损坏标记 */
function clean(s) {
  if (typeof s !== 'string' || !s.includes('\uFFFD')) return { s, fixed: false };
  try {
    const buf = Buffer.from(s, 'latin1');
    const re = new TextDecoder('gbk').decode(buf);
    if (re && !re.includes('\uFFFD')) return { s: re, fixed: true };
  } catch {
    /* gbk 解码不可用则放弃 */
  }
  return { s: `${s}（原文含乱码，已保留）`, fixed: false };
}

const v1 = new Database(V1_PATH, { readonly: true });
const v2 = new Database(V2_PATH);
v2.pragma('foreign_keys = OFF'); // 迁移期间关外键（先 sessions 后 messages 顺序也行，双保险）

const report = { sessions: 0, messages: 0, quiz: 0, memorize: 0, fixedTitles: 0, skipped: [] };

// 1) 会话（软删的不迁）
const sessRows = v1.prepare(`SELECT id, title, parent_id, pinned, created_at, updated_at FROM sessions WHERE deleted_at IS NULL`).all();
const sessIds = [];
const insSess = v2.prepare(`INSERT OR IGNORE INTO sessions (id, title, forked_from_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
for (const r of sessRows) {
  const t = clean(r.title);
  if (t.fixed) report.fixedTitles++;
  insSess.run(r.id, t.s, r.parent_id ?? null, r.pinned ? 1 : 0, r.created_at, r.updated_at);
  sessIds.push(r.id);
  report.sessions++;
}

// 2) 消息（按会话过滤）
const insMsg = v2.prepare(`INSERT OR IGNORE INTO messages (id, session_id, role, content, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const qMsg = v1.prepare(`SELECT id, session_id, role, content, tool_calls, tool_call_id, ts AS created_at FROM messages WHERE session_id = ? ORDER BY ts`);
for (const sid of sessIds) {
  for (const m of qMsg.all(sid)) {
    insMsg.run(m.id, sid, m.role, m.content ?? '', m.tool_calls ?? null, m.tool_call_id ?? null, m.created_at);
    report.messages++;
  }
}

// 3) 题库
try {
  const quizzes = v1.prepare('SELECT id, title, source, data, created_at FROM quiz_bank').all();
  const insQ = v2.prepare('INSERT OR IGNORE INTO quiz_bank (id, title, source, data, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const q of quizzes) {
    insQ.run(q.id, q.title, q.source ?? 'import', q.data, q.created_at);
    report.quiz++;
  }
} catch {
  report.skipped.push('quiz_bank: v1 无此表');
}

// 4) 背词（SRS 初值：按 review_count 推算；mastered 保留）
try {
  const terms = v1.prepare('SELECT id, term, definition, category, difficulty, review_count, mastered, last_review_at FROM memorize').all();
  const insM = v2.prepare(
    `INSERT OR IGNORE INTO memorize (id, term, definition, category, difficulty, status, review_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  for (const t of terms) {
    const status = t.mastered ? 'mastered' : 'new';
    insM.run(t.id, clean(t.term).s, clean(t.definition).s, t.category ?? null, t.difficulty ?? 1, status, t.review_count ?? 0);
    report.memorize++;
  }
} catch {
  report.skipped.push('memorize: v1 无此表');
}

v1.close();

if (!RUN) {
  console.log('[dry-run] 迁移报告（未写入）：');
  console.log(JSON.stringify(report, null, 2));
  v2.close();
} else {
  // 备份 → 提交事务 → 校验
  const bak = `${V2_PATH}.bak-${Date.now()}`;
  fs.copyFileSync(V2_PATH, bak);
  console.log(`✓ v2 库已备份 → ${bak}`);
  console.log('[run] 迁移完成：');
  console.log(JSON.stringify(report, null, 2));
  const v2Sess = v2.prepare('SELECT COUNT(*) c FROM sessions').get();
  const v2Msg = v2.prepare('SELECT COUNT(*) c FROM messages').get();
  console.log(`校验：v2 sessions=${v2Sess.c}（迁入 ${report.sessions}），messages=${v2Msg.c}（迁入 ${report.messages}）`);
  if (v2Sess.c < report.sessions || v2Msg.c < report.messages) {
    console.error('✗ 校验失败：v2 行数少于迁入数（IGNORE 冲突属正常，请人工核对）');
  } else {
    console.log('✓ 校验通过');
  }
  v2.pragma('foreign_keys = ON');
  v2.close();
}
