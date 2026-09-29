/**
 * fsrs-fit — 个人稳定性缩放：样本不足不拟合；记得比预测牢 ⇒ k>1、忘得快 ⇒ k<1；
 * 与默认一致 ⇒ k≈1；拟合后损失不高于默认；先验把小样本拉向 1。
 */
import { describe, it, expect } from 'vitest';
import { FSRS_FIT_MIN_N, fitStabilityScale, scaleRetrievability, type FsrsFitSample } from './fsrs-fit.js';

/** 按真实缩放 kTrue 造样本：确定性地让记住比例等于缩放后的概率 */
function synth(kTrue: number, n: number): FsrsFitSample[] {
  const out: FsrsFitSample[] = [];
  const rs = [0.95, 0.9, 0.85, 0.8, 0.7, 0.6];
  for (let i = 0; i < n; i += 1) {
    const r = rs[i % rs.length]!;
    const p = scaleRetrievability(r, kTrue);
    // 每个 r 桶内按 p 的比例记住（低差异序列，避免随机数）
    const j = Math.floor(i / rs.length);
    out.push({ r, recalled: ((j * 0.618034) % 1) < p });
  }
  return out;
}

describe('scaleRetrievability', () => {
  it('k=1 不变；k>1 预测更高；k<1 更低', () => {
    expect(scaleRetrievability(0.8, 1)).toBeCloseTo(0.8, 6);
    expect(scaleRetrievability(0.8, 2)).toBeGreaterThan(0.8);
    expect(scaleRetrievability(0.8, 0.5)).toBeLessThan(0.8);
  });
});

describe('fitStabilityScale', () => {
  it('样本不足 ⇒ null', () => {
    expect(fitStabilityScale(synth(1, FSRS_FIT_MIN_N - 1))).toBeNull();
  });
  it('★ 记得比默认预测牢 ⇒ k>1；忘得快 ⇒ k<1', () => {
    const strong = fitStabilityScale(synth(2.5, 300))!;
    const weak = fitStabilityScale(synth(0.4, 300))!;
    expect(strong.scale).toBeGreaterThan(1.5);
    expect(weak.scale).toBeLessThan(0.7);
    expect(strong.lossFitted).toBeLessThan(strong.lossDefault);
    expect(strong.predictedFitted).toBeGreaterThan(strong.predictedDefault);
  });
  it('与默认模型一致 ⇒ k 接近 1', () => {
    const r = fitStabilityScale(synth(1, 300))!;
    expect(r.scale).toBeGreaterThan(0.8);
    expect(r.scale).toBeLessThan(1.25);
  });
  it('★ 先验：同样的倾向，样本少时 k 更贴近 1', () => {
    const few = fitStabilityScale(synth(3, 36))!;
    const many = fitStabilityScale(synth(3, 600))!;
    expect(Math.abs(Math.log(few.scale))).toBeLessThan(Math.abs(Math.log(many.scale)));
  });
  it('全记住也不会跑出上限；非法 r 被丢弃', () => {
    const all = Array.from({ length: 40 }, () => ({ r: 0.9, recalled: true }));
    const r = fitStabilityScale([...all, { r: Number.NaN, recalled: false }, { r: 0, recalled: false }])!;
    expect(r.n).toBe(40);
    expect(r.scale).toBeLessThanOrEqual(4);
    expect(r.scale).toBeGreaterThan(1);
  });
});
