/**
 * learning/activity — 反馈环服务：事件订阅者（演进②收口）。
 * XP/等级/连签/每日计数；每日总结（summarizer 角色生成，失败降级统计文本 ADR-4）。
 */
import { getDb } from '../storage/db.js';
import { subscribeEvents } from '../events/bus.js';
import { routeRole } from '../llm/router.js';

const XP_PER = { chat_done: 2, quiz_answered: 3, review_done: 2, quiz_generated: 5 } as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function recordActivity(type: keyof typeof XP_PER, n = 1): void {
  getDb()
    .prepare(
      `INSERT INTO daily_activity (day, type, count) VALUES (?, ?, ?)
       ON CONFLICT(day, type) DO UPDATE SET count = count + excluded.count`,
    )
    .run(today(), type, n);
  bumpXp(XP_PER[type] * n);
}

function bumpXp(delta: number): void {
  const cur = getDb().prepare("SELECT value FROM user_stats WHERE key='xp'").get() as { value: string } | undefined;
  const xp = Number(cur?.value ?? 0) + delta;
  getDb()
    .prepare("INSERT INTO user_stats (key, value) VALUES ('xp', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(xp));
}

export function todayStats(): { day: string; xp: number; level: number; streak: number; activities: Array<{ type: string; count: number }> } {
  const db = getDb();
  const xp = Number((db.prepare("SELECT value FROM user_stats WHERE key='xp'").get() as { value: string } | undefined)?.value ?? 0);
  const acts = db.prepare('SELECT type, count FROM daily_activity WHERE day = ?').all(today()) as Array<{ type: string; count: number }>;
  return { day: today(), xp, level: levelFromXp(xp), streak: computeStreak(db), activities: acts };
}

export function levelFromXp(xp: number): number {
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

/** 连签：从今天往前数连续有活动的天数（今天无活动不打断昨天的连签） */
export function computeStreak(db = getDb()): number {
  let streak = 0;
  const d = new Date();
  // 若今天无活动，从昨天起算（连签不因"今天还没学"清零）
  const todayActs = (db.prepare('SELECT COUNT(*) c FROM daily_activity WHERE day = ?').get(d.toISOString().slice(0, 10)) as { c: number }).c;
  if (todayActs === 0) d.setDate(d.getDate() - 1);
  for (;;) {
    const day = d.toISOString().slice(0, 10);
    const c = (db.prepare('SELECT COUNT(*) c FROM daily_activity WHERE day = ?').get(day) as { c: number }).c;
    if (c === 0) break;
    streak += 1;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

export function last7Days(): Array<{ day: string; count: number }> {
  const db = getDb();
  const out: Array<{ day: string; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const r = db.prepare('SELECT COALESCE(SUM(count),0) c FROM daily_activity WHERE day = ?').get(day) as { c: number };
    out.push({ day, count: r.c });
  }
  return out;
}

/** 今日总结：有缓存用缓存；无则走 summarizer 角色生成（失败降级为统计文本）。 */
export async function todaySummary(): Promise<string> {
  const day = today();
  const cached = getDb().prepare('SELECT content FROM daily_summaries WHERE day = ?').get(day) as { content: string } | undefined;
  if (cached) return cached.content;
  const st = todayStats();
  const acts = st.activities.map((a) => `${a.type}×${a.count}`).join('、') || '暂无活动';
  const fallback = `今日（${day}）：${acts}。XP ${st.xp}（Lv.${st.level}），连签 ${st.streak} 天。`;
  const target = routeRole('summarizer');
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
      .prepare('INSERT INTO daily_summaries (day, content) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET content = excluded.content')
      .run(day, content);
    return content;
  } catch {
    return fallback; // 降级不崩（ADR-4）
  }
}

/** 启动时注册事件订阅（幂等：模块单例） */
let wired = false;
export function wireActivityEvents(): void {
  if (wired) return;
  wired = true;
  subscribeEvents((ev) => {
    if (ev.type === 'chat_done') recordActivity('chat_done');
    else if (ev.type === 'quiz_generated') recordActivity('quiz_generated');
    else if (ev.type === 'quiz_answered') recordActivity('quiz_answered');
    else if (ev.type === 'review_done') recordActivity('review_done');
  });
}
