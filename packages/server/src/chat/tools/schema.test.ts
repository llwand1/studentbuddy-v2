/**
 * chat/tools/schema —— 参数预闸回归（契约 §4.2 纠错口径 / §4.5）。
 * 纯函数零依赖：不触 DB、不跑工具，测的是「拦下来的样子」与「放行的边界」。
 */
import { describe, expect, it } from 'vitest';
import { validateToolArgs } from './schema.js';

const MANAGE = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add', 'update', 'delete'] },
    term: { type: 'string' },
    terms: { type: 'array', items: { type: 'string' } },
    definition: { type: 'string' },
    importance: { type: 'number' },
  },
  required: ['action'],
};

describe('validateToolArgs — 放行侧（宁松勿误伤）', () => {
  it('合参通过返回 null（含缺可选字段）', () => {
    expect(validateToolArgs('manage_terms', { action: 'add', term: '闭包' }, MANAGE)).toBeNull();
  });

  it('无 schema / 非 object 根 schema 一律放行', () => {
    expect(validateToolArgs('t', {}, undefined)).toBeNull();
    expect(validateToolArgs('t', {}, { type: 'string' })).toBeNull();
  });

  it('未知字段放行（additionalProperties 语义，ask_choice 的 multi 靠这条活着）', () => {
    expect(validateToolArgs('manage_terms', { action: 'add', whatever: [1, 2] }, MANAGE)).toBeNull();
  });

  it('不认识的 type 值放行，不拦', () => {
    expect(validateToolArgs('t', { a: 'x' }, { type: 'object', properties: { a: { type: 'any' } } })).toBeNull();
  });
});

describe('validateToolArgs — 拦截侧', () => {
  it('enum 违例：提示以 ` / ` 连接枚举值（term-manage 回归锁依赖此形状）', () => {
    const hint = validateToolArgs('manage_terms', { action: 'nuke' }, MANAGE);
    expect(hint).toContain('add / update / delete');
    expect(hint).toContain('manage_terms');
  });

  it('必填缺失：点名缺哪个', () => {
    expect(validateToolArgs('manage_terms', { term: 'x' }, MANAGE)).toContain('action 缺失（必填）');
  });

  it('类型违例：说清「应为什么、实际是什么」', () => {
    const hint = validateToolArgs('manage_terms', { action: 'delete', terms: '递归' }, MANAGE);
    expect(hint).toContain('terms 应为数组');
    expect(hint).toContain('实际是字符串');
  });

  it('数组元素违例带下标路径', () => {
    expect(validateToolArgs('manage_terms', { action: 'delete', terms: ['a', 2] }, MANAGE)).toContain('terms[1]');
  });

  it('嵌套对象（ask_choice.options 形状）逐层校验并带路径', () => {
    const schema = {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          items: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
        },
      },
      required: ['options'],
    };
    expect(validateToolArgs('ask_choice', { options: [{ label: 'A' }, { label: 7 }] }, schema)).toContain('options[1].label');
    expect(validateToolArgs('ask_choice', { options: [{ note: 'x' }] }, schema)).toContain('options[0].label 缺失（必填）');
  });

  it('数字上下限与 integer 区分', () => {
    const s = { type: 'object', properties: { n: { type: 'integer', minimum: 0, maximum: 1 } } };
    expect(validateToolArgs('t', { n: 1.5 }, s)).toContain('应为整数');
    expect(validateToolArgs('t', { n: 2 }, s)).toContain('不得大于 1');
    expect(validateToolArgs('t', { n: -1 }, s)).toContain('不得小于 0');
    expect(validateToolArgs('t', { n: 0 }, s)).toBeNull();
  });

  it('NaN/Infinity 不算 number（防模型吐出后一路漂进 SQL）', () => {
    const s = { type: 'object', properties: { n: { type: 'number' } } };
    expect(validateToolArgs('t', { n: Number.NaN }, s)).toContain('应为数字');
    expect(validateToolArgs('t', { n: Number.POSITIVE_INFINITY }, s)).toContain('应为数字');
  });
});
