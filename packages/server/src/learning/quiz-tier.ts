/**
 * learning/quiz-tier — 出题分级的**服务端落点**（契约 `docs/QUIZ-TIER-SPEC.md` §2/§4）。
 *
 * 两件事：
 *   ① `buildTierInstruction`：AI 出题提示词里按「有没有联网参考」告诉模型这套题该长什么样——
 *      没参考 ⇒ **基础题**（考概念是否掌握，不要模仿考卷腔、不要编「某年某地真题」字样）；
 *      有参考 ⇒ **模拟题**（照参考资料里真题的考法与难度出变式，refs 如实填）。
 *      模型自己对考点分布的想象不可信，与其让它「装真题」，不如明说这是基础题、把功利效果留给真题档。
 *   ② `fillTiers`：出题结果落 `tier`——**按来源事实**推（collect → real、web → simulated、其余 → basic），
 *      模型输出里若带 `tier` 键一律覆盖（自报不算数）。
 *   ③ `realFirstQuota` / `mergeRealFirst`：真题优先合流的纯算法（`quiz-blend.ts` 调）——
 *      用户没配真题时，拿 AI 配比当搜集配额；摘到几道真题就顶替几道同题型 AI 题，AI 题削尾。
 *
 * 为什么单开文件：`quiz.ts` 373/400 行、`quiz-blend.ts` 承担编排不承担算法，且 ③ 要能零 IO 单测。
 */
import type { QuizMix, QuizMixKind, QuizPayload, QuizQuestion, QuizSourceMix, QuizTier } from '@sb/shared';
import { MAX_QUIZ_REAL_PER_TYPE, MIX_KINDS, SETTING_KEY_QUIZ_REAL_FIRST, normalizeQuizRealFirst, tierOf } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';

/** 提示词段：告诉模型本套 AI 题的档位与写法（`hasRefs` ＝ 本次有联网参考段） */
export function buildTierInstruction(hasRefs: boolean): string {
  if (hasRefs) {
    return (
      '题目定位：**模拟题**。以下方互联网参考资料里出现的真题/例题为范本，按同样的考法、题型与难度出**变式题**' +
      '（换数据、换情境、换问法，不要原样照抄）；参考到哪条就在 refs 里填哪条编号。不要在题干里写「某年某地真题」之类的出处字样。'
    );
  }
  return (
    '题目定位：**基础题**。没有联网参考资料时不要模仿考卷腔、不要杜撰「某年某地真题」字样；' +
    '出针对材料核心概念的基础巩固题：一道题只考一个明确的知识点，题干短、选项区分度清晰、解析点到概念本身。'
  );
}

/** 按来源事实落 tier（覆盖模型自报）。纯函数，返回新对象。 */
export function fillTiers(quiz: QuizPayload): QuizPayload {
  return {
    ...quiz,
    questions: quiz.questions.map((raw) => {
      const { tier: _self, ...q } = raw as QuizQuestion & { tier?: unknown };
      const tier: QuizTier = tierOf({ source: q.source });
      return { ...q, tier };
    }),
  };
}

// ── 真题优先开关（app_settings，owner 归主） ──

export function loadQuizRealFirst(ownerId: string | null): boolean {
  const row = getDb()
    .prepare('SELECT value FROM app_settings WHERE owner_id = ? AND key = ?')
    .get(ownerForWrite(ownerId), SETTING_KEY_QUIZ_REAL_FIRST) as { value: string } | undefined;
  if (!row) return normalizeQuizRealFirst(undefined);
  try {
    return normalizeQuizRealFirst(JSON.parse(row.value) as unknown);
  } catch {
    return normalizeQuizRealFirst(row.value);
  }
}

export function saveQuizRealFirst(value: unknown, ownerId: string | null): boolean {
  const clean = normalizeQuizRealFirst(value);
  getDb()
    .prepare(
      `INSERT INTO app_settings (owner_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value`,
    )
    .run(ownerForWrite(ownerId), SETTING_KEY_QUIZ_REAL_FIRST, JSON.stringify(clean));
  return clean;
}

// ── 真题优先：配额与顶替 ──

/**
 * 真题优先的搜集配额：**每题型 = AI 配比**（封顶 `MAX_QUIZ_REAL_PER_TYPE`），scenario 恒 0。
 * 含义是「这几道题里能换成真题的都换」，不额外增加总题数。
 */
export function realFirstQuota(aiMix: QuizMix): QuizSourceMix {
  const q = { single: 0, multiple: 0, fill: 0, essay: 0, judge: 0, scenario: 0 } as QuizSourceMix;
  for (const t of MIX_KINDS) {
    if (t === 'scenario') continue;
    q[t] = Math.min(MAX_QUIZ_REAL_PER_TYPE, Math.max(0, Math.trunc(aiMix[t] ?? 0)));
  }
  return q;
}

/**
 * 顶替合并：同题型每来一道真题，就从 AI 题里**从后往前**削一道（模型通常把把握大的题放前面）。
 * 真题在前、AI 题在后；总题数 ≤ AI 配比总数。返回被顶替掉的 AI 题数，供报告。
 */
export function mergeRealFirst(
  aiQuestions: QuizQuestion[],
  realQuestions: QuizQuestion[],
): { questions: QuizQuestion[]; displaced: number } {
  const need = new Map<QuizMixKind, number>();
  for (const r of realQuestions) need.set(r.type, (need.get(r.type) ?? 0) + 1);
  const kept: QuizQuestion[] = [];
  let displaced = 0;
  for (let i = aiQuestions.length - 1; i >= 0; i -= 1) {
    const q = aiQuestions[i]!;
    const n = need.get(q.type) ?? 0;
    if (n > 0) {
      need.set(q.type, n - 1);
      displaced += 1;
      continue;
    }
    kept.unshift(q);
  }
  return { questions: [...realQuestions, ...kept], displaced };
}
