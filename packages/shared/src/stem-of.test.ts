import { describe, expect, it } from 'vitest';
import { MAX_QUIZ_MATERIAL_CHARS, stemOf } from './content-blocks.js';

describe('stemOf —— 材料＋题干才是完整题干', () => {
  it('有材料：材料在前、题目在后，中间有明确分隔', () => {
    const s = stemOf({ question: '作者的态度是？', material: '  背影一文……  ' });
    expect(s.indexOf('背影一文')).toBeLessThan(s.indexOf('作者的态度'));
    expect(s).toMatch(/【材料】[\s\S]*【题目】/);
  });
  it('无材料/空白材料：原样返回题干（旧题数据零变化）', () => {
    expect(stemOf({ question: 'q' })).toBe('q');
    expect(stemOf({ question: 'q', material: '   ' })).toBe('q');
  });
  it('material 上限常量存在且合理', () => expect(MAX_QUIZ_MATERIAL_CHARS).toBeGreaterThanOrEqual(2500));
});
