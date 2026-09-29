/**
 * 出题**分级**（契约 `docs/QUIZ-TIER-SPEC.md`）——回答用户做题前最关心的一句话：**这道题做了有什么用？**
 *
 * 三档，按「功利效果」从高到低：
 *   · `real`  真题·必刷      ——从公开网页**逐字摘录**、经 verbatim 锚点锁与来源回填的题（`source.kind === 'collect'`）。
 *   · `mock`  模拟题·建议做  ——AI 参考了联网检索到的真题/资料出的**变式题**（`source.kind === 'web'`）。
 *   · `basic` 基础题·可选做  ——AI 只凭材料/主题按自己的理解出的题；出题提示词把它压成**基础题**，
 *                              不装模拟题（模型对考点分布的想象不可信，装得越像误导越大）。
 *
 * ★ 档位**由服务端按来源事实推导**，不是模型自报：模型说「这是真题」不算数，只有过了 verbatim 锁的题才配叫真题。
 *   前端念 `tierOf(q)` 而不是直接读 `q.tier`——历史题没有这个键，`tierOf` 会按 `source.kind` 兜底推导，
 *   不做数据迁移（与 `svg` / `photo` 可选字段同一口径）。
 * ★ `tier` 是纯加法字段：判分、对战、复习链路一律不读它，只影响题卡上那枚徽标与排序。
 */
import type { QuizQuestion } from './content-blocks.js';

export type QuizTier = 'real' | 'mock' | 'basic';

/** 排序序＝推荐做题序：真题 → 模拟 → 基础（`compareTier` 用；配比裁剪不看它） */
export const QUIZ_TIERS: readonly QuizTier[] = ['real', 'mock', 'basic'];

/** 徽标文案（前端直接念，不自己拼） */
export const QUIZ_TIER_LABELS: Record<QuizTier, string> = {
  real: '真题·必刷',
  mock: '模拟题·建议做',
  basic: '基础题·可选做',
};

/** 徽标悬停一句话：告诉用户「为什么这么标」——标签要能被追问 */
export const QUIZ_TIER_HINTS: Record<QuizTier, string> = {
  real: '从公开题源页逐字摘录、题干经原文比对；来源链接在解析里',
  mock: 'AI 参考联网检索到的资料出的变式题，考法接近但不是原题',
  basic: 'AI 按材料自行出的基础巩固题，用来检查概念是否掌握，不代表考试题型',
};

/**
 * 从来源事实推导档位（唯一推导口径）。显式 `tier` 优先——服务端已判过就不重判；
 * 否则 `collect` → real、`web` → mock、其余（含无 source 的历史题）→ basic。
 */
export function tierOf(q: Pick<QuizQuestion, 'tier' | 'source'>): QuizTier {
  if (q.tier === 'real' || q.tier === 'mock' || q.tier === 'basic') return q.tier;
  const kind = q.source?.kind;
  if (kind === 'collect') return 'real';
  if (kind === 'web') return 'mock';
  return 'basic';
}

/** 排序比较器：档位序优先，同档保持原顺序（调用方用稳定排序即可） */
export function compareTier(a: Pick<QuizQuestion, 'tier' | 'source'>, b: Pick<QuizQuestion, 'tier' | 'source'>): number {
  return QUIZ_TIERS.indexOf(tierOf(a)) - QUIZ_TIERS.indexOf(tierOf(b));
}

/** 逐档计数（工具回灌摘要与题卡头部用） */
export function countTiers(questions: readonly Pick<QuizQuestion, 'tier' | 'source'>[]): Record<QuizTier, number> {
  const out: Record<QuizTier, number> = { real: 0, mock: 0, basic: 0 };
  for (const q of questions) out[tierOf(q)] += 1;
  return out;
}

/** 题卡头部一句话：`真题 2 · 模拟 1 · 基础 3`；全 0 返回空串 */
export function tierSummaryLine(counts: Record<QuizTier, number>): string {
  const short: Record<QuizTier, string> = { real: '真题', mock: '模拟', basic: '基础' };
  const parts = QUIZ_TIERS.filter((t) => counts[t] > 0).map((t) => `${short[t]} ${counts[t]}`);
  return parts.join(' · ');
}

// ── 真题优先开关（契约 §4）──

/** 落 app_settings 的键名（与 quiz_mix / quiz_source_mix 并列） */
export const SETTING_KEY_QUIZ_REAL_FIRST = 'quiz_real_first';

/**
 * 缺省 **开**：用户没配真题配比时，出题也先去公开题源摘真题，摘到几道就顶替几道 AI 题。
 * 关掉 ⇒ 完全回到「只按配比出题」的旧行为。
 */
export const DEFAULT_QUIZ_REAL_FIRST = true;

export function normalizeQuizRealFirst(input: unknown): boolean {
  if (typeof input === 'boolean') return input;
  if (input === 'true' || input === 1 || input === '1') return true;
  if (input === 'false' || input === 0 || input === '0') return false;
  return DEFAULT_QUIZ_REAL_FIRST;
}
