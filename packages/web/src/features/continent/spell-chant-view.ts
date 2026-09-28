/**
 * features/continent/spell-chant-view — 魔法吟唱的**视图模型**（纯函数，无 DOM / 无请求）。
 *
 * ★ 为什么单拆一层（同 `continent-view.ts`）：「一段历史对话怎么变成几节咒语、共不共鸣」必须能脱离组件单测。
 * ★ 本文件**不重算任何口径**：历史行 → 消息流借对话页那一份 `foldToolRounds`（题卡由它从 `[QUIZ]` 登记行还原），
 *   切节 / 相似度 / 威力全走 `shared/spell-chant.ts`。这里只做「拼装 + 文案」。
 */
import {
  SPELL_MAX_VERSES,
  buildChantVerses,
  spellResonates,
  type ChantTurn,
  type ChantVerse,
} from '@sb/shared';
import { foldToolRounds, type HistoryRow } from '../chat/history-fold';
import { parseMsgDate } from '../chat/chat-meta';

/** 一本选好的咒语：节 + 截断数 + 是否与这块地共鸣 */
export interface SpellPlan {
  verses: ChantVerse[];
  truncated: number;
  resonant: boolean;
}

/** 历史行 → 吟唱输入（题卡取 `quizBlock.quiz.questions`；情景题卡不进吟唱，见契约 §5） */
export function turnsFromHistory(rows: readonly HistoryRow[]): ChantTurn[] {
  return foldToolRounds([...rows]).map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.quizBlock ? { quiz: m.quizBlock.quiz.questions, quizTitle: m.quizBlock.quiz.title } : {}),
  }));
}

/** 历史行 + 这块地的词条名 → 咒语（★ 共鸣按**全部**消息正文判，不只看进了节的那几条） */
export function planSpell(rows: readonly HistoryRow[], term: string): SpellPlan {
  const turns = turnsFromHistory(rows);
  const { verses, truncated } = buildChantVerses(turns);
  const texts = turns.map((t) => `${t.content}\n${(t.quiz ?? []).map((q) => q.question).join('\n')}`);
  return { verses, truncated, resonant: spellResonates(texts, term) };
}

/** 咒语书里一本的副标题：更新时间（SQLite UTC 串 → 本地「M月D日 HH:mm」，解析不出时为空） */
export function spellTimeText(updatedAt: string, now: Date = new Date()): string {
  const d = parseMsgDate(updatedAt);
  if (!d) return '';
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 一节的标题（吟唱框顶部） */
export function verseTitle(v: ChantVerse, index: number): string {
  return v.kind === 'recall' ? `第 ${index + 1} 节 · 复述当初的提问` : `第 ${index + 1} 节 · 重做当初的题`;
}

/** 截断提示（0 = 不提示） */
export function truncatedText(truncated: number): string | null {
  return truncated > 0 ? `咒语太长，只吟唱前 ${SPELL_MAX_VERSES} 节（另有 ${truncated} 节没进来）。` : null;
}

/** 释放后的结算文案（弹窗里念给用户听；数字由 shared 算，这里只组句） */
export function castText(damage: number, power: number, total: number, resonant: boolean): string {
  if (damage <= 0) return `咒语哑火了——${total} 节里一节都没能共鸣，这只怪没掉血。`;
  const base = `${total} 节里命中 ${power} 节`;
  return resonant ? `${base}，咒语与这块地共鸣，威力加倍：造成 ${damage} 点伤害！` : `${base}：造成 ${damage} 点伤害。`;
}
