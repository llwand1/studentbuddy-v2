/** GrillMe 的会话学习目标；来源白名单仍由服务端按账号读取。 */
export type GrillScope = { kind: 'conversation' | 'exam' | 'custom'; topic?: string };
export const GRILL_TOPIC_MAX = 160;
export function normalizeGrillScope(value: unknown): GrillScope | null {
  if (value === undefined) return { kind: 'conversation' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'conversation' || v.kind === 'exam') return { kind: v.kind };
  if (v.kind !== 'custom' || typeof v.topic !== 'string') return null;
  const topic = v.topic.trim();
  return topic && topic.length <= GRILL_TOPIC_MAX ? { kind: 'custom', topic } : null;
}
