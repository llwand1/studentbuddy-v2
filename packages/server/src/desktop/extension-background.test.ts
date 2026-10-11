import { beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
type Listener = (message: Record<string, unknown>, sender: Record<string, unknown>, reply: (value: Record<string, unknown>) => void) => boolean;
let listener: Listener;
let updated: (id: number, info: Record<string, unknown>) => Promise<void>;
let saved: Record<string, Record<string, unknown>>;
let scripts: Array<{ target: { tabId: number }; files?: string[]; args?: string[] }>;
let calls: Array<{ url: string; method: string; body?: string }>;
let fetchStatus = 200;
const id = 'a'.repeat(32); const popup = { id, url: `chrome-extension://${id}/popup.html` };
const KEY = 'studentbuddy.reader';
const send = (message: Record<string, unknown>, sender: Record<string, unknown> = popup) => new Promise<Record<string, unknown>>(reply => listener(message, sender, reply));
beforeEach(() => {
  saved = {}; scripts = []; calls = []; fetchStatus = 200;
  const context = vm.createContext({ URL, AbortSignal, crypto, console, fetch: async (url: string, options: { method: string; body?: string }) => {
    calls.push({ url, ...options }); return { ok: fetchStatus === 200, status: fetchStatus,
      json: async () => url.endsWith('/pair') ? { token: 'scoped-test-token' } : fetchStatus === 200 ? { ok: true } : { error: '已停止' } };
  }, chrome: {
    runtime: { id, getURL: (file: string) => `chrome-extension://${id}/${file}`, onMessage: { addListener: (fn: Listener) => { listener = fn; } } },
    storage: { session: { get: async (key: string) => ({ [key]: saved[key] }), set: async (value: Record<string, Record<string, unknown>>) => { Object.assign(saved, value); }, remove: async (key: string) => { delete saved[key]; } } },
    scripting: { executeScript: async (script: { target: { tabId: number } }) => { scripts.push(script); } },
    tabs: { query: async () => [{ id: 7, url: 'https://docs.example.org/a', title: '教程' }], get: async () => ({ url: 'https://docs.example.org/b' }),
      onRemoved: { addListener: () => {} }, onUpdated: { addListener: (fn: typeof updated) => { updated = fn; } } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  } });
  vm.runInContext(fs.readFileSync(new URL('../../../../tools/browser-extension/background.js', import.meta.url), 'utf8'), context);
});
const setup = async () => {
  await send({ type: 'pair', endpoint: 'http://127.0.0.1:18794', code: '1234567890' });
  await send({ type: 'start' });
};
const snapshot = (epoch: unknown) => ({ type: 'snapshot', data: { url: 'https://docs.example.org/a', title: '教程', text: '本次页面内容', selection: '', viewport: '', epoch, seq: 1 } });
it('accepts commands only from its own popup and refuses arbitrary remote endpoints', async () => {
  expect(await send({ type: 'pair', endpoint: 'https://evil.example', code: '1234567890' })).toHaveProperty('error');
  expect(calls).toHaveLength(0);
  expect(await send({ type: 'start' }, { id, url: 'https://evil.example/' })).toHaveProperty('error');
});
it('reads only the chosen top-level tab and invalidates old document epochs at navigation', async () => {
  await setup(); const old = saved[KEY]!.epoch;
  expect(scripts.some(s => s.files?.includes('content.js') && s.target.tabId === 7)).toBe(true);
  const wrongTab = { id, url: 'https://docs.example.org/a', tab: { id: 8 }, frameId: 0 };
  expect(await send(snapshot(old), wrongTab)).toEqual({ stop: true });
  const sender = { ...wrongTab, tab: { id: 7 } };
  expect(await send(snapshot(old), sender)).toEqual({ ok: true });
  await vi.waitFor(() => expect(calls.some(c => c.url.endsWith('/page') && c.method === 'POST')).toBe(true));
  await updated(7, { status: 'loading' }); await updated(7, { status: 'complete' });
  expect(saved[KEY]!.epoch).not.toBe(old);
  expect(await send(snapshot(old), sender)).toEqual({ stop: true });
  expect(calls.some(c => c.method === 'DELETE' && c.body?.includes(String(old)))).toBe(true);
});
it('stopping revokes the local connection; a server-side stop halts further capture', async () => {
  await setup(); await send({ type: 'stop' }); expect(saved[KEY]).toBeUndefined();
  expect(calls.some(c => c.url.endsWith('/connection') && c.method === 'DELETE')).toBe(true);
  await setup(); fetchStatus = 401;
  await send(snapshot(saved[KEY]!.epoch), { id, url: 'https://docs.example.org/a', tab: { id: 7 }, frameId: 0 });
  await vi.waitFor(() => expect(saved[KEY]!.token).toBeUndefined());
  expect(saved[KEY]!.error).toContain('重新配对');
});
