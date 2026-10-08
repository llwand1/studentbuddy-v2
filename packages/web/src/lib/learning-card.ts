/** Markdown 引用卡的显式类型；不从普通段落猜测，不改变原文。 */
export const LEARNING_CARDS = {
  CORE: { label: '核心结论', mark: '◆' },
  ROUTE: { label: '求解路线', mark: '↳' },
  STEP: { label: '推理步骤', mark: '▸' },
  EXAMPLE: { label: '具体例子', mark: '+' },
  PITFALL: { label: '易错提醒', mark: '!' },
  CHECK: { label: '结果与验算', mark: '✓' },
} as const;

export type LearningCardKind = keyof typeof LEARNING_CARDS;

export function learningCardHeader(line: string): { variant: LearningCardKind; title: string } | null {
  const m = /^\[!([A-Z]+)\](?:\s+(.*))?\s*$/i.exec(line.trim());
  const key = m?.[1]?.toUpperCase();
  if (!key || !Object.prototype.hasOwnProperty.call(LEARNING_CARDS, key)) return null;
  const variant = key as LearningCardKind;
  return { variant, title: m?.[2]?.trim() || LEARNING_CARDS[variant].label };
}
