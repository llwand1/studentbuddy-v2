/**
 * learner — 评分输出的校验口径。
 */
import { describe, it, expect } from 'vitest';
import { parseGradeResult } from './learner.js';

describe('parseGradeResult', () => {
  it('合法输出原样收下；外面包了话也能抠出 JSON', () => {
    expect(parseGradeResult('好的：{"verdict":"partial","score":0.5,"feedback":"要点一对了","misconception":"把光反应当成暗反应"}')).toEqual({
      verdict: 'partial', score: 0.5, feedback: '要点一对了', misconception: '把光反应当成暗反应',
    });
  });
  it('★ verdict 与分数矛盾时以 verdict 为准，把分钳进区间', () => {
    expect(parseGradeResult('{"verdict":"wrong","score":0.9,"feedback":"x"}')?.score).toBe(0.3);
    expect(parseGradeResult('{"verdict":"correct","score":0.1,"feedback":"x"}')?.score).toBe(0.8);
    expect(parseGradeResult('{"verdict":"partial","feedback":"x"}')?.score).toBe(0.5);
  });
  it('★ 答对时不带误区（模型硬塞的也丢掉）；空误区当 null', () => {
    expect(parseGradeResult('{"verdict":"correct","score":1,"feedback":"好","misconception":"无"}')?.misconception).toBeNull();
    expect(parseGradeResult('{"verdict":"wrong","score":0,"feedback":"错","misconception":"  "}')?.misconception).toBeNull();
  });
  it('不成形 ⇒ null：没有 JSON、坏 JSON、未知 verdict、没有反馈', () => {
    for (const bad of ['不会', '{bad', '{"verdict":"maybe","feedback":"x"}', '{"verdict":"wrong","feedback":""}']) {
      expect(parseGradeResult(bad)).toBeNull();
    }
  });
  it('反馈与误区截断到上限', () => {
    const r = parseGradeResult(JSON.stringify({ verdict: 'wrong', score: 0, feedback: '长'.repeat(900), misconception: '误'.repeat(300) }));
    expect(r?.feedback.length).toBe(400);
    expect(r?.misconception?.length).toBe(120);
  });
});
