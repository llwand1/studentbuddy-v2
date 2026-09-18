/**
 * collect-view — 搜集面板呈现层纯函数（契约 RESOURCE-SPEC §3.7；weak-report/mix-report 同族：
 * 判定层放纯函数才测得到，组件只接线）。
 */
import type { QuizQuestion, CollectCandidate, CollectReport } from '@sb/shared';

/**
 * 一句全程报告：搜集词 / 检索源 / 逐源失败 / 抓页 n/m / 摘录几题拒几题，缺一层说一层（ADR-5）。
 * 空报告（还没跑过）返回空串，组件据此不渲染。
 */
export function collectNote(report: CollectReport | null): string {
  if (!report || report.queries.length === 0) return '';
  const parts = [`搜集词：${report.queries.join(' / ')}`];
  parts.push(report.providers.length > 0 ? `来源：${report.providers.join('、')}` : '来源：无');
  if (report.failed.length > 0) parts.push(`失败：${report.failed.join('；')}`);
  const okPages = report.pages.filter((p) => p.fetched).length;
  parts.push(`抓页 ${okPages}/${report.pages.length}`);
  parts.push(`摘录 ${report.total} 题（可用 ${report.accepted}、拒绝 ${report.rejected}）`);
  return parts.join('｜');
}

/**
 * 提交集 = 「机验通过 且 人勾选」两门的交集（契约 §3.5：预览机验 + 入库人验，缺一不可）。
 * ok=false 的草稿永远不提交——即使调用方把勾全打上。
 */
export function commitSelection(candidates: CollectCandidate[], checked: boolean[]): QuizQuestion[] {
  return candidates.filter((c, i) => c.ok && checked[i]).map((c) => c.question);
}
