/**
 * sources/shot —— 阅读页打不开时的**截图保底**（契约 docs/SOURCE-TRACE-SPEC.md §13）。
 *
 * 阅读模式（`reader.ts`）拿的是 HTML 正文，三类页面注定拿不好：脚本渲染的单页应用（正文几乎为空）、
 * 拒绝非浏览器 UA 的站（403/412）、返回非网页内容的地址。与其让学习者对着一句「请开原网页」，
 * 不如让服务器**用真浏览器把首屏截成一张图搬过来**。
 *
 * 三条硬约束（都来自 2026-09-30 的产品决定）：
 *  - **只用系统里已有的 Chromium**：不打包 Playwright、不加 npm 依赖、不接第三方截图服务。
 *    有就截，没有就如实告诉前端「服务器没装浏览器」，面板退回「新标签页打开」。
 *  - **不放松 SSRF 边界**：浏览器所有出站流量经 `shot-proxy` 守门（见该文件头），主网址起浏览器前再过一次 `assertSafeUrl`。
 *  - **不拖垮服务器**：同时最多 2 个浏览器进程、排队上限 4、单次 20s 硬超时、PNG 上限 8MB、结果按网址缓存 10 分钟。
 *
 * 浏览器路径：环境变量 `SB_SHOT_BROWSER`（绝对路径；`off` 关掉）优先，否则在 PATH 上找常见名字。探测结果进程内缓存。
 * 无头参数里 `--no-sandbox` 只在以 root 运行时才加（Chromium 不加它就拒绝以 root 启动；非 root 保留沙箱）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeUrl } from '../search/ssrf-guard.js';
import { FETCH_UA } from '../media/image-download.js';
import { startGuardProxy, type GuardProxy, type SafeResolve } from './shot-proxy.js';

export const SHOT_WIDTH = 1000;
export const SHOT_HEIGHT = 1400;
export const SHOT_TIMEOUT_MS = 20_000;
export const SHOT_MAX_BYTES = 8 * 1024 * 1024;
export const SHOT_CONCURRENCY = 2;
export const SHOT_QUEUE_MAX = 4;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 12;

/** PATH 上按顺序找的名字（Debian/Ubuntu 的 chromium、Google 的 chrome、Edge） */
export const BROWSER_CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'microsoft-edge'] as const;

export type ShotErrorKind = 'no_browser' | 'blocked' | 'timeout' | 'busy' | 'failed';

/** 面向前端的失败：`kind` 定状态码，`message` 是能直接给学习者看的一句话 */
export class ShotError extends Error {
  constructor(
    readonly kind: ShotErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ShotError';
  }
}

const isExecutable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** 找浏览器可执行文件：`SB_SHOT_BROWSER` 优先（`off` = 明确关掉），否则扫 PATH；找不到 ⇒ null */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isExecutable): string | null {
  const explicit = (env.SB_SHOT_BROWSER ?? '').trim();
  if (explicit.toLowerCase() === 'off') return null;
  if (explicit) return exists(explicit) ? explicit : null;
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of BROWSER_CANDIDATES) {
    for (const dir of dirs) {
      const full = path.join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

let detected: string | null | undefined;

/** 进程内只探测一次（装了浏览器要重启服务才认，如实写在文档里） */
export function shotBrowser(): string | null {
  if (detected === undefined) detected = findBrowser();
  return detected;
}
export const shotAvailable = (): boolean => shotBrowser() !== null;

export interface ShotArgsInput {
  url: string;
  outFile: string;
  profileDir: string;
  proxyPort: number;
  /** 以 root 运行时 Chromium 必须 `--no-sandbox` 才肯启动 */
  root: boolean;
}

/** 无头截图参数（纯函数，便于锁住安全相关的几个开关） */
export function shotArgs(o: ShotArgsInput): string[] {
  return [
    '--headless',
    '--disable-gpu',
    ...(o.root ? ['--no-sandbox'] : []),
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--mute-audio',
    `--user-data-dir=${o.profileDir}`,
    `--user-agent=${FETCH_UA}`,
    '--lang=zh-CN',
    `--window-size=${SHOT_WIDTH},${SHOT_HEIGHT}`,
    '--virtual-time-budget=6000',
    '--timeout=12000',
    // ★ 所有出站流量（含回环）都交给守门代理：没有 `<-loopback>` 时 Chromium 会绕开代理直连 localhost
    `--proxy-server=http://127.0.0.1:${o.proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    `--screenshot=${o.outFile}`,
    o.url,
  ];
}

export type ShotExec = (bin: string, args: string[], timeoutMs: number) => Promise<void>;

const execBrowser: ShotExec = (bin, args, timeoutMs) =>
  new Promise((ok, fail) => {
    execFile(bin, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true }, (err) => (err ? fail(err) : ok()));
  });

export interface ShotDeps {
  bin?: string | null;
  exec?: ShotExec;
  resolve?: SafeResolve;
  root?: boolean;
}

const cache = new Map<string, { png: Buffer; at: number }>();
let running = 0;
const waiting: Array<() => void> = [];

const acquire = (): Promise<void> => {
  if (running < SHOT_CONCURRENCY) {
    running += 1;
    return Promise.resolve();
  }
  if (waiting.length >= SHOT_QUEUE_MAX) return Promise.reject(new ShotError('busy', '截图排队的人太多，稍后再试或直接开原网页'));
  return new Promise((ok) => {
    waiting.push(() => {
      running += 1;
      ok();
    });
  });
};
const release = (): void => {
  running -= 1;
  waiting.shift()?.();
};

/** 测试用：清缓存、重置探测结果 */
export function resetShotState(): void {
  cache.clear();
  detected = undefined;
}

/**
 * 截一张网页首屏 PNG。失败一律抛 `ShotError`（路由按 `kind` 给状态码）。
 * 顺序：缓存 → 主网址过 SSRF 守卫 → 拿并发名额 → 起守门代理 → 起浏览器 → 读图（校验 PNG 魔数与上限）→ 清临时目录。
 */
export async function takeScreenshot(url: string, deps: ShotDeps = {}): Promise<Buffer> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.png;
  const bin = deps.bin === undefined ? shotBrowser() : deps.bin;
  if (!bin) throw new ShotError('no_browser', '服务器没装浏览器，截不了图');
  try {
    await assertSafeUrl(url);
  } catch {
    throw new ShotError('blocked', '该地址不允许访问');
  }
  await acquire();
  let proxy: GuardProxy | null = null;
  let dir = '';
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-shot-'));
    proxy = await startGuardProxy(deps.resolve);
    const outFile = path.join(dir, 'shot.png');
    const root = deps.root ?? (typeof process.getuid === 'function' && process.getuid() === 0);
    const args = shotArgs({ url, outFile, profileDir: path.join(dir, 'profile'), proxyPort: proxy.port, root });
    try {
      await (deps.exec ?? execBrowser)(bin, args, SHOT_TIMEOUT_MS);
    } catch (err) {
      // execFile 到点杀进程时给的是 `killed: true` + `signal`，不是 timeout 字样的 message
      const e = (err ?? {}) as { killed?: boolean; signal?: string | null; message?: string };
      if (e.killed || e.signal || /timed? ?out/i.test(e.message ?? '')) throw new ShotError('timeout', '截图超时：对方页面太慢或一直在加载');
      throw new ShotError('failed', '浏览器没截成这一页');
    }
    let png: Buffer;
    try {
      png = await fs.promises.readFile(outFile);
    } catch {
      throw new ShotError('failed', '浏览器没截成这一页');
    }
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new ShotError('failed', '浏览器没截成这一页');
    if (png.length > SHOT_MAX_BYTES) throw new ShotError('failed', '截图太大，放弃；请开原网页');
    cache.delete(url);
    cache.set(url, { png, at: Date.now() });
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return png;
  } finally {
    release();
    if (proxy) await proxy.close().catch(() => undefined);
    if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
