import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { getDb } from '../storage/db.js';
import { ownerForWrite } from '../auth/ownership.js';
export type DesktopBrowser = 'chrome' | 'edge';
const KEY = 'desktop.browser.preferred';
export function browserPaths(browser: DesktopBrowser, env = process.env): string[] {
  const suffix = browser === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
  return [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((v): v is string => !!v).map(root => join(root, ...suffix));
}
export function browserExecutable(browser: DesktopBrowser): string {
  if (process.platform !== 'win32' || process.env.SB_DESKTOP !== '1') throw new Error('指定浏览器仅在 Windows 安装版可用');
  const executable = browserPaths(browser).find(existsSync);
  if (!executable) throw new Error(`未找到 ${browser === 'chrome' ? 'Chrome' : 'Edge'}，请安装该浏览器或重新选择`);
  return executable;
}
export function preferredBrowser(owner: string | null): DesktopBrowser {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE owner_id=? AND key=?').get(ownerForWrite(owner), KEY) as {value:string} | undefined;
  return row?.value === 'chrome' || row?.value === 'edge' ? row.value : browserPaths('edge').some(existsSync) ? 'edge' : 'chrome';
}
export function browserPreference(owner: string | null) {
  return { selected: preferredBrowser(owner), available: (['chrome', 'edge'] as const).filter(b => browserPaths(b).some(existsSync)) };
}
export function savePreferredBrowser(owner: string | null, browser: unknown): void {
  if (browser !== 'chrome' && browser !== 'edge') throw new Error('请选择 Chrome 或 Edge');
  browserExecutable(browser);
  getDb().prepare('INSERT INTO app_settings(owner_id,key,value) VALUES(?,?,?) ON CONFLICT(owner_id,key) DO UPDATE SET value=excluded.value').run(ownerForWrite(owner), KEY, browser);
}
export async function openReaderBrowser(owner: string | null, address: string): Promise<void> {
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/desktop-reader-connect.html' || url.search || !/^#[A-F0-9]{10}$/.test(url.hash)) throw new Error('共读跳转地址无效');
  await new Promise<void>((ok, fail) => {
    const child = spawn(browserExecutable(preferredBrowser(owner)), [url.href], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', () => fail(new Error('浏览器未打开，请检查安装')));
    child.once('spawn', () => { child.unref(); ok(); });
  });
}
export function githubBrowserEnvironment(owner: string | null, root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Scope the adapter to this pinned child. Never change OS default browser or global PATH.
  const browser = preferredBrowser(owner); browserExecutable(browser);
  const adapter = resolve(root, 'browser-launch');
  if (!existsSync(join(adapter, 'rundll32.exe'))) throw new Error('浏览器连接组件缺失，请重新安装');
  const clean = Object.fromEntries(Object.entries(env).filter(([k]) => !/^path$|^SB_GITHUB_BROWSER$/i.test(k)));
  return { ...clean, SB_GITHUB_BROWSER: browser, PATH: adapter + delimiter + (env.PATH ?? env.Path ?? '') };
}
