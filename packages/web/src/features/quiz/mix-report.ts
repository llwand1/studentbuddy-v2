/**
 * mix-report — 出题配比的展示文案（纯函数：组件只管挂上去，规则留在这里才可测）。
 * 契约 QuizMixReport 由服务端给出，本文件只做「说人话」，不重新判定缺什么。
 */
import type { QuizMix, QuizMixReport, QuizImageReport, QuizSearchReport, QuizRef } from '@sb/shared';
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

/**
 * 联网情况文案（契约 docs/QUIZ-SEARCH-SPEC.md §2.7）：参考了几条、哪几家、一条也没取到，都要说出来。
 * 返 null = 没什么要播报的（本次本来就没联网——那不是损失，跟配图开关关着同理）。
 * 同 imageNote：判定全在服务端 report，本函数只负责说人话。
 */
export function searchNote(report?: QuizSearchReport | null): string | null {
  if (!report || !report.on) return null;
  if (report.count > 0) {
    const from = report.providers.filter((p) => p !== 'cache');
    return from.length > 0
      ? `联网：参考了 ${report.count} 条资料（来源 ${from.join('、')}）。`
      : `联网：参考了 ${report.count} 条资料（本次命中缓存）。`;
  }
  if (report.failed.length > 0) return `联网：这次没取到参考（${report.failed[0]}），题目基于模型自身知识出的。`;
  return '联网：没搜到可用参考，题目基于模型自身知识出的。';
}

/**
 * 本次参考来源清单（契约 docs/QUIZ-SEARCH-SPEC.md §2.8）：有命中才返非空，供页面渲染可点击来源区。
 * 与 `searchNote` 的分工：**有来源清单时由清单承担告知（可展开、可点），searchNote 只兜「没取到」**——
 * 两句话同时出现会说两遍同件事，故页面层二选一（见 QuizBankPage/ChatView 的 filter 处）。
 * URL 由服务端映射，本函数不校验、不补全，只做透传（前端不发明来源）。
 */
export function refsList(report?: QuizSearchReport | null): QuizRef[] {
  if (!report || !report.on) return [];
  return report.refs ?? [];
}
