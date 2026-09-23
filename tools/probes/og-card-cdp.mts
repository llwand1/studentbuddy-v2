/**
 * og-card-cdp.mts — 用真机浏览器把 14 张社交分享卡截成 PNG，落进 `packages/web/public/og/`。
 *
 * ★ 为什么这些图是**提交进仓的静态资源**而不是构建产物：`npm run build` 跑的机器上没有浏览器
 *   （本仓 CI 与老板机器都只有 Node），而社交平台只认一张位图 URL。⇒ 生成一次、提交、构建原样拷贝。
 *   重新生成的时机：改了卡片版式或改了语料文案（词条名／别名／一句话定义）。
 *   命令：`npm run og:shots`（仓库根）。
 *
 * ★ 为什么这个文件是 `.mts` 而不是同伴那些 `.mjs`：卡片 HTML 的**唯一事实源**在
 *   `packages/web/src/seo/og-card.ts`，探针必须 import 它——另抄一份模板就会漂（截图与线上 meta 不同源，
 *   正是本批要防的那类错）。根 `package.json` 没有 `"type": "module"` ⇒ `.ts` 会被 tsx 当 CJS、
 *   顶层 `await` 直接编译失败，所以用 `.mts`。`tsx` 是 `@sb/server` 已声明的 devDependency，不引新依赖。
 *
 * 前置：本机装有 Chromium 系浏览器（Chrome 或 Edge，实测老板机器只有 Edge）。
 *   可 `SB_CHROME` 指路径、`SB_CDP_PORT` 换端口（起前先探端口，绝不连别人的浏览器）。
 * 无需：vite / 服务器 / 登录——HTML 直接 `Page.setDocumentContent` 灌进去。
 *
 * ★ 每条都量「有没有被静默裁掉」：卡片是固定 1200×630 且 `overflow:hidden`，内容超了不会报错、
 *   只会少一截——那是本类产物最容易骗过眼睛的错。任一卡溢出 ⇒ EXIT=1 且不落盘。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_OG_CARDS, OG_CARD_H, OG_CARD_W, ogImageName, renderOgCardHtml } from '../../packages/web/src/seo/og-card';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = join(ROOT, 'packages/web/public/og');

const PORT = Number(process.env.SB_CDP_PORT) || 9300 + Math.floor(Math.random() * 400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 起前先探端口：残留实例占着端口会连到别人的浏览器
try {
  const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.error(`端口 ${PORT} 上已有 CDP 实例（${j.Browser}）——拒绝继续。可 SB_CDP_PORT 换一个。`);
  process.exit(1);
} catch {
  /* 空着，可以用 */
}

const CHROME =
  process.env.SB_CHROME ||
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find(existsSync) || 'chrome';
console.log('browser =', CHROME);

const profile = mkdtempSync(join(tmpdir(), 'sbog-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${OG_CARD_W},${OG_CARD_H}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ver: { Browser?: string } | null = null;
for (let i = 0; i < 40 && !ver; i++) {
  try {
    ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    await sleep(250);
  }
}
if (!ver) {
  console.error('CDP 未就绪');
  chrome.kill();
  process.exit(1);
}
console.log('chrome =', ver.Browser);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(targets.find((t: { type: string }) => t.type === 'page').webSocketDebuggerUrl);
await new Promise<void>((res, rej) => {
  ws.onopen = () => res();
  ws.onerror = () => rej(new Error('CDP 连接失败'));
});
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (e: { data: string }) => {
  const m = JSON.parse(e.data) as { id?: number };
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
  }
};
const send = <T = { result?: { data?: string } }>(method: string, params: Record<string, unknown> = {}) =>
  new Promise<T>((res) => {
    const i = ++id;
    pending.set(i, res as (v: unknown) => void);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
const frame = await send<{ result: { frameTree: { frame: { id: string } } } }>('Page.getFrameTree');
const frameId = frame.result.frameTree.frame.id;
await send('Emulation.setDeviceMetricsOverride', {
  width: OG_CARD_W,
  height: OG_CARD_H,
  deviceScaleFactor: 1,
  mobile: false,
});

/** 溢出判据：卡片是定高 ＋ `overflow:hidden`，超出去的那一截不会报错，只会看不见 */
const MEASURE = `(() => {
  const W=${OG_CARD_W}, H=${OG_CARD_H};
  const bad=[];
  document.querySelectorAll('.frame *').forEach((e)=>{
    const b=e.getBoundingClientRect();
    if(b.height<=0) return;
    if(b.bottom>H+1||b.right>W+1||b.left<-1||b.top<-1)
      bad.push(e.className+' 底'+Math.round(b.bottom)+' 右'+Math.round(b.right));
  });
  const foot=document.querySelector('.foot').getBoundingClientRect();
  return {bad, footBottom:Math.round(foot.bottom), docOverflow:document.documentElement.scrollHeight-H};
})()`;

mkdirSync(OUT_DIR, { recursive: true });
let fail = 0;
const rows: string[] = [];
for (const card of ALL_OG_CARDS) {
  await send('Page.setDocumentContent', { frameId, html: renderOgCardHtml(card) });
  await sleep(320);
  const m = (
    await send<{ result?: { result?: { value?: { bad: string[]; footBottom: number; docOverflow: number } } } }>(
      'Runtime.evaluate',
      { expression: MEASURE, returnByValue: true },
    )
  ).result?.result?.value;
  const shot = await send<{ result?: { data?: string } }>('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: OG_CARD_W, height: OG_CARD_H, scale: 1 },
  });
  const buf = Buffer.from(shot.result?.data ?? '', 'base64');
  const over = m?.bad?.length ?? 1;
  if (over > 0 || buf.length < 1000) {
    fail++;
    console.error(`✗ ${card.slug}：${over > 0 ? `内容溢出 ${JSON.stringify(m?.bad)}` : '截图为空'}`);
    continue;
  }
  writeFileSync(join(OUT_DIR, ogImageName(card)), buf);
  rows.push(
    `✓ ${ogImageName(card).padEnd(26)} ${String(Math.round(buf.length / 1024)).padStart(4)} KB  底边到 ${m!.footBottom}px`,
  );
}
console.log(rows.join('\n'));
console.log(
  fail === 0
    ? `\n✓ ${ALL_OG_CARDS.length} 张卡已写进 packages/web/public/og/（尺寸 ${OG_CARD_W}×${OG_CARD_H}）`
    : `\n✗ ${fail} 张失败，未落盘的那几张保持原样`,
);
ws.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
