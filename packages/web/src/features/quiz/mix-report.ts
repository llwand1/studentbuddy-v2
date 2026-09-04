/**
 * mix-report — 出题配比的展示文案（纯函数：组件只管挂上去，规则留在这里才可测）。
 * 契约 QuizMixReport 由服务端给出，本文件只做「说人话」，不重新判定缺什么。
 */
import type { QuizMix, QuizMixReport, QuizImageReport } from '@sb/shared';
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

/**
 * 配图情况文案（v1.1，契约 §2.4）：开关开着却没图 / 图画坏了被丢 / 撞顶截断，都得说出来，不静默。
 * 返 null = 没什么要播报的（正常出图，或开关本来就关着——那不是损失）。
 * 同 shortfallText：判定全在服务端 report，本函数只负责说人话。
 */
export function imageNote(report?: QuizImageReport | null): string | null {
  if (!report || !report.on) return null;
  const parts: string[] = [];
  if (report.truncated) parts.push('模型输出没写完（多半是撞到长度上限），尾部不完整的题已丢弃，结果题数可能少于配比');
  if (report.droppedSvg > 0) parts.push(`${report.droppedSvg} 张图画得不完整或不合规，已只丢图保题`);
  if (report.delivered === 0 && parts.length === 0) parts.push('本次模型一题也没配图（它认为这些题不需要示意图，可重试或把题干写得更图形化）');
  return parts.length > 0 ? `配图：${parts.join('；')}。` : null;
}
