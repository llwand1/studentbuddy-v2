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
    expect(paint.clips.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(paint.clips).length).toBeLessThanOrEqual(12000);
    expect(paint.particles.length).toBeLessThanOrEqual(24);
    expect(paint.clips.filter(([x, y, w, h]) => ![x, y, w, h].every(Number.isInteger)
      || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 64 || y + h > 64)).toEqual([]);
    const clipped = new Uint8Array(64 * 64);
    for (const [x, y, w, h] of paint.clips) for (let row = y; row < y + h; row++) clipped.fill(1, row * 64 + x, row * 64 + x + w);
    const layers = [...paint.particles.flatMap(p => p.rects), ...paint.sigil, ...paint.halo, ...paint.circle, ...paint.book.flatMap(p => p.rects)];
    expect(layers.every(([x, y, w, h]) => {
      for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) if (!clipped[py * 64 + px]) return false;
      return true;
    })).toBe(true);
  }
});
it('reduced motion freezes both sprite and particles; retrieval, embers and celebration use different trajectories', () => {
  expect(companionFrame('retrieving', 0, false)).toEqual(companionFrame('retrieving', 1000, false));
  expect(companionFrame('focus', 5).particles).not.toEqual(companionFrame('retrieving', 5).particles);
  expect(companionFrame('celebrate', 5).particles).not.toEqual(companionFrame('preparing', 5).particles);
  expect(companionFrame('play', 5).sigil.length).toBeGreaterThan(50);
  expect(companionFrame('idle', 5).sigil).toHaveLength(0);
  expect(companionFrame('dragging', 0, false)).toEqual(companionFrame('dragging', 1000, false));
  const casts = (['hex', 'soul', 'rift', 'ember', 'omen', 'nova'] as const).map(school => companionFrame('play', 8, true, false, school));
  expect(new Set(casts.map(p => JSON.stringify([p.particles, p.sigil]))).size).toBe(6);
  for (const cast of casts) expect(cast.clips.length).toBeLessThanOrEqual(512);
});
it('keeps a visible seal in every state and opens the grimoire for reading and spell preparation', () => {
  for (const mood of Object.keys(COMPANION_LABELS) as CompanionMood[]) {
    const paint = companionFrame(mood, 5);
    expect(Math.min(...paint.circle.map(r => r[0]))).toBeLessThanOrEqual(4);
    expect(Math.max(...paint.circle.map(([x, , w]) => x + w))).toBeGreaterThanOrEqual(60);
    expect(paint.book.some(layer => layer.tone === 'cover')).toBe(true);
  }
  for (const mood of ['reading', 'selecting', 'retrieving', 'preparing', 'question'] as const) {
    expect(companionFrame(mood, 0).bookOpen).toBe(true);
    expect(companionFrame(mood, 0).book).not.toEqual(companionFrame(mood, 5).book);
    expect(companionFrame(mood, 0, false).book).toEqual(companionFrame(mood, 1000, false).book);
  }
  expect(companionFrame('idle', 0).bookOpen).toBe(false);
  expect(companionFrame('dragging', 0).school).toBe('ember');
  expect(companionFrame('dragging', 0).sigil).toHaveLength(0);
});

