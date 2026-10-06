import { it, expect } from 'vitest';
import { wantsExamScopeChange, examScopeToolChoice } from './exam-scope-action.js';
import { buildOpening } from './opening.js';
const text = '请添加一个自填域名并移除旧域名，保留其它白名单';
const opening = buildOpening({ grill: false, online: false });
const read = [{ calls: [{ id: 'r', name: 'read_exam_scope', arguments: '{}' }], results: [{ role: 'tool' as const, toolCallId: 'r', content: '{"on":false,"scope":{"packs":[],"custom":[]}}' }] }];
it('明确修改意图先读、下一轮强绑提交计划，不能只说稍后会改', () => {
  expect(examScopeToolChoice(text, 0, opening, [])).toEqual({ type: 'function', name: 'read_exam_scope' });
  expect(examScopeToolChoice(text, 1, opening, read)).toEqual({ type: 'function', name: 'update_exam_scope' });
});
it('既有 grill/联网开场优先，开场过后才读配置', () => {
  const grill = buildOpening({ grill: true, online: true });
  expect(examScopeToolChoice(text, 0, grill, [])).toEqual({ type: 'function', name: 'ask_choice' });
  expect(examScopeToolChoice(text, 1, grill, [])).toEqual({ type: 'function', name: 'read_exam_scope' });
});
it('只查看、步骤咨询、明确不改不强绑写；失败读取和已尝试计划不强绑重试', () => {
  for (const q of ['查看白名单', '怎么修改白名单', '不要修改白名单', '讲讲线性代数']) expect(wantsExamScopeChange(q)).toBe(false);
  expect(examScopeToolChoice('查看白名单', 1, opening, read)).toBeUndefined();
  expect(examScopeToolChoice(text, 1, opening, [{ ...read[0]!, results: [] }])).toBeUndefined();
  expect(examScopeToolChoice(text, 2, opening, [...read, { calls: [{ id: 'w', name: 'update_exam_scope', arguments: '{}' }], results: [] }])).toBeUndefined();
});
it('参数错误最多纠正一次；用户拒绝不能触发重试', () => {
  const bad = { calls: [{ id: 'w', name: 'update_exam_scope', arguments: '{}' }], results: [{ role: 'tool' as const, toolCallId: 'w', content: '白名单未修改：参数冲突' }] };
  expect(examScopeToolChoice(text, 2, opening, [...read, bad])).toEqual({ type: 'function', name: 'update_exam_scope' });
  expect(examScopeToolChoice(text, 3, opening, [...read, bad, bad])).toBeUndefined();
  expect(examScopeToolChoice(text, 2, opening, [...read, { ...bad, results: [{ ...bad.results[0]!, content: '用户拒绝了本次修改' }] }])).toBeUndefined();
});
