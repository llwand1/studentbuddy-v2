/**
 * learning/quiz-source-mix — 出题**来源**配比（真题道数）的读写（契约 `docs/QUIZ-BLEND-SPEC.md` §3.1）。
 *
 * ★ 为什么单开文件而不并进 `learning/quiz.ts`：后者本契约落地时实测 **375/400 行**、只剩 25 行，
 *   按 AGENTS.md「再加任何逻辑前必须先开新文件」处理（同 `quiz-image.ts` / `quiz-search.ts` /
 *   `quiz-weak.ts` / `quiz-record.ts` 四次先例）。
 * ★ 归属口径与 `loadQuizMix`/`saveQuizMix` **逐字同源**（`app_settings(owner_id, key)`，M2d v30 归主）：
 *   漏传 `ownerId` 会让 A 读到/改到 B 的配比，而**两种都不会让任何测试变红**——只能靠类型与这句注释挡。
 */
import type { QuizMix, QuizSourceMix } from '@sb/shared';
import {
  DEFAULT_QUIZ_SOURCE_MIX,
  SETTING_KEY_QUIZ_SOURCE_MIX,
  normalizeQuizSourceMix,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

/** 读侧做形状归一时的「AI 侧全 0」占位：只钳单档，不做总量削（理由见下） */
const ZERO_AI_MIX: QuizMix = { single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 };

/**
 * 读设置；未配过/配置损坏都回退 `DEFAULT_QUIZ_SOURCE_MIX`（**全 0＝不出真题**，数据容错 ADR-6）。
 * ★ 这里「回退全 0」与 `loadQuizMix` 回退默认配比是两件事：没配过真题＝用户不要真题，是**最常见配置**。
 *
 * ★ 读出**刻意不做总量联合钳位**（只做单档形状归一）：写侧与本仓两侧编辑态都已钳过，
 *   正常不存在超配状态；读侧若再按当前 AI 配比削一遍，就会出现「用户改了 AI 配比，
 *   另一张卡上的真题数被**静默改小**」——那是本仓最反感的一类「UI 骗人」。
 */
export function loadQuizSourceMix(ownerId: string | null): QuizSourceMix {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_QUIZ_SOURCE_MIX) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_QUIZ_SOURCE_MIX };
  try {
    return normalizeQuizSourceMix(JSON.parse(row.value) as unknown, ZERO_AI_MIX);
  } catch {
    return { ...DEFAULT_QUIZ_SOURCE_MIX };
  }
}

/**
 * 存设置；落库前先按**当前 AI 配比**归一化（联合钳位，契约 §3.2），库里永远是干净且可执行的值。
 * `aiMix` 必填：真题能配多少道，取决于 AI 侧已占掉多少额度——不传就没法收口。
 */
export function saveQuizSourceMix(mix: unknown, aiMix: QuizMix, ownerId: string | null): QuizSourceMix {
  const clean = normalizeQuizSourceMix(mix, aiMix);
  getDb()
    .prepare(
      // ★ 冲突目标与 `saveQuizMix` 同源：v30 起 `app_settings` 主键是 `(owner_id, key)`
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_QUIZ_SOURCE_MIX, JSON.stringify(clean));
  return clean;
}
