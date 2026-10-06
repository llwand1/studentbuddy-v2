import { it, expect, vi } from 'vitest';
import type { ExamModeView } from '@sb/shared';
const mock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { settings: { examMode: mock.read } } }));
it('白名单保存时旧读取尚未结束，强刷排队并以新配置完成，重复通知共用请求', async () => {
  vi.resetModules();
  const { refreshExamScope } = await import('./useExamScope');
  const old: ExamModeView = { on: true, scope: { packs: [], custom: ['old.example.org'] }, summary: '旧', hosts: ['old.example.org'], directSites: [] };
  const fresh = { ...old, summary: '新', hosts: ['new.example.org'] };
  let release!: (value: ExamModeView) => void;
  mock.read.mockReturnValueOnce(new Promise<ExamModeView>(r => { release = r; })).mockResolvedValueOnce(fresh);
  const initial = refreshExamScope(), forced = refreshExamScope(true), duplicate = refreshExamScope(true);
  expect(mock.read).toHaveBeenCalledTimes(1); release(old);
  expect(await initial).toEqual(old); expect(await forced).toEqual(fresh); expect(await duplicate).toEqual(fresh);
  expect(mock.read).toHaveBeenCalledTimes(2); expect(await refreshExamScope()).toEqual(fresh);
});
