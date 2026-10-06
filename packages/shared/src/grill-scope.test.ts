import { describe, it, expect } from 'vitest';
import { normalizeGrillScope } from './grill-scope.js';
describe('GrillMe 学习范围', () => {
  it('旧客户端默认当前对话；忽略客户端伪造的应试域名', () => {
    expect(normalizeGrillScope(undefined)).toEqual({ kind: 'conversation' });
    expect(normalizeGrillScope({ kind: 'exam', topic: '伪造', hosts: ['evil.test'] })).toEqual({ kind: 'exam' });
  });
  it('自定义主题去除首尾空白，保留用户文字', () => {
    expect(normalizeGrillScope({ kind: 'custom', topic: '  线性代数  ' })).toEqual({ kind: 'custom', topic: '线性代数' });
    expect(normalizeGrillScope({ kind: 'custom', topic: '题'.repeat(160) })).not.toBeNull();
  });
  it.each([null, [], 'exam', {}, { kind: 'other' }, { kind: 'custom' }, { kind: 'custom', topic: ' ' }, { kind: 'custom', topic: '题'.repeat(161) }])('非法范围不进入生成：%j', value => {
    expect(normalizeGrillScope(value)).toBeNull();
  });
});
