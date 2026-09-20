/**
 * bank-view — 题库列表行的展示纯函数（先例 scenario-view.ts / collect-view.ts：.tsx 无测试环境，判定外移才可测）。
 * 契约 docs/QUIZ-BLEND-SPEC.md §3.5：题库徽标由三分扩为**四分**——AI / 情景 / 搜集 / 混合（source='blend'）。
 */
import type { QuizMix, QuizSourceMix } from '@sb/shared';
import { SCENARIO_SOURCE } from '@sb/shared';
import { mixSummary } from './mix-report';

/** `quiz_bank.source` 登记值 → 中文徽标；未知值返 null（不渲染、不猜——历史值与新值都从服务端来） */
export function bankBadge(source: string): string | null {
  switch (source) {
    case 'ai':
      return 'AI';
    case SCENARIO_SOURCE:
      return '情景';
    case 'collect':
      return '搜集';
    case 'blend':
      return '混合';
    default:
      return null;
  }
}

/**
 * 出题配比摘要一行（题库页/对话页共用）：AI 侧摘要照旧；真题配了就并进同一行并预告「会慢」
 * （契约 §8.3：collect 首版同步无进度条，提示必须如实）。
 */
export function mixTipText(ai: QuizMix, real: QuizSourceMix): string {
  const realTotal = real.single + real.multiple + real.fill + real.essay + real.scenario;
  return realTotal > 0 ? `${mixSummary(ai)}（真题 ${realTotal} 题；含现场搜集，出题可能更久）` : mixSummary(ai);
}
