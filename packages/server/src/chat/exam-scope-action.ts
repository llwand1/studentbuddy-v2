/** 明确要求改范围时保证读→提交计划；保存仍由已有确认门决定。 */
import type { ChatMessage, ChatRequest, ToolCall } from '../llm/types.js';
import type { Opening } from './opening.js';
type Round = { calls: ToolCall[]; results: ChatMessage[] };
export function wantsExamScopeChange(text: string): boolean {
  if (/不要(?:再)?(?:修改|调整|添加|删除)|不修改|别(?:修改|调整)|(?:怎么|如何)(?:修改|调整|添加|删除)/.test(text)) return false;
  return /白名单|应试(?:模式|范围)|考试(?:范围|类目)|题源|自填(?:域名|站点)/.test(text)
    && /添加|新增|加(?:入|上|一个|个)|移除|删除|去掉|调整|修改|替换|清空|开启|打开|关闭|关掉|启用|停用|只(?:保留|用)|改(?:成|为)/.test(text);
}
export function examScopeToolChoice(text: string, turn: number, opening: Opening, rounds: Round[]): ChatRequest['toolChoice'] {
  if (turn === 0 && opening.toolChoice) return opening.toolChoice;
  if (!wantsExamScopeChange(text)) return undefined;
  const calls = rounds.flatMap(r => r.calls);
  // 仅非法参数允许一次纠正；拒绝、取消、无变化与配置竞争均不重复弹批准卡。
  const writes = calls.filter(c => c.name === 'update_exam_scope');
  if (writes.length) {
    const last = writes.at(-1)!;
    const result = rounds.flatMap(r => r.results).find(r => r.toolCallId === last.id);
    return writes.length === 1 && typeof result?.content === 'string' && result.content.startsWith('白名单未修改：')
      ? { type: 'function', name: 'update_exam_scope' } : undefined;
  }
  const read = calls.find(c => c.name === 'read_exam_scope');
  if (!read) return { type: 'function', name: 'read_exam_scope' };
  const result = rounds.flatMap(r => r.results).find(r => r.toolCallId === read.id);
  try {
    const value = JSON.parse(typeof result?.content === 'string' ? result.content : '') as { on?: unknown; scope?: { packs?: unknown; custom?: unknown } };
    if (typeof value.on !== 'boolean' || !Array.isArray(value.scope?.packs) || !Array.isArray(value.scope?.custom)) return undefined;
  } catch { return undefined; }
  return { type: 'function', name: 'update_exam_scope' };
}
