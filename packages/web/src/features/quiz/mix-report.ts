/**
 * mix-report — 出题配比的展示文案（纯函数：组件只管挂上去，规则留在这里才可测）。
 * 契约 QuizMixReport 由服务端给出，本文件只做「说人话」，不重新判定缺什么。
 */
import type { QuizMix, QuizMixReport } from '@sb/shared';
import { QUIZ_TYPES, QUIZ_TYPE_LABELS, mixTotal } from '@sb/shared';

/** 「单选题 2 · 填空题 1 · 解答题 1」；数量为 0 的档位不展示 */
export function mixSummary(mix: QuizMix): string {
  const parts = QUIZ_TYPES.filter((t) => mix[t] > 0).map((t) => `${QUIZ_TYPE_LABELS[t]} ${mix[t]}`);
  return parts.length > 0 ? parts.join(' · ') : '未选题型';
}

/** 出齐了返回 null；没出齐返回一句话（缺哪类、缺几道），UI 据此如实提示，绝不静默 */
export function shortfallText(report: QuizMixReport): string | null {
  if (report.matched) return null;
  const missing = QUIZ_TYPES.filter((t) => report.actual[t] < report.requested[t]);
  const detail = missing.map((t) => `${QUIZ_TYPE_LABELS[t]} ${report.requested[t] - report.actual[t]} 道`).join('、');
  return `模型只出了 ${mixTotal(report.actual)}/${mixTotal(report.requested)} 题（缺 ${detail}），可在设置页调整配比后重试`;
}
