/**
 * storage/pomodoro — 番茄钟会话的读写（契约 `docs/POMODORO-SPEC.md` §4）。
 * 套路照 `answer-style.ts`：`app_settings` 每用户一行、读不到或 JSON 坏都当「没开钟」、落库前先归一。
 *
 * ★ 为什么不开新表：一个用户同一时刻只有一个番茄钟，它是**状态**不是**流水**——
 *   历史战绩只保留在会话自身的 `completed` 里，结束即清。要做「本周专注了几小时」再开表，现在不预支。
 * ★ `ownerId` 必填、读写同口径 `ownerForWrite`，理由见 `answer-style.ts` 头注（单值读形状不豁免过滤）。
 */
import { getDb } from './db.js';
import { SETTING_KEY_POMODORO, normalizePomodoro, type PomodoroSession } from '@sb/shared';
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
