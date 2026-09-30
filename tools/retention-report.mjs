#!/usr/bin/env node
/**
 * retention-report.mjs — 只读打开生产库，算出留存 / 活跃 / 激活漏斗（契约 docs/RETENTION-SPEC.md §3）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 「已上线」不等于「有留存」。`docs/metrics-product.md` 把 L3（留存）标成 ❌ 的原因是机制缺失：
 * 产品里没有「谁在什么时候来过」的事件流，空库与没人用在库里长得一样。v52 的 `user_activity_day`
 * 心跳补上了「来过」这一半；「用过」那一半（对话 / 复习）库里一直有，只是从没有人把它算成留存。
 * 本脚本把两半合起来，用**固定口径**算数，每次发对外数字前重跑一遍——数字不许手抄，同 metrics.mjs。
 *
 * ── 口径（改口径先改 RETENTION-SPEC）──────────────────────────────────────────
 *   · 活跃日 = 「打开」（user_activity_day 有行）∪「用过」（当天发过 user 消息 / 做过复习）
 *   · 排除：体验号（DEMO_USER_EMAIL）、`*.invalid` 邮箱、`--exclude-email` 点名的（项目所有者自己）
 *   · 留存分两种：次日 D1（注册日 +1 那一天活跃）；分桶 W1..W4（注册后第 1–7 / 8–14 / 15–21 / 22–28 天内任一天活跃）
 *     分母只算「注册已满 N 天」的用户（不满的没资格被判流失）
 *   · 分母 < 30 的百分比一律带 ⚠️（metrics-product §0 第 3 条：小样本不许下结论，只报绝对数）
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   node tools/retention-report.mjs --db /opt/studentbuddy/data/studentbuddy.db [--days 30] [--exclude-email a@b.c]
 *   node tools/retention-report.mjs --db … --json          # 机器可读
 *   node tools/retention-report.mjs --selftest              # 内存库 + 已知答案，证明口径算得对
 *
 * ★ 只读（`readonly: true`），零 PII 输出（不打印任何邮箱 / id），零网络。
 */
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DEMO_USER_EMAIL = 'shared-demo@studentbuddy.invalid';
const DAY_MS = 86_400_000;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
function args(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

const dayKey = (d) => `${d.getUTCFullYear()}-${`${d.getUTCMonth() + 1}`.padStart(2, '0')}-${`${d.getUTCDate()}`.padStart(2, '0')}`;
const parseDay = (k) => Date.UTC(...k.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)));
const addDays = (k, n) => dayKey(new Date(parseDay(k) + n * DAY_MS));
const diffDays = (a, b) => Math.round((parseDay(a) - parseDay(b)) / DAY_MS);

function hasTable(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

/**
 * 从库里取事实（只读几条聚合 SQL）；`utcOffsetHours` 把 UTC 时间戳折到当地日。
 * 返回值不含任何个体标识以外的东西，且 id 只在进程内用于分组。
 */
export function collectFacts(db, { utcOffsetHours, excludeEmails }) {
  const shift = `${utcOffsetHours >= 0 ? '+' : '-'}${Math.abs(utcOffsetHours)} hours`;
  const excluded = new Set([DEMO_USER_EMAIL, ...excludeEmails].map((e) => e.toLowerCase()));
  const users = db
    .prepare(`SELECT id, lower(email) AS email, date(created_at, ?) AS day FROM users`)
    .all(shift)
    .filter((u) => !excluded.has(u.email) && !u.email.endsWith('.invalid'))
    .map((u) => ({ id: u.id, day: u.day }));
  const ids = new Set(users.map((u) => u.id));
  const active = new Map(); // id -> Map(day -> Set(kind))
  const mark = (id, day, kind) => {
    if (!ids.has(id) || !day) return;
    if (!active.has(id)) active.set(id, new Map());
    const m = active.get(id);
    if (!m.has(day)) m.set(day, new Set());
    m.get(day).add(kind);
  };
  const heartbeat = hasTable(db, 'user_activity_day');
  if (heartbeat) for (const r of db.prepare(`SELECT user_id, day FROM user_activity_day`).all()) mark(r.user_id, r.day, 'open');
  const msgRows = db
    .prepare(
      `SELECT s.user_id AS uid, date(m.created_at, ?) AS day, COUNT(*) AS n
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE m.role = 'user' AND s.user_id IS NOT NULL GROUP BY uid, day`,
    )
    .all(shift);
  const msgCount = new Map();
  for (const r of msgRows) {
    mark(r.uid, r.day, 'chat');
    if (ids.has(r.uid)) msgCount.set(r.uid, (msgCount.get(r.uid) ?? 0) + r.n);
  }
  if (hasTable(db, 'term_review_log') && hasTable(db, 'term_library')) {
    const rows = db
      .prepare(
        `SELECT t.owner_id AS uid, l.reviewed_day AS day FROM term_review_log l JOIN term_library t ON t.id = l.term_id
         WHERE t.owner_id <> '' GROUP BY uid, day`,
      )
      .all();
    for (const r of rows) mark(r.uid, r.day, 'review');
  }
  const sessionCount = new Map();
  for (const r of db.prepare(`SELECT user_id AS uid, COUNT(*) AS n FROM sessions WHERE user_id IS NOT NULL GROUP BY uid`).all()) {
    if (ids.has(r.uid)) sessionCount.set(r.uid, r.n);
  }
  return { users, active, msgCount, sessionCount, heartbeat };
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const ratio = (num, den) => ({ num, den, pct: pct(num, den), small: den < 30 });
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** 口径本体（纯函数，`--selftest` 直接喂事实验证）。`today` 是当地日键。 */
export function compute(facts, today, windowDays = 30) {
  const { users, active, msgCount, sessionCount } = facts;
  const daysOf = (id) => active.get(id) ?? new Map();
  const isActive = (id, day) => daysOf(id).has(day);
  const activeBetween = (id, from, to) => {
    for (const d of daysOf(id).keys()) if (d >= from && d <= to) return true;
    return false;
  };

  // 活跃：最近 windowDays 天逐日 DAU、WAU（近 7 天）、MAU（近 28 天）、粘性
  const daily = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    let open = 0;
    let engaged = 0;
    let any = 0;
    for (const [, m] of active) {
      const kinds = m.get(d);
      if (!kinds) continue;
      any++;
      if (kinds.has('open')) open++;
      if (kinds.has('chat') || kinds.has('review')) engaged++;
    }
    daily.push({ day: d, any, open, engaged });
  }
  const distinctIn = (n) => {
    const from = addDays(today, -(n - 1));
    let c = 0;
    for (const id of active.keys()) if (activeBetween(id, from, today)) c++;
    return c;
  };
  const wau = distinctIn(7);
  const mau = distinctIn(28);
  const dauAvg7 = daily.slice(-7).reduce((s, x) => s + x.any, 0) / Math.min(7, daily.length || 1);

  // 留存：D1 与 W1..W4 分桶，分母只算注册满 N 天的
  const eligible = (n) => users.filter((u) => diffDays(today, u.day) >= n);
  const d1Users = eligible(1);
  const d1 = ratio(d1Users.filter((u) => isActive(u.id, addDays(u.day, 1))).length, d1Users.length);
  const weekly = [1, 2, 3, 4].map((w) => {
    const from = 7 * (w - 1) + 1;
    const to = 7 * w;
    const el = eligible(to);
    return { week: w, ...ratio(el.filter((u) => activeBetween(u.id, addDays(u.day, from), addDays(u.day, to))).length, el.length) };
  });
  const returned = ratio(users.filter((u) => [...daysOf(u.id).keys()].some((d) => d > u.day)).length, users.length);

  // 激活漏斗：注册 → 发过消息 → 注册日之后还发过 → 做过复习
  const chatted = users.filter((u) => [...daysOf(u.id).values()].some((k) => k.has('chat')));
  const chattedLater = users.filter((u) => [...daysOf(u.id).entries()].some(([d, k]) => d > u.day && k.has('chat')));
  const reviewed = users.filter((u) => [...daysOf(u.id).values()].some((k) => k.has('review')));
  const funnel = {
    registered: users.length,
    chatted: ratio(chatted.length, users.length),
    chattedAgainLater: ratio(chattedLater.length, users.length),
    reviewed: ratio(reviewed.length, users.length),
  };

  // 用量分布
  const msgs = users.map((u) => msgCount.get(u.id) ?? 0);
  const sess = users.map((u) => sessionCount.get(u.id) ?? 0);
  const usage = {
    messagesPerUser: { median: median(msgs), mean: msgs.length ? Math.round((msgs.reduce((a, b) => a + b, 0) / msgs.length) * 10) / 10 : 0, max: Math.max(0, ...msgs) },
    sessionsPerUser: { median: median(sess), mean: sess.length ? Math.round((sess.reduce((a, b) => a + b, 0) / sess.length) * 10) / 10 : 0, max: Math.max(0, ...sess) },
    zeroMessageUsers: msgs.filter((n) => n === 0).length,
  };
  const newByWeek = {};
  for (const u of users) {
    const wk = addDays(u.day, -((parseDay(u.day) / DAY_MS + 3) % 7)); // 周一为界
    newByWeek[wk] = (newByWeek[wk] ?? 0) + 1;
  }
  return { today, windowDays, users: users.length, heartbeat: facts.heartbeat, daily, wau, mau, dauAvg7, stickiness: pct(dauAvg7, mau), d1, weekly, returned, funnel, usage, newByWeek };
}

const fmt = (r) => (r.den === 0 ? '—（无合格样本）' : `${r.num}/${r.den}${r.pct === null ? '' : ` = ${r.pct}%`}${r.small ? ' ⚠️小样本' : ''}`);

export function render(r) {
  const L = [];
  L.push(`# 留存报告（截至 ${r.today}，窗口 ${r.windowDays} 天）`, '');
  L.push(`- 纳入用户：**${r.users}**（已排除体验号 / \`.invalid\` 邮箱 / \`--exclude-email\` 点名者）`);
  L.push(`- 「打开」心跳：${r.heartbeat ? '表已存在（v52）' : '**表不存在（库未迁移到 v52）⇒ 活跃只按「用过」计，会低估**'}`);
  const hbRows = r.daily.reduce((s, x) => s + x.open, 0);
  if (r.heartbeat && hbRows === 0) L.push(`- ⚠️ 窗口内心跳 0 行：v52 刚上线或流量全是探针 ⇒ 「打开」口径尚无数据，本报告的活跃 = 「用过」`);
  L.push('', '## 活跃', '', `| 指标 | 值 |`, `|---|---|`);
  L.push(`| WAU（近 7 天活跃人数） | ${r.wau} |`, `| MAU（近 28 天活跃人数） | ${r.mau} |`);
  L.push(`| 近 7 天日均 DAU | ${Math.round(r.dauAvg7 * 10) / 10} |`, `| 粘性 DAU/MAU | ${r.stickiness === null ? '—' : `${r.stickiness}%`}${r.mau < 30 ? ' ⚠️小样本' : ''} |`);
  const nonZero = r.daily.filter((d) => d.any > 0);
  L.push('', `逐日（只列有活跃的日子，${nonZero.length}/${r.daily.length} 天）：`, '', `| 日 | 活跃 | 打开 | 用过 |`, `|---|---|---|---|`);
  for (const d of nonZero) L.push(`| ${d.day} | ${d.any} | ${d.open} | ${d.engaged} |`);
  L.push('', '## 留存（分母 = 注册已满 N 天的用户）', '', `| 口径 | 值 |`, `|---|---|`);
  L.push(`| 次日 D1（注册日 +1 当天活跃） | ${fmt(r.d1)} |`);
  for (const w of r.weekly) L.push(`| W${w.week}（注册后第 ${7 * (w.week - 1) + 1}–${7 * w.week} 天内活跃） | ${fmt(w)} |`);
  L.push(`| 注册日之后至少回来过一次 | ${fmt(r.returned)} |`);
  L.push('', '## 激活漏斗', '', `| 步骤 | 值 |`, `|---|---|`);
  L.push(`| 注册 | ${r.funnel.registered} |`, `| 发过 ≥1 条消息 | ${fmt(r.funnel.chatted)} |`);
  L.push(`| 注册日之后还发过消息 | ${fmt(r.funnel.chattedAgainLater)} |`, `| 做过 ≥1 次复习 | ${fmt(r.funnel.reviewed)} |`);
  L.push('', '## 用量分布', '', `| 指标 | 中位 | 均值 | 最大 |`, `|---|---|---|---|`);
  L.push(`| 每用户 user 消息数 | ${r.usage.messagesPerUser.median} | ${r.usage.messagesPerUser.mean} | ${r.usage.messagesPerUser.max} |`);
  L.push(`| 每用户会话数 | ${r.usage.sessionsPerUser.median} | ${r.usage.sessionsPerUser.mean} | ${r.usage.sessionsPerUser.max} |`);
  L.push('', `零消息用户：${r.usage.zeroMessageUsers} / ${r.users}`);
  L.push('', `按周新增（周一起算）：${Object.entries(r.newByWeek).sort().map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}`);
  L.push('', '> 读数纪律：分母 < 30 的百分比只能当方向看，对外只报绝对数（metrics-product §0）。本报告只读、不含个体信息。');
  return L.join('\n');
}

/** 内存库 + 已知答案：证明口径算得对（每条断言对应 SPEC §3 的一句话）。 */
function selftest() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, created_at TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, created_at TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, created_at TEXT);
    CREATE TABLE user_activity_day (user_id TEXT, day TEXT, first_seen_at TEXT, PRIMARY KEY (user_id, day));
    CREATE TABLE term_library (id TEXT PRIMARY KEY, owner_id TEXT);
    CREATE TABLE term_review_log (id TEXT PRIMARY KEY, term_id TEXT, reviewed_day TEXT);
  `);
  const ins = (sql, rows) => rows.forEach((r) => db.prepare(sql).run(...r));
  // 时间戳按 UTC 存，报告按 +8 折日；全部选在当地日中午，避开跨日歧义
  ins(`INSERT INTO users VALUES (?,?,?)`, [
    ['A', 'a@x.test', '2026-09-01 04:00:00'], // 老用户：次日活跃、W1/W2 活跃、W3/W4 沉默、9-29 回来
    ['B', 'b@x.test', '2026-09-20 04:00:00'], // 注册即走
    ['C', 'c@x.test', '2026-09-29 04:00:00'], // 昨天注册、今天活跃（只有 D1 资格）
    ['D', DEMO_USER_EMAIL, '2026-09-01 04:00:00'], // 体验号：排除
    ['E', 'owner@x.test', '2026-09-01 04:00:00'], // 所有者：--exclude-email 排除
  ]);
  ins(`INSERT INTO sessions VALUES (?,?,?)`, [['s1', 'A', ''], ['s2', 'A', ''], ['s3', 'C', ''], ['s4', 'D', ''], ['s5', 'E', '']]);
  ins(`INSERT INTO messages VALUES (?,?,?,?)`, [
    ['m1', 's1', 'user', '2026-09-01 05:00:00'], ['m2', 's1', 'assistant', '2026-09-01 05:00:10'],
    ['m3', 's1', 'user', '2026-09-02 05:00:00'], ['m4', 's2', 'user', '2026-09-10 05:00:00'],
    ['m5', 's3', 'user', '2026-09-30 05:00:00'], ['m6', 's4', 'user', '2026-09-30 05:00:00'], ['m7', 's5', 'user', '2026-09-30 05:00:00'],
  ]);
  ins(`INSERT INTO user_activity_day VALUES (?,?,?)`, [['A', '2026-09-29', ''], ['B', '2026-09-20', ''], ['D', '2026-09-30', '']]);
  ins(`INSERT INTO term_library VALUES (?,?)`, [['t1', 'A']]);
  ins(`INSERT INTO term_review_log VALUES (?,?,?)`, [['r1', 't1', '2026-09-10']]);

  const facts = collectFacts(db, { utcOffsetHours: 8, excludeEmails: ['owner@x.test'] });
  const r = compute(facts, '2026-09-30', 30);
  const checks = [
    ['排除体验号与点名邮箱后纳入 3 人', r.users === 3],
    ['D1：A(9-02 发消息) ✓ B ✗ C(9-30 发消息) ✓ ⇒ 2/3', r.d1.num === 2 && r.d1.den === 3],
    ['W1 分母只算注册满 7 天的（A、B）⇒ 1/2', r.weekly[0].num === 1 && r.weekly[0].den === 2],
    ['W2：A 在第 9 天（9-10）有复习 ⇒ 1/1（复习也算活跃；B 注册未满 14 天，无资格）', r.weekly[1].num === 1 && r.weekly[1].den === 1],
    ['W3：A 第 15–21 天沉默 ⇒ 0/1', r.weekly[2].num === 0 && r.weekly[2].den === 1],
    ['W4：A 第 28 天（9-29）有心跳 ⇒ 1/1（B 注册未满 28 天，无资格）', r.weekly[3].num === 1 && r.weekly[3].den === 1],
    ['「回来过」：A ✓ B ✗（注册当天心跳不算回来）C ✓ ⇒ 2/3', r.returned.num === 2 && r.returned.den === 3],
    ['漏斗：发过消息 2/3（B 零消息）、注册日之后再发 2/3（A、C）、复习 1/3', r.funnel.chatted.num === 2 && r.funnel.chattedAgainLater.num === 2 && r.funnel.reviewed.num === 1],
    ['WAU（9-24..9-30）：A(9-29 心跳)、C ⇒ 2；MAU（9-03..9-30）：A、B(9-20)、C ⇒ 3', r.wau === 2 && r.mau === 3],
    ['今日 DAU=1（C）且拆成 打开 0 / 用过 1', r.daily.at(-1).any === 1 && r.daily.at(-1).open === 0 && r.daily.at(-1).engaged === 1],
    ['用量：消息中位 1（A=3,B=0,C=1）、零消息用户 1', r.usage.messagesPerUser.median === 1 && r.usage.zeroMessageUsers === 1],
    ['小样本标记：分母 3 < 30 ⇒ ⚠️', r.d1.small === true],
    ['输出零 PII：报告文本里没有任何邮箱', !/@/.test(render(r))],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} 自证 ${name}`);
  }
  if (bad) console.log(JSON.stringify(r, null, 1));
  console.log(bad === 0 ? '✓ retention-report 自证通过' : `✗ retention-report 自证失败 ${bad} 条`);
  return bad === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const dbPath = arg('db', process.env.SB_DATA_DIR ? path.join(process.env.SB_DATA_DIR, 'studentbuddy.db') : null);
  if (!dbPath) {
    console.error('用法：node tools/retention-report.mjs --db <studentbuddy.db> [--days 30] [--exclude-email a@b.c]... [--json] [--utc-offset 8]');
    return 2;
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.error(`✗ 打不开库 ${dbPath}：${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const utcOffsetHours = Number(arg('utc-offset', String(-new Date().getTimezoneOffset() / 60)));
  const facts = collectFacts(db, { utcOffsetHours, excludeEmails: args('exclude-email') });
  const today = arg('today', dayKey(new Date(Date.now() + utcOffsetHours * 3600_000)));
  const r = compute(facts, today, Number(arg('days', '30')));
  db.close();
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  return 0;
}

process.exit(main());
