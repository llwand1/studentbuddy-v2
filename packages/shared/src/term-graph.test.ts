/**
 * term-graph — 关系输出校验与中文说法。
 */
import { describe, it, expect } from 'vitest';
import { parseRelations, relationLabel } from './term-graph.js';

const names = new Set(['光反应', '暗反应', '叶绿体', '光合作用']);

describe('parseRelations', () => {
  it('合法边收下，note 截断', () => {
    expect(parseRelations('{"edges":[{"a":"光反应","b":"暗反应","relation":"prerequisite","note":"提供 ATP"}]}', names)).toEqual([
      { a: '光反应', b: '暗反应', relation: 'prerequisite', note: '提供 ATP' },
    ]);
  });
  it('★ 丢掉：名字不在集合里（模型改写过的）、自环、未知关系', () => {
    const raw = JSON.stringify({ edges: [
      { a: '光反应阶段', b: '暗反应', relation: 'related' },
      { a: '叶绿体', b: '叶绿体', relation: 'related' },
      { a: '叶绿体', b: '光合作用', relation: 'causes' },
      { a: ' 叶绿体 ', b: '光合作用', relation: 'part_of' },
    ] });
    expect(parseRelations(raw, names)?.map((e) => e.a)).toEqual(['叶绿体']);
  });
  it('★ 无向边正反两条只留一条；有向边正反都留', () => {
    const raw = JSON.stringify({ edges: [
      { a: '光反应', b: '暗反应', relation: 'contrast' },
      { a: '暗反应', b: '光反应', relation: 'contrast' },
      { a: '光反应', b: '暗反应', relation: 'prerequisite' },
      { a: '暗反应', b: '光反应', relation: 'prerequisite' },
    ] });
    expect(parseRelations(raw, names)).toHaveLength(3);
  });
  it('不成形 ⇒ null；空 edges ⇒ []；上限', () => {
    expect(parseRelations('没有', names)).toBeNull();
    expect(parseRelations('{"edges":"x"}', names)).toBeNull();
    expect(parseRelations('{"edges":[]}', names)).toEqual([]);
    const raw = JSON.stringify({ edges: [{ a: '光反应', b: '暗反应', relation: 'related' }, { a: '叶绿体', b: '光合作用', relation: 'part_of' }] });
    expect(parseRelations(raw, names, 1)).toHaveLength(1);
  });
});

describe('relationLabel', () => {
  it('有向关系两端说法不同，无向相同', () => {
    expect(relationLabel('prerequisite', true)).toBe('是它的前置');
    expect(relationLabel('prerequisite', false)).toBe('需要先懂');
    expect(relationLabel('part_of', false)).toBe('包含');
    expect(relationLabel('contrast', true)).toBe(relationLabel('contrast', false));
  });
});
