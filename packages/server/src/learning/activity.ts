/**
 * learning/activity — 反馈环服务：事件订阅者（演进②收口）。
 * XP/等级/连签/每日计数。
 *
 * ★ M2d（2026-09-18，契约 docs/TENANCY-SPEC.md §8.2）：本文件的**两张表全部归主**——
 *   `daily_activity`（PK 由 `(day,type)` 改 `(owner_id,day,type)`）、`user_stats`（PK 由
 *   `key` 改 `(owner_id,key)`）。改之前它们**全是全局表**：A、B 同一天聊天直接撞主键；
 *   `user_stats` 里存的是 `xp` ⇒ **A 和 B 的 XP 是同一个数**、等级与连签同理。
 *
 * ★ 「今日总结」已于 2026-09-25 整族下线（老板判决：无人使用），`daily_summaries` 表与
 *   `todaySummary()` 一并移除——注意那是**共用了同一个页面的另一本账**，XP/等级/连签
 *   的台账（本文件）不受影响，仍是督促小窗的数据来源。
 *
 * ★ `ownerId` 一律**必填**（`string | null`），不给缺省值——理由见 `recordActivity` 的注释：
 *   漏传的表现是「记到无主行上」，用户自己的 XP 静默少算，测试不会红。
 *   `null` = 未登录单人模式 ⇒ 落库 `''`（无主行），读侧则豁免过滤（见 `auth/ownership.ts`）。
 */
import { getDb } from '../storage/db.js';
import { subscribeEvents } from '../events/bus.js';
import { ownerForWrite } from '../auth/ownership.js';
import { addDays, localDayKey } from '@sb/shared';

const XP_PER = { chat_done: 2, quiz_answered: 3, quiz_generated: 5, term_added: 1, review_completed: 2 } as const;

/**
 * ★ **打卡级**行为 = 算「今天学了」的那一档（契约 `GAMIFIED-AGENT-SPEC` §8.1）。
 *   `chat_done` **刻意不在列**（老板 2026-09-25 定案「聊天不打卡」）：纯聊天照样涨 XP、照样进
 *   近 7 天柱状，但不撑连签——否则「打开软件聊两句」就能把连签挂着，这个数字就不值钱了。
 *   ★ 用 `keyof typeof XP_PER` 约束 ⇒ 将来给 `XP_PER` 加一档而忘了想它算不算学习日，编译不过。
 */
const STREAK_TYPES: ReadonlyArray<keyof typeof XP_PER> = [
  'quiz_answered',
  'quiz_generated',
  'term_added',
  'review_completed',
];

/** 周目标：一个自然周（**周一起**）里凑满 5 个学习日才延续连签（拍板③「当周任 5 天即续」，§8.2） */
const STREAK_WEEK_TARGET = 5;

/** 往前数多少周就停：210 周 ≈ 四年，覆盖任何现实的连签长度，只为给循环一个上界 */
const STREAK_WEEK_GUARD = 210;

function today(): string {
  // ★ 本地日历日（`localDayKey`），不再是 `toISOString()` 的 UTC 日——契约 §8.4：
  //   复习侧（`markReviewed`/`term_review_log.reviewed_day`）与增长侧（`growth/counters.ts`）
  //   本来都按本地日记，只有这里按 UTC ⇒ 北京时间 00:00–08:00 的学习被记到前一天，
  //   两本连签账收口成一本之后，这个差一天就成了「同一行为两种归属」。老行不回改（代价见 §8.4）。
  return localDayKey(new Date());
}

/**
 * 记一笔活动。
 *
 * ★ 参数顺序刻意是 `(type, ownerId, n)`：把「这笔算在谁头上」放在数量**之前**，且**必填**。
 *   若给它缺省 `null`，那么任何一处漏传都会静默记进无主行——用户看到的是「我今天明明
 *   聊了十轮，XP 却没涨」，而单测只要不覆盖那条路径就全绿（本仓已为这类"写反了也不报错"
 *   付过学费，见 TENANCY-SPEC §8.1 的口径表）。
 */
export function recordActivity(type: keyof typeof XP_PER, ownerId: string | null, n = 1): void {
  getDb()
    .prepare(
      `INSERT INTO daily_activity (owner_id, day, type, count) VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id, day, type) DO UPDATE SET count = count + excluded.count`,
    )
    .run(ownerForWrite(ownerId), today(), type, n);
  bumpXp(XP_PER[type] * n, ownerId);
}

function bumpXp(delta: number, ownerId: string | null): void {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const cur = db.prepare('SELECT value FROM user_stats WHERE owner_id = ? AND key = ?').get(owner, 'xp') as
    | { value: string }
    | undefined;
  const xp = Number(cur?.value ?? 0) + delta;
  db.prepare(
    `INSERT INTO user_stats (owner_id, key, value) VALUES (?, 'xp', ?)
     ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
  ).run(owner, String(xp));
}

export function todayStats(ownerId: string | null): {
  day: string;
  xp: number;
  level: number;
  streak: number;
  activities: Array<{ type: string; count: number }>;
} {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const xp = Number(
    (db.prepare('SELECT value FROM user_stats WHERE owner_id = ? AND key = ?').get(owner, 'xp') as
      | { value: string }
      | undefined)?.value ?? 0,
  );
  const acts = db
    .prepare('SELECT type, count FROM daily_activity WHERE owner_id = ? AND day = ?')
    .all(owner, today()) as Array<{ type: string; count: number }>;
  return { day: today(), xp, level: levelFromXp(xp), streak: computeStreak(ownerId, db), activities: acts };
}

export function levelFromXp(xp: number): number {
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

/** 所在自然周的**周一**日期键（`getDay()`：周日=0 ⇒ 挪回本周一） */
function weekStartDay(day: string): string {
  const dow = (new Date(`${day}T00:00:00`).getDay() + 6) % 7;
  return addDays(day, -dow);
}

/** 该人所有**学习日**（打过卡的日子，已去重、升序） */
function learningDaysOf(owner: string, db: ReturnType<typeof getDb>): string[] {
  const ph = STREAK_TYPES.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT DISTINCT day FROM daily_activity WHERE owner_id = ? AND type IN (${ph}) ORDER BY day`)
    .all(owner, ...STREAK_TYPES) as Array<{ day: string }>;
  return rows.map((r) => r.day);
}

/**
 * 连签（**周结算口径**，契约 §8.2；2026-09-25 改判自旧版「严格逐日连续」）。
 *
 * 规则三条，逐条都有锁（`streak.test.ts`）：
 * 1. 从**本周**往前数连续的自然周：已结束的周学习日 ≥5 ⇒ 计入并继续；<5 ⇒ 链断。
 * 2. **本周永不提前判死**：本周还没过完，学几天都先计着，也照样向更早的周累加——
 *    「周一睡过头」只表现为数字不涨，不表现为清零（旧版那种「今天没学就从昨天起算」的宽恕，被更一般化的本条吸收）。
 * 3. 数字 = 链内**学习日的个数**，不是自然日跨度 ⇒ 被宽恕的空洞日不计入数字、也不清零。
 *
 * ★ `ownerId` 走 `ownerForWrite`（`null` = 未登录单人模式 ⇒ 读无主行 `''`），与 `recordActivity` 写侧同一口径。
 * ★ 第三参 `now` **可注入**：周结算的一切都取决于
 *   「今天在周几」，拿真时钟写锁会**随运行的星期哪天红哪天**——测试一律传固定假钟。
 */
export function computeStreak(ownerId: string | null, db = getDb(), now: Date = new Date()): number {
  const days = new Set(learningDaysOf(ownerForWrite(ownerId), db));
  if (days.size === 0) return 0;
  const currentWeek = weekStartDay(localDayKey(now));
  let total = 0;
  let week = currentWeek;
  for (let guard = 0; guard < STREAK_WEEK_GUARD; guard++) {
    let count = 0;
    for (let i = 0; i < 7; i++) if (days.has(addDays(week, i))) count += 1;
    const isCurrentWeek = week === currentWeek;
    // 已结束的周不足 5 天 ⇒ 断链（本周例外：见规则 2）
    if (!isCurrentWeek && count < STREAK_WEEK_TARGET) break;
    total += count;
    week = addDays(week, -7);
  }
  return total;
}

export function last7Days(ownerId: string | null): Array<{ day: string; count: number }> {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const out: Array<{ day: string; count: number }> = [];
  // 与连签同口径：本地日历日往前数 7 天（改前是 UTC 日 ⇒ 同一份数据两处对不上）
  let day = today();
  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    keys.unshift(day);
    day = addDays(day, -1);
  }
  for (const k of keys) {
    const r = db
      .prepare('SELECT COALESCE(SUM(count),0) c FROM daily_activity WHERE owner_id = ? AND day = ?')
      .get(owner, k) as { c: number };
    out.push({ day: k, count: r.c });
  }
  return out;
}

/**
 * 启动时注册事件订阅（幂等：模块单例）。
 *
 * ★ 事件里**必须带 `ownerId`**（M2d）：本订阅者是「这轮是谁在学」的消费端，而事件总线
 *   改前不带归属 ⇒ 只能记进无主行。四个事件的 `ownerId` 在类型上**必填**，
 *   于是漏传是**编译错误**而不是静默少算（同 `routeRole` 的第三参思路）。
 *   ★ 未登录时发布方传 `null` ⇒ 记进无主行，符合"本地单人模式"的既有语义。
 */
let wired = false;
export function wireActivityEvents(): void {
  if (wired) return;
  wired = true;
  subscribeEvents((ev) => {
    if (ev.type === 'chat_done') recordActivity('chat_done', ev.ownerId);
    else if (ev.type === 'quiz_generated') recordActivity('quiz_generated', ev.ownerId);
    else if (ev.type === 'quiz_answered') recordActivity('quiz_answered', ev.ownerId);
    else if (ev.type === 'term_added') recordActivity('term_added', ev.ownerId, ev.count);
    else if (ev.type === 'review_completed') recordActivity('review_completed', ev.ownerId);
  });
}
