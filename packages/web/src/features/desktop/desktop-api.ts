import type { DesktopBrowserState, DesktopStudySettings, DesktopStudyState } from '@sb/shared';
import { request } from '../../lib/api-request';
const base = '/api/desktop';
const post = <T,>(path: string, body: unknown) => request<T>(base + path, { method: 'POST', body: JSON.stringify(body), timeoutMs: 8000 });
export const desktopApi = {
  browserPreference: () => request<{selected:'chrome'|'edge';available:Array<'chrome'|'edge'>}>(base + '/browser/preference'),
  chooseBrowser: (browser: 'chrome'|'edge') => post<{selected:'chrome'|'edge';available:Array<'chrome'|'edge'>}>('/browser/preference', {browser}),
  openReader: (sessionId: string) => post<{ok:boolean}>('/browser/open', {sessionId}),
  workspace: () => request<{ sessionId: string | null }>(base + '/workspace', { timeoutMs: 8000 }),
  saveWorkspace: (sessionId: string | null) => post<{ sessionId: string | null }>('/workspace', { sessionId }),
  state: () => request<DesktopStudyState>(base + '/study'),
  settings: (settings: DesktopStudySettings) => post<DesktopStudyState>('/study', settings),
  tick: (eligible: boolean) => post<DesktopStudyState>('/study/tick', { eligible }),
  dismiss: (action: 'done' | 'skip' | 'snooze') => post<DesktopStudyState>('/study/dismiss', { action }),
  browser: (text = false) => request<{ page: DesktopBrowserState | null }>(base + `/browser${text ? '?text=1' : ''}`),
  pair: (sessionId: string) => post<{ code: string; endpoint: string; expiresIn: number }>('/browser/pair-code', { sessionId }),
  stopBrowser: () => request<{ ok: boolean }>(base + '/browser', { method: 'DELETE' }),
};
export const isLocalDesktopAddress = () => ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
