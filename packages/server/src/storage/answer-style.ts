/**
 * storage/answer-style — 回答方式偏好的读写（契约 docs/ANSWER-STYLE-SPEC.md §2）。
 * 套路照 quiz.ts 的 loadQuizMix/saveQuizMix：读不到或 JSON 坏都回退默认，落库前先归一化。
 * ★ 额外回答「配过没有」：没配过 与 配成了恰好等于默认的值 在 AnswerStyle 上长得一样，
 *   而 L1 要不要弹选项卡全靠这个区分——只回 style 表达不了这件事。
 */
import { getDb } from './db.js';
import { DEFAULT_ANSWER_STYLE, SETTING_KEY_ANSWER_STYLE, normalizeAnswerStyle } from '@sb/shared';
import type { AnswerStyle } from '@sb/shared';

/** 读偏好；未配过 / 配置损坏 / 值非法都回退默认（数据容错，ADR-6） */
export function loadAnswerStyle(): AnswerStyle {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(SETTING_KEY_ANSWER_STYLE) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_ANSWER_STYLE };
  try {
    return normalizeAnswerStyle(JSON.parse(row.value) as unknown);
  } catch {
    return { ...DEFAULT_ANSWER_STYLE };
  }
}

/** 键存在即为「配过」（哪怕存的正好是默认值） */
export function isAnswerStyleConfigured(): boolean {
  return getDb()
    .prepare('SELECT 1 FROM app_settings WHERE key = ?')
    .get(SETTING_KEY_ANSWER_STYLE) !== undefined;
}

/** 存偏好；入参一律过归一化，库里永远是干净值。返回归一后的实际落库值 */
export function saveAnswerStyle(input: unknown): AnswerStyle {
  const clean = normalizeAnswerStyle(input);
  getDb()
    .prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(SETTING_KEY_ANSWER_STYLE, JSON.stringify(clean));
  return clean;
}

/** 删键＝回到「没配过」：设置页「恢复默认」用，出题前的选项卡会重新问一次 */
export function resetAnswerStyle(): void {
  getDb().prepare('DELETE FROM app_settings WHERE key = ?').run(SETTING_KEY_ANSWER_STYLE);
}
