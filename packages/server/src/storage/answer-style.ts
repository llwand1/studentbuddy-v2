/**
 * storage/answer-style — 回答方式偏好的读写（契约 docs/ANSWER-STYLE-SPEC.md §2）。
 * 套路照 quiz.ts 的 loadQuizMix/saveQuizMix：读不到或 JSON 坏都回退默认，落库前先归一化。
 * ★ 额外回答「配过没有」：没配过 与 配成了恰好等于默认的值 在 AnswerStyle 上长得一样，
 *   而 L1 要不要弹选项卡全靠这个区分——只回 style 表达不了这件事。
 *
 * ★ M2d（2026-09-18，契约 TENANCY-SPEC §8.2）：`app_settings` 由**全局一份**改成**每用户一份**
 *   （v30，主键 `(owner_id, key)`）。改前它是个**全局写口**——A 在设置页改一次回答方式，
 *   **全站所有人的口吻都跟着变**（与 `role_bindings` 同一类隐患）。
 *
 * ★ `ownerId` 一律**必填**（`string | null`），不给缺省值：
 *   · 读侧漏传 ⇒ 读到别人的偏好（静默，表现为"我明明改过"）；
 *   · 写侧漏传 ⇒ 写进无主行，用户自己下次读不到（静默）；
 *   两种都不会让任何测试变红，故只能靠类型挡住——与 `routeRole` 第三参、`bindQuota` 同一条思路。
 * ★ **读写两侧同口径**：一律 `ownerForWrite(ownerId)`（`null` ⇒ `''` = 无主行）。
 *   为什么读侧**不**豁免过滤（这组表的读形状是**单值** `.get()`，豁免后库里多行会返回**任意一行**
 *   ⇒ 静默串台）——判据与完整推演见 `auth/ownership.ts` 的 `ownerForWrite` 注释。
 */
import { getDb } from './db.js';
import { DEFAULT_ANSWER_STYLE, SETTING_KEY_ANSWER_STYLE, normalizeAnswerStyle } from '@sb/shared';
import type { AnswerStyle } from '@sb/shared';
import { ownerForWrite } from '../auth/ownership.js';

/** 读偏好；未配过 / 配置损坏 / 值非法都回退默认（数据容错，ADR-6） */
export function loadAnswerStyle(ownerId: string | null): AnswerStyle {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_ANSWER_STYLE) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_ANSWER_STYLE };
  try {
    return normalizeAnswerStyle(JSON.parse(row.value) as unknown);
  } catch {
    return { ...DEFAULT_ANSWER_STYLE };
  }
}

/** 键存在即为「配过」（哪怕存的正好是默认值） */
export function isAnswerStyleConfigured(ownerId: string | null): boolean {
  return (
    getDb()
      .prepare('SELECT 1 FROM app_settings WHERE owner_id = ? AND key = ?')
      .get(ownerForWrite(ownerId), SETTING_KEY_ANSWER_STYLE) !== undefined
  );
}

/** 存偏好；入参一律过归一化，库里永远是干净值。返回归一后的实际落库值 */
export function saveAnswerStyle(input: unknown, ownerId: string | null): AnswerStyle {
  const clean = normalizeAnswerStyle(input);
  getDb()
    .prepare(
      // ★ `ON CONFLICT` 的目标必须跟着主键一起改：主键已是 `(owner_id, key)`，
      //   仍写 `ON CONFLICT(key)` 会因「找不到匹配的唯一索引」在**运行时**报错（SQL 是字符串，
      //   编译期零信号）。这是 v30 迁移注释里列出的同型连带改动之一。
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_ANSWER_STYLE, JSON.stringify(clean));
  return clean;
}

/** 删键＝回到「没配过」：设置页「恢复默认」用，出题前的选项卡会重新问一次 */
export function resetAnswerStyle(ownerId: string | null): void {
  getDb()
    .prepare('DELETE FROM app_settings WHERE owner_id = ? AND key = ?')
    .run(ownerForWrite(ownerId), SETTING_KEY_ANSWER_STYLE);
}
