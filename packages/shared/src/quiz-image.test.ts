/**
 * 出题配图契约（docs/QUIZ-IMAGE-SPEC.md §2.3）：normalizeQuizSvg 的「丢图保题」规则。
 * 核心不变量：任何非法输入都只返回 undefined（图不要了），**绝不抛错牵连题目本身**。
 */
import { describe, it, expect } from 'vitest';
import { normalizeQuizSvg, MAX_QUIZ_SVG_CHARS, DEFAULT_QUIZ_IMAGE, SETTING_KEY_QUIZ_IMAGE } from './content-blocks.js';

const OK = '<svg viewBox="0 0 100 60"><circle cx="50" cy="30" r="20" fill="none" stroke="#333"/></svg>';

describe('normalizeQuizSvg — 合法图原样通过', () => {
  it('完整 SVG 原样返回（trim 掉首尾空白）', () => {
    expect(normalizeQuizSvg(`  ${OK}  `)).toBe(OK);
  });

  it('自闭合根标记也算合法', () => {
    expect(normalizeQuizSvg('<svg viewBox="0 0 10 10"/>')).toBe('<svg viewBox="0 0 10 10"/>');
  });
});

describe('normalizeQuizSvg — 非法图一律丢弃（返回 undefined）', () => {
  it('非字符串 / null / undefined / 空白 → 丢', () => {
    expect(normalizeQuizSvg(undefined)).toBeUndefined();
    expect(normalizeQuizSvg(null)).toBeUndefined();
    expect(normalizeQuizSvg(123)).toBeUndefined();
    expect(normalizeQuizSvg({ a: 1 })).toBeUndefined();
    expect(normalizeQuizSvg('   ')).toBeUndefined();
  });

  it('不含 <svg 根标记 → 丢（模型误填了描述文字而非源码）', () => {
    expect(normalizeQuizSvg('一个直角三角形，直角在 C 点')).toBeUndefined();
  });

  it('缺 </svg> 闭合 → 丢（宁可不给，也不给半张会教错人的残缺图）', () => {
    expect(normalizeQuizSvg('<svg viewBox="0 0 100 60"><circle cx="50" cy="30" r="20"')).toBeUndefined();
  });

  it('超长（> MAX_QUIZ_SVG_CHARS）→ 丢（几百个元素的怪物图，基本是模型跑飞了）', () => {
    const long = `<svg viewBox="0 0 10 10">${'<rect/>'.repeat(2000)}</svg>`;
    expect(long.length).toBeGreaterThan(MAX_QUIZ_SVG_CHARS);
    expect(normalizeQuizSvg(long)).toBeUndefined();
  });
});

describe('出题配图开关常量（契约 §2.2）', () => {
  it('默认关闭：配图显著拉长输出，弱模型先不背这个包袱', () => {
    expect(DEFAULT_QUIZ_IMAGE).toBe(false);
  });

  it('设置键与出题配比同级，落 app_settings', () => {
    expect(SETTING_KEY_QUIZ_IMAGE).toBe('quiz_image');
  });
});
