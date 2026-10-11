import { expect, it } from 'vitest';
import { companionFrame, companionMood, COMPANION_BODY, COMPANION_LABELS, COMPANION_SIZE, type CompanionMood } from './companion-view';
import type { DesktopBrowserState, DesktopStudyState } from '@sb/shared';
const study: DesktopStudyState = { settings: { enabled: true, intervalMinutes: 3, scope: 'learning' }, nextAt: 1000, preparing: false, awaiting: false, question: null, error: '' };
const page: DesktopBrowserState = { sessionId: 's1', connected: true, title: '', url: 'https://example.org', chars: 100, revision: 1, contentRevision: 1, updatedAt: 0, selection: '' };
it('reflects real preparation, scoped retrieval, selected text, lost pages and transport failures', () => {
  expect(companionMood(null, null)).toBe('idle');
  expect(companionMood(study, null)).toBe('focus');
  expect(companionMood({ ...study, preparing: true }, page)).toBe('preparing');
  expect(companionMood({ ...study, awaiting: true }, page)).toBe('question');
  expect(companionMood(study, page)).toBe('reading');
  expect(companionMood(study, { ...page, retrieving: true })).toBe('retrieving');
  expect(companionMood(study, { ...page, selection: '选中概念' })).toBe('selecting');
  expect(companionMood(study, { ...page, connected: false, chars: 0 })).toBe('waiting');
  expect(companionMood({ ...study, settings: { ...study.settings, scope: 'browser' } }, null)).toBe('waiting');
  expect(companionMood(study, page, '断线')).toBe('offline');
  expect(companionMood({ ...study, error: 'AI 暂时未返回题目' }, page)).toBe('retry');
});
it('every moving pixel has a bounded integer native clip, with the smaller body and a limited particle budget', () => {
  expect(COMPANION_BODY).toBe(32); expect(COMPANION_SIZE).toBe(64);
  for (const mood of Object.keys(COMPANION_LABELS) as CompanionMood[]) for (let t = 0; t < 120; t++) {
    const paint = companionFrame(mood, t, true, true);
    expect(paint.clips.length).toBeLessThanOrEqual(96);
    expect(paint.particles.length).toBeLessThanOrEqual(18);
    for (const [x, y, w, h] of paint.clips) {
      expect([x, y, w, h].every(Number.isInteger)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0);
      expect(w).toBeGreaterThan(0); expect(h).toBeGreaterThan(0);
      expect(x + w).toBeLessThanOrEqual(64); expect(y + h).toBeLessThanOrEqual(64);
    }
    for (const p of paint.particles) for (const rect of p.rects) expect(paint.clips).toContainEqual(rect);
  }
});
it('reduced motion freezes both sprite and particles; retrieval, embers and celebration use different trajectories', () => {
  expect(companionFrame('retrieving', 0, false)).toEqual(companionFrame('retrieving', 1000, false));
  expect(companionFrame('focus', 5).particles).not.toEqual(companionFrame('retrieving', 5).particles);
  expect(companionFrame('celebrate', 5).particles).not.toEqual(companionFrame('preparing', 5).particles);
});

