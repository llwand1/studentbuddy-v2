/**
 * weak-report — 薄弱点分析的展示文案纯函数（照 `mix-report.ts` 先例）。
 *
 * 为什么抽出来：判定逻辑留在组件里就测不到——本仓 `.tsx` 无测试环境
 * （无 jsdom / testing-library，见 `docs/dev/test-plan.md` §1），
 * 而「降级时到底有没有如实标注」这件事写错**不报错、只是骗用户**，正是最该上仪器的一类。
 *
 * 契约 `docs/QUIZ-WEAK-SPEC.md` §6。
 */
import type { WeakAnalysis, WeakFailure } from '@sb/shared';

/**
 * 降级真因 → 一句人话。★ 每条都必须点明「这是本地规则版」——
 * 把降级结果冒充成 AI 分析，用户就不会去设置页绑模型，等于让他永远调不到点子上（ADR-5）。
 */
const FALLBACK_TEXT: Record<WeakFailure, string> = {
  'no-model': '未配置「薄弱点分析」模型，以上为本地规则版（正确率低于 60% 的题）。到设置页给它绑一个模型，即可获得逐题 AI 分析。',
  'call-failed': '模型调用失败，以上为本地规则版。可稍后重试。',
  parse: '模型输出没能解析成结构，以上为本地规则版。可稍后重试。',
};

/** 一条薄弱点的展示形态（组件直接渲染，不再自己拼字符串） */
export interface WeakPointView {
  topic: string;
  /** 「第 1、3 题」 */
  indexes: string;
  reason: string;
  suggestion: string;
}

export interface WeakView {
  points: WeakPointView[];
  /** 顶部口径行（非降级且有内容时给「AI 分析（基于 N 道错题）」）；否则 null */
  headNote: string | null;
  /** 空态提示；有内容时为 null */
  emptyNote: string | null;
  /** 降级提示；不降级时为 null */
  fallbackNote: string | null;
}

/** 题号 0 基 → 「第 1、3 题」（用户看到的是 1 基） */
export function indexText(indexes: number[]): string {
  return indexes.length ? `第 ${indexes.map((i) => i + 1).join('、')} 题` : '';
}

/**
 * 把一次分析结果翻成渲染模型。
 *
 * 空态与降级是两件事，文案必须分开（契约 §2.1）：`analyzed === 0` 是「还没做题」，
 * 而 `fallback === true` 是「真出了错题但模型没接上」。混成一句就会出现
 * 「模型没配」被说成「你还没做题」，用户照着去刷题、刷完还是那句。
 */
export function weakView(a: WeakAnalysis): WeakView {
  const points = a.weak.map((w) => ({
    topic: w.topic,
    indexes: indexText(w.questionIndexes),
    reason: w.reason,
    suggestion: w.suggestion,
  }));
  const hasPoints = a.weak.length > 0;
  return {
    points,
    headNote: !a.fallback && hasPoints ? `AI 分析（基于 ${a.analyzed} 道错题）` : null,
    emptyNote: hasPoints ? null : a.analyzed === 0 ? '暂无薄弱点（先做题）' : '本次没能分析出薄弱点（错题已记录，可稍后重试）',
    fallbackNote: a.fallback && a.failure ? FALLBACK_TEXT[a.failure] : null,
  };
}
