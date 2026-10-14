import { expect, it } from 'vitest';
import { DEFAULT_DESKTOP_STUDY, parseDesktopStudySettings } from './desktop-study.js';
it('defaults to opt-in, three minutes; accepts only bounded integral intervals', () => {
  expect(DEFAULT_DESKTOP_STUDY).toEqual({ enabled: false, intervalMinutes: 3, scope: 'learning' });
  for (const intervalMinutes of [1, 3, 60]) expect(parseDesktopStudySettings({ enabled: true, intervalMinutes, scope: 'browser' })).not.toBeNull();
  for (const intervalMinutes of [0, 61, 1.5, '3', NaN, Infinity]) expect(parseDesktopStudySettings({ enabled: true, intervalMinutes, scope: 'learning' })).toBeNull();
});
it('rejects incomplete or unknown scope settings rather than silently enabling quizzes', () => {
  for (const value of [null, {}, { enabled: 'true', intervalMinutes: 3, scope: 'learning' }, { enabled: true, intervalMinutes: 3, scope: 'all-tabs' }])
    expect(parseDesktopStudySettings(value)).toBeNull();
});
it('accepts the explicit B站 video learning scope without changing the opt-in default',()=>{
  expect(parseDesktopStudySettings({enabled:true,intervalMinutes:3,scope:'bilibili'})?.scope).toBe('bilibili');
  expect(DEFAULT_DESKTOP_STUDY.enabled).toBe(false);
});
