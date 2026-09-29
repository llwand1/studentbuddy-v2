/**
 * vision-eval-metrics — 看图核验评测口径：失败留分母；误收只看期望 no→yes；误拒只看期望含 yes→no；
 * 泄露检出与误报分开算；时延只统计成功的调用。
 */
import { describe, it, expect } from 'vitest';
import { renderVisionSummary, summarizeVision, type VisionEvalRecord } from './vision-eval-metrics.js';

const r = (expect_: VisionEvalRecord['expect'], got: VisionEvalRecord['got'], extra: Partial<VisionEvalRecord> = {}): VisionEvalRecord => ({
  id: 'x', expect: expect_, got, latencyMs: 1000, ...extra,
});

describe('summarizeVision', () => {
  it('空集全 null', () => {
    expect(summarizeVision([])).toMatchObject({ n: 0, accuracy: null, falseAccept: null, p50Ms: null });
  });
  it('★ 失败留分母、不进时延', () => {
    const s = summarizeVision([r(['yes'], 'yes', { latencyMs: 2000 }), r(['yes'], null, { latencyMs: 99999 })]);
    expect(s.accuracy).toBe(0.5);
    expect(s.failures).toBe(1);
    expect(s.p95Ms).toBe(2000);
  });
  it('★ 误收：期望 no 判 yes；partial 不算误收；多选期望不进误收分母', () => {
    const s = summarizeVision([r(['no'], 'yes'), r(['no'], 'partial'), r(['partial', 'no'], 'yes')]);
    expect(s.falseAccept).toBe(0.5);
  });
  it('误拒：期望含 yes 判 no', () => {
    const s = summarizeVision([r(['yes'], 'no'), r(['yes', 'partial'], 'partial')]);
    expect(s.falseReject).toBe(0.5);
    expect(s.accuracy).toBe(0.5);
  });
  it('泄露检出与误报分开', () => {
    const s = summarizeVision([
      r(['yes'], 'yes', { expectLeak: true, gotLeak: true }),
      r(['yes'], 'yes', { expectLeak: true, gotLeak: false }),
      r(['yes'], 'yes', { expectLeak: false, gotLeak: true }),
      r(['yes'], 'yes', { expectLeak: false, gotLeak: false }),
    ]);
    expect(s.leakRecall).toBe(0.5);
    expect(s.leakFalseAlarm).toBe(0.5);
  });
  it('渲染带分母与时延', () => {
    const md = renderVisionSummary(summarizeVision([r(['no'], 'yes', { latencyMs: 1500 })]), { model: 'm', dataset: 'd', date: '2026-09-29', replay: false });
    expect(md).toContain('n=1');
    expect(md).toContain('100.0%');
    expect(md).toContain('1.5s');
  });
});
