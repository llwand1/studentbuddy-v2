// @vitest-environment jsdom
/**
 * reading-prefs：阅读区字号的本机偏好（契约 `docs/READING-SIZE-SPEC.md`）。
 *
 * 本文件只管**状态**（存了什么、读回什么、落到哪个 DOM 属性）。
 * 纯 CSS 那一半（规则还在不在、引入顺序对不对）量不出来，单独由 `styles/reading.css.test.ts` 锁。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_READING_SIZE,
  READING_SIZES,
  applyReadingSize,
  loadReadingSize,
  normalizeReadingSize,
  saveReadingSize,
} from './reading-prefs';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.reading;
});

describe('reading-prefs：偏好读写', () => {
  it('没存过 ⇒ 标准档（老用户升级后一个像素都不变）', () => {
    expect(loadReadingSize()).toBe(DEFAULT_READING_SIZE);
    expect(DEFAULT_READING_SIZE).toBe('m');
    expect(READING_SIZES.find((o) => o.id === 'm')?.px).toBe(14);
  });

  it('存了就读得回来，并落到 <html data-reading>（DOM 上只有一个事实源）', () => {
    expect(saveReadingSize('l')).toBe('l');
    expect(loadReadingSize()).toBe('l');
    expect(document.documentElement.dataset.reading).toBe('l');
  });

  it('未知值（手改 localStorage / 旧版遗留）一律退回默认，不让界面进无样式状态', () => {
    expect(normalizeReadingSize('xxl')).toBe('m');
    expect(normalizeReadingSize(null)).toBe('m');
    expect(normalizeReadingSize(42)).toBe('m');
    localStorage.setItem('sb:reading:size', 'xxl');
    expect(loadReadingSize()).toBe('m');
  });

  it('applyReadingSize 只动 data 属性，不碰 localStorage（预览 / 初始化复用它）', () => {
    applyReadingSize('xl');
    expect(document.documentElement.dataset.reading).toBe('xl');
    expect(localStorage.getItem('sb:reading:size')).toBeNull();
  });

  it('档位表是 UI 与 CSS 的共同事实源：id 唯一、px 单调递增', () => {
    const ids = READING_SIZES.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    const px = READING_SIZES.map((o) => o.px);
    expect([...px].sort((a, b) => a - b)).toEqual(px);
  });
});
