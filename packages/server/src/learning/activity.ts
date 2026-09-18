/**
 * learning/activity — 反馈环服务：事件订阅者（演进②收口）。
 * XP/等级/连签/每日计数；每日总结（summarizer 角色生成，失败降级统计文本 ADR-4）。
 *
 * ★ M2d（2026-09-18，契约 docs/TENANCY-SPEC.md §8.2）：本文件的**三张表全部归主**——
 *   `daily_activity`（PK 由 `(day,type)` 改 `(owner_id,day,type)`）、`daily_summaries`
 *   （PK 由 `day` 改 `(owner_id,day)`）、`user_stats`（PK 由 `key` 改 `(owner_id,key)`）。
 *   改之前它们**全是全局表**：A、B 同一天聊天直接撞主键；`user_stats` 里存的是 `xp`
 *   ⇒ **A 和 B 的 XP 是同一个数**、等级与连签同理；`daily_summaries` 的 `PK(day)`
 *   更直接 ⇒ **B 读到 A 的今日总结**（改前那行注释已把这条记为"已知缺口"）。
 *
 * ★ `ownerId` 一律**必填**（`string | null`），不给缺省值——理由见 `recordActivity` 的注释：
 *   漏传的表现是「记到无主行上」，用户自己的 XP 静默少算，测试不会红。
 *   `null` = 未登录单人模式 ⇒ 落库 `''`（无主行），读侧则豁免过滤（见 `auth/ownership.ts`）。
 */
import { getDb } from '../storage/db.js';
import { subscribeEvents } from '../events/bus.js';
import { routeRole } from '../llm/router.js';
import { ownerForWrite } from '../auth/ownership.js';

const XP_PER = { chat_done: 2, quiz_answered: 3, quiz_generated: 5, term_added: 1 } as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

/** 连签：从今天往前数连续有活动的天数（今天无活动不打断昨天的连签） */
export function computeStreak(ownerId: string | null, db = getDb()): number {
  const owner = ownerForWrite(ownerId);
  let streak = 0;
  const d = new Date();
  const countOn = (day: string): number =>
    (db.prepare('SELECT COUNT(*) c FROM daily_activity WHERE owner_id = ? AND day = ?').get(owner, day) as { c: number })
      .c;
  // 若今天无活动，从昨天起算（连签不因"今天还没学"清零）
  if (countOn(d.toISOString().slice(0, 10)) === 0) d.setDate(d.getDate() - 1);
  for (;;) {
    if (countOn(d.toISOString().slice(0, 10)) === 0) break;
    streak += 1;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

export function last7Days(ownerId: string | null): Array<{ day: string; count: number }> {
  const db = getDb();
  const owner = ownerForWrite(ownerId);
  const out: Array<{ day: string; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const r = db
      .prepare('SELECT COALESCE(SUM(count),0) c FROM daily_activity WHERE owner_id = ? AND day = ?')
      .get(owner, day) as { c: number };
    out.push({ day, count: r.c });
  }
  return out;
}

/**
 * 今日总结：有缓存用缓存；无则走 summarizer 角色生成（失败降级为统计文本）。
 * ★ M2c：`ownerId` 是 LLM 调用的归属（契约 §8.1.4）。
 * ★ M2d：**缓存键也含 owner 了**——改前 `daily_summaries` 是 `PK(day)` 的全局表，
 *   「有缓存用缓存」那句的后果是 **B 直接读到 A 的今日总结**（当时已在注释里记为已知缺口，
 *   本批修掉）。现在 `(owner_id, day)` 各自一份，且总结里引用的统计数也全是本人的。
 */
export async function todaySummary(ownerId: string | null): Promise<string> {
  const day = today();
  const owner = ownerForWrite(ownerId);
  const cached = getDb()
    .prepare('SELECT content FROM daily_summaries WHERE owner_id = ? AND day = ?')
    .get(owner, day) as { content: string } | undefined;
  if (cached) return cached.content;
  const st = todayStats(ownerId);
  const acts = st.activities.map((a) => `${a.type}×${a.count}`).join('、') || '暂无活动';
  const fallback = `今日（${day}）：${acts}。XP ${st.xp}（Lv.${st.level}），连签 ${st.streak} 天。`;
  const target = routeRole('summarizer', undefined, ownerId);
  if (!target || !target.model) return fallback;
  try {
    let acc = '';
    for await (const chunk of target.adapter.chat({
      model: target.model,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      messages: [{ role: 'user', content: `用两三句鼓励的话总结今天的学习情况，数据：${fallback}。只输出总结文字。` }],
    })) {
      acc += chunk.content;
      if (chunk.done) break;
    }
    const content = acc.trim() || fallback;
    getDb()
      .prepare(
        `INSERT INTO daily_summaries (owner_id, day, content) VALUES (?, ?, ?)
         ON CONFLICT(owner_id, day) DO UPDATE SET content = excluded.content`,
      )
      .run(owner, day, content);
    return content;
  } catch {
    return fallback; // 降级不崩（ADR-4）
  }
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
  });
}
