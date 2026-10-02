/**
 * storage/pomodoro — 番茄钟会话的读写（契约 `docs/POMODORO-SPEC.md` §4）。
 * 套路照 `answer-style.ts`：`app_settings` 每用户一行、读不到或 JSON 坏都当「没开钟」、落库前先归一。
 *
 * ★ 为什么不开新表：一个用户同一时刻只有一个番茄钟，它是**状态**不是**流水**——
 *   历史战绩只保留在会话自身的 `completed` 里，结束即清。要做「本周专注了几小时」再开表，现在不预支。
 * ★ `ownerId` 必填、读写同口径 `ownerForWrite`，理由见 `answer-style.ts` 头注（单值读形状不豁免过滤）。
 */
import { getDb } from './db.js';
import { randomUUID } from 'node:crypto';
import { POMODORO_STATS_DAYS, SETTING_KEY_POMODORO, localDayKey, normalizePomodoro, type PomodoroSession, type PomodoroStats } from '@sb/shared';
import { ownerForWrite } from '../auth/ownership.js';

export function loadPomodoro(ownerId: string | null): PomodoroSession | null {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_POMODORO) as { value: string } | undefined;
  if (!row) return null;
  try {
    return normalizePomodoro(JSON.parse(row.value) as unknown);
  } catch {
    return null;
  }
}

/** 存会话；入参先归一，非法 ⇒ 不写、返回 null（调用方据此 400） */
export function savePomodoro(input: unknown, ownerId: string | null): PomodoroSession | null {
  const clean = normalizePomodoro(input);
  if (!clean) return null;
  getDb()
    .prepare(
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_POMODORO, JSON.stringify(clean));
  return clean;
}

export function clearPomodoro(ownerId: string | null): void {
  getDb().prepare('DELETE FROM app_settings WHERE owner_id = ? AND key = ?').run(ownerForWrite(ownerId), SETTING_KEY_POMODORO);
}

// ── 流水与统计（v54 `pomodoro_log`，契约 §10）──────────────────────────────

/** 记一个**完成**的工作段（调用方在 `completed` 增加时调；这里不判断、只落行） */
export function logPomodoroRound(ownerId: string | null, s: Pick<PomodoroSession, 'subject' | 'workMin' | 'round'>, now: Date = new Date()): void {
  getDb()
    .prepare(`INSERT INTO pomodoro_log (id, owner_id, subject, work_min, round, day, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), ownerForWrite(ownerId), s.subject, s.workMin, s.round, localDayKey(now), now.toISOString());
}

/** 近 N 天（含今天）的专注统计；逐日缺日补 0，方向按分钟降序 */
export function pomodoroStats(ownerId: string | null, now: Date = new Date(), days = POMODORO_STATS_DAYS): PomodoroStats {
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(localDayKey(new Date(now.getTime() - i * 86_400_000)));
  const first = dayKeys[0] ?? localDayKey(now);
  const rows = getDb()
    .prepare(`SELECT subject, work_min AS workMin, day FROM pomodoro_log WHERE owner_id = ? AND day >= ? ORDER BY ended_at ASC`)
    .all(ownerForWrite(ownerId), first) as Array<{ subject: string; workMin: number; day: string }>;
  const byDay = new Map(dayKeys.map((d) => [d, { day: d, rounds: 0, minutes: 0 }]));
  const bySub = new Map<string, { subject: string; rounds: number; minutes: number }>();
  for (const r of rows) {
    const d = byDay.get(r.day);
    if (d) {
      d.rounds += 1;
      d.minutes += r.workMin;
    }
    const sub = bySub.get(r.subject) ?? { subject: r.subject, rounds: 0, minutes: 0 };
    sub.rounds += 1;
    sub.minutes += r.workMin;
    bySub.set(r.subject, sub);
  }
  const todayKey = dayKeys[dayKeys.length - 1] ?? localDayKey(now);
  const today = byDay.get(todayKey) ?? { day: todayKey, rounds: 0, minutes: 0 };
  return {
    today: { rounds: today.rounds, minutes: today.minutes },
    recent: dayKeys.map((d) => byDay.get(d) ?? { day: d, rounds: 0, minutes: 0 }),
    bySubject: [...bySub.values()].sort((a, b) => b.minutes - a.minutes || a.subject.localeCompare(b.subject)),
  };
}
