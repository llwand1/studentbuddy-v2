/**
 * storage/confirm-threshold — 确认门阈值的按人读写（契约 TOOL-ECOSYSTEM-SPEC §6.3-4，v1.4 拍板⑮）。
 * 套路照 `storage/answer-style.ts`：读不到/坏值回退默认，落库前先归一化；
 * 读写同口径 `ownerForWrite`（`null` ⇒ `''` 无主行），判据见该文件头注，不在此复述。
 *
 * ★ 为什么单独成文件而不是住进 `chat/tools/confirm.ts`：确认门的挂起/裁决是**纯内存**逻辑
 *   （可零 mock 单测），而这里要碰 `getDb()`——混在一起会让 confirm 的测试也背上库。
 *   阈值只在门真要决策「弹不弹」时才读一次（免确认档与必确认档根本不碰这里）。
 */
import { getDb } from './db.js';
import { ownerForWrite } from '../auth/ownership.js';
import { DEFAULT_CONFIRM_THRESHOLD, SETTING_KEY_CONFIRM_THRESHOLD, normalizeConfirmThreshold } from '@sb/shared';

/** 读阈值（未配过/坏值回退默认 5） */
export function loadConfirmThreshold(ownerId: string | null): number {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_CONFIRM_THRESHOLD) as { value: string } | undefined;
  if (!row) return DEFAULT_CONFIRM_THRESHOLD;
  try {
    return normalizeConfirmThreshold(JSON.parse(row.value) as unknown);
  } catch {
    return DEFAULT_CONFIRM_THRESHOLD;
  }
}

/** 存阈值；返回归一后的实际落库值（设置页要如实显示存进去的是哪一档） */
export function saveConfirmThreshold(input: unknown, ownerId: string | null): number {
  const clean = normalizeConfirmThreshold(input);
  getDb()
    .prepare(
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_CONFIRM_THRESHOLD, JSON.stringify(clean));
  return clean;
}
