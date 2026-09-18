/**
 * learning/quiz-image — 出题配图（契约 docs/QUIZ-IMAGE-SPEC.md §2.2 / §2.3）。
 *
 * 2026-09-13 自 `quiz.ts` 原样搬出：那张文件已到 397/400 行，而本批要给 generateQuiz
 * 加联网参数——AGENTS.md 明文「再加任何逻辑前必须先开新文件」（`quiz-json-repair.ts` 即先例）。
 * 搬迁是**逐字搬运、零行为改动**：`quiz.ts` 仍以 re-export 转出这四个符号，
 * 所有既有调用方（routes.ts / quiz.test.ts / quiz-image.test.ts）的 import 路径一行都不用改。
 */
import { SETTING_KEY_QUIZ_IMAGE, DEFAULT_QUIZ_IMAGE } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

/** 库里只认真值 true/'true'，其余一律按关处理（数据容错，ADR-6） */
function normalizeImageFlag(input: unknown): boolean {
  return input === true || input === 'true';
}

// ★ M2d（2026-09-18，契约 TENANCY-SPEC §8.2）：`app_settings` 归主（v30，主键 `(owner_id, key)`）。
//   `ownerId` 一律必填（含读侧）——读侧漏传会读到**别人的**配图开关，
//   写侧漏传会写进无主行（用户自己读不回）。两者都不报错，只能靠类型挡。

/** 读设置；未配过/配置损坏都回退默认（与 loadQuizMix 同一套路） */
export function loadQuizImage(ownerId: string | null): boolean {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_QUIZ_IMAGE) as { value: string } | undefined;
  if (!row) return DEFAULT_QUIZ_IMAGE;
  try {
    return normalizeImageFlag(JSON.parse(row.value) as unknown);
  } catch {
    return DEFAULT_QUIZ_IMAGE;
  }
}

/** 存设置；落库前先归一化，库里永远是干净值 */
export function saveQuizImage(on: boolean, ownerId: string | null): boolean {
  const clean = normalizeImageFlag(on);
  getDb()
    .prepare(
      // ★ 冲突目标跟着主键改（v30）：仍写 `ON CONFLICT(key)` 会运行时 500。
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_QUIZ_IMAGE, JSON.stringify(clean));
  return clean;
}

/**
 * 配图指令（v1.1 重写，实测结论见契约 §2.7）。
 * flash 级模型只认「正面强制 + 留合法出口」：v1.0 那套「只有当…才画 / 文字说得清不要配图 /
 * 不要为凑数画图」的劝说式负面措辞等于送模型免费逃逸口——同一模型同一材料，改前 0 图、改后 2~3 图/组。
 */
export function buildImageInstruction(on: boolean): string {
  if (!on) return '本次出题不配图：所有题目的 svg 一律给空字符串 ""，一题也不要画。';
  return [
    '配图要求：凡题干涉及「如图、见图、图形、图像、结构、装置、几何体、光路、受力、电路、流程」的题目，必须给 svg 字段画出对应的示意图，不能只在文字里写「如图」却不给图；',
    '确实不需要示意图的题，svg 给空字符串 ""。每组最多 3 道题配图，其余一律留空——图越多输出越长，越容易撞到模型单次输出的长度上限而被截断。',
    `SVG 写法：属性一律用单引号，例如 <svg viewBox='0 0 120 90'><circle cx='60' cy='45' r='30' fill='none' stroke='#555'/></svg>；这样 SVG 里不出现双引号，不必在 JSON 字符串里做转义。`,
    'SVG 硬约束：根标记必须带 viewBox，宽度不超过 680；禁止 <image> 外链与 <script>；线条与文字不要用纯黑纯白（会按主题替换）；图形元素控制在 20 个以内。',
    'SVG 内容要求：图要把该题给出的条件与所求画明白，标注用 <text>，坐标自己算准——学习软件里一张对不上的错图比没图更坏。',
  ].join('');
}
