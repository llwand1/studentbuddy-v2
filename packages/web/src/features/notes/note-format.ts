/**
 * 笔记详情的作答/答案展示格式化（纯函数，导出供单测——同 Markdown.tsx 约定，改签名先改单测）。
 * 服务端快照只存原始值（下标数组/文本），展示层的「A、B / 文本」口径收拢在这里。
 */
import type { QuizQuestion } from '@sb/shared';

/** 正确答案的展示文本：选择题型转字母，填空按空位拼接，解答给参考要点/完整解答 */
export function formatCorrectAnswer(q: QuizQuestion): string {
  const arr = Array.isArray(q.answer) ? q.answer : [];
  if (q.type === 'single' || q.type === 'multiple') {
    return arr.length ? arr.map((a) => String.fromCharCode(65 + Number(a))).join('、') : '—';
  }
  if (q.type === 'fill') return arr.length ? arr.map(String).join('；') : '—';
  return (typeof q.answer === 'string' && q.answer.trim()) || q.solution?.trim() || '—';
}

/** 我的作答的展示文本：无快照（essay / 老数据）如实说「未记录」，不装作有 */
export function formatMyAnswer(q: QuizQuestion, my: number[] | string | null): string {
  void q;
  if (my === null) return '（未记录作答）';
  if (Array.isArray(my)) return my.length ? my.map((a) => String.fromCharCode(65 + Number(a))).join('、') : '—';
  return my.trim() || '—';
}
