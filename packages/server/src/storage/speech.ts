/**
 * storage/speech — 词条英文发音设置（音色 / 语速）的读写。
 * 套路照 `storage/answer-style.ts`：读不到 / JSON 坏都回退默认，落库前先归一化。
 *
 * ★ **有意不提供「配过没有」的查询**（对比 `isAnswerStyleConfigured`）：回答方式的
 *   `configured` 存在是因为「没配过」要触发 L1 选项卡；而朗读设置**没有任何需要区分
 *   两态的流程**（默认值就是可用状态，不问、不弹）。故三件套＝load / save / reset，
 *   不另造一个没有消费方的查询函数。
 *
 * ★ **`ownerId` 一律必填**（`string | null`）：读侧漏传会读到别人的偏好、写侧漏传会把
 *   设置写进无主行（用户自己下次读不到）——**两种都静默，不让任何测试变红**，只能靠类型挡住。
 *   读写两侧同口径：一律 `ownerForWrite(ownerId)`（`null` ⇒ `''` ＝无主行），
 *   判据与完整推演见 `auth/ownership.ts`。
 */
import { getDb } from './db.js';
import { DEFAULT_SPEECH_SETTINGS, SETTING_KEY_SPEECH, normalizeSpeechSettings } from '@sb/shared';
import type { SpeechSettings } from '@sb/shared';
import { ownerForWrite } from '../auth/ownership.js';

/** 读设置；未配过 / 配置损坏 / 值非法都回退默认（数据容错，ADR-6） */
export function loadSpeechSettings(ownerId: string | null): SpeechSettings {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_SPEECH) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_SPEECH_SETTINGS };
  try {
    return normalizeSpeechSettings(JSON.parse(row.value) as unknown);
  } catch {
    return { ...DEFAULT_SPEECH_SETTINGS };
  }
}

/** 存设置；入参一律过归一化，库里永远是干净值。返回归一后的实际落库值 */
export function saveSpeechSettings(input: unknown, ownerId: string | null): SpeechSettings {
  const clean = normalizeSpeechSettings(input);
  getDb()
    .prepare(
      // ★ `ON CONFLICT` 的目标必须与主键 `(owner_id, key)` 一致（v30 起）：SQL 是字符串，
      //   写成 `ON CONFLICT(key)` 编译期零信号、运行时才报「找不到匹配的唯一索引」。
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_SPEECH, JSON.stringify(clean));
  return clean;
}

/** 删键＝回到「用系统默认音色 + 正常语速」：设置页「恢复默认」用 */
export function resetSpeechSettings(ownerId: string | null): void {
  getDb()
    .prepare('DELETE FROM app_settings WHERE owner_id = ? AND key = ?')
    .run(ownerForWrite(ownerId), SETTING_KEY_SPEECH);
}
