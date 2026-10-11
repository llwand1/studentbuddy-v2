import { expect, it, vi } from 'vitest';
import type { CampfireOpener, DesktopStudySettings } from '@sb/shared';
import { StudyClock } from './study-clock.js';
const settings: DesktopStudySettings = { enabled: true, intervalMinutes: 3, scope: 'learning' };
const question: CampfireOpener = { id: 'q1', scope: '', question: { topic: '数学', question: '2 加 3 是多少？', options: ['4', '5'], answer: 1, explanation: '2 加 3 等于 5。' } };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
it('prepares one question, delivers at three minutes, never stacks or catches up missed intervals', async () => {
  let now = 0; const generate = vi.fn(async (_exclude: string[]) => question);
  const clock = new StudyClock(settings, generate, () => 'learning', () => now);
  expect(clock.tick(true).question).toBeNull(); await settle();
  now = 179999; expect(clock.tick(true).awaiting).toBe(false);
  now = 180000; expect(clock.tick(true).question?.id).toBe('q1');
  now = 10 * 60 * 60000; clock.tick(true); expect(generate).toHaveBeenCalledTimes(1);
  clock.dismiss('done'); expect(clock.state().nextAt).toBe(now + 180000);
  clock.tick(true); await settle(); expect(generate.mock.calls.length).toBe(2);
  expect(generate.mock.calls[1]?.[0]).toEqual([question.question.question]);
});
it('disabled and hidden/expanded ball does not spend model calls or open questions', async () => {
  let now = 0; const generate = vi.fn(async () => question);
  const clock = new StudyClock({ ...settings, enabled: false }, generate, () => 'learning', () => now);
  now = 999999; clock.tick(true); expect(generate).not.toHaveBeenCalled();
  clock.configure(settings); clock.tick(false); expect(generate).not.toHaveBeenCalled();
  clock.tick(true); await settle(); now += 180000;
  expect(clock.tick(false).awaiting).toBe(false); expect(clock.tick(true).awaiting).toBe(true);
});
it('snooze discards the current question and waits two minutes before another delivery', async () => {
  let now = 0; const clock = new StudyClock(settings, async () => question, () => 'learning', () => now);
  clock.tick(true); await settle(); now = 180000; clock.tick(true); clock.dismiss('snooze');
  expect(clock.state().question).toBeNull(); expect(clock.state().nextAt).toBe(300000);
});
it('source updates cancel stale preparations and ignore results that arrive after disabling', async () => {
  let source = 'page-1'; let signal: AbortSignal | undefined;
  let resolve: (q: CampfireOpener) => void = () => {};
  const generate = vi.fn((_exclude: string[], input: AbortSignal) => { signal = input; return new Promise<CampfireOpener>(done => { resolve = done; }); });
  const clock = new StudyClock({ ...settings, scope: 'browser' }, generate, () => source);
  clock.tick(true); const oldSignal = signal; source = 'page-2'; clock.tick(true);
  expect(oldSignal?.aborted).toBe(true);
  clock.configure({ ...settings, enabled: false }); resolve(question); await settle();
  expect(clock.state().question).toBeNull(); expect(clock.state().preparing).toBe(false);
});
it('waits for a chosen browser page and backs off failures for a full interval', async () => {
  let now = 0; let source = ''; const generate = vi.fn(async () => { throw new Error('模型暂时不可用'); });
  const clock = new StudyClock({ ...settings, scope: 'browser' }, generate, () => source, () => now);
  expect(clock.tick(true).error).toContain('选择'); expect(generate).not.toHaveBeenCalled();
  source = 'page-1'; clock.tick(true); await settle(); expect(clock.state().error).toContain('模型暂时不可用');
  now = 179999; clock.tick(true); expect(generate).toHaveBeenCalledTimes(1);
  now = 180000; clock.tick(true); expect(generate).toHaveBeenCalledTimes(2);
});
it('waits for fifteen seconds of stable page content instead of repeatedly calling AI during dynamic loading', async () => {
  let now = 0; let source = 'page-1'; const generate = vi.fn(async () => question);
  const clock = new StudyClock({ ...settings, scope: 'browser' }, generate, () => source, () => now);
  clock.tick(true); await settle(); expect(generate).toHaveBeenCalledTimes(1);
  source = 'page-2'; clock.tick(true); expect(generate).toHaveBeenCalledTimes(1);
  now = 14000; source = 'page-3'; clock.tick(true); expect(generate).toHaveBeenCalledTimes(1);
  now = 28999; clock.tick(true); expect(generate).toHaveBeenCalledTimes(1);
  now = 29000; clock.tick(true); expect(generate).toHaveBeenCalledTimes(2);
});
