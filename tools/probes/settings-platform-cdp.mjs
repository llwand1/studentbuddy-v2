/**
 * settings-platform-cdp.mjs — 「一键默认设置 + 模型下拉」真机渲染探针（零依赖，直驱无头 Chrome）。
 *
 * ★ 为什么需要它：本批（2026-09-21 v0.2.99）的两件事**都发生在屏幕上**——
 *   ① 「一键默认设置」按钮点下去，8 行绑定表要跟着变（不变＝用户看到"点了没反应"）；
 *   ② 模型列要从输入框变成**真下拉**（`RoleRow` 里那个 `models.length > 0 ? select : input`）。
 *   单测（`RoleRow.test.tsx` 8 例）是 jsdom：**没有真 CSS、没有真 fetch、没有真后端**，
 *   它证明不了"这条链路在真机上真的接上了"。本探针补这一层。
 *
 * ★★ **本探针最重要的产出其实是一条「现状事实」，别把它当断言噪音**：
 *   `GET /api/providers/:id/models` 要拿 **key** 去问上游的 `/models`，而**免费通道的 key 只在服务端 env**。
 *   于是**没配 `SB_PLATFORM_*` 时，平台服务商永远返回空候选** ⇒ 绑定到平台通道的那几行
 *   **渲染的是输入框、不是下拉**（A7 就锁这条）。也就是说：老板要的「直接用选项选」，
 *   在**免费通道配好 key 之前**在界面上是**看不见**的；一旦 key 配好（且上游实现了 `/models`），
 *   同一行会自动变成下拉。A5 用一个**本地假上游**（实现了 `/models`）证明"配好了就真有下拉"。
 *
 * 验什么（16 条，任一失败 EXIT=1）：
 *   A1  应用壳渲染出来了（不是落地页）——侧栏有「设置」导航项
 *   A2  「免费通道 · 一键默认设置」卡在场
 *   A3  卡上按钮文案 = 「一键默认设置」且可点
 *   A4  额度行读到了（本地单人模式 ⇒ 「本地模式：不计入免费额度」，与 `GET /quota` 的 `limited:false` 对齐）
 *   A5  ★ 绑到**有候选的服务商**的那一行渲染**真 `<select>`**，且候选里有假上游返回的模型名
 *   A6  「（用默认模型）」这个选项在场（留空＝走 env/常量回落，是合法状态不是"没填"）
 *   A7  ★★ 绑到**平台通道**的行**没有**下拉、是输入框（＝免费通道未配 key 时的真实观感，见文件头）
 *   A8  ★ 反向不变量：**没有**任何 `.settings-model-input` 手填框（空模型不许被当成「自定义…」）
 *   A9-0  ★★ 首屏点一下**只进确认态**（出现「确认覆盖」+「取消」），且**没有**发出配置
 *   A9-0b ★ 代价说明点名后果（覆盖 / 模型名 / 8 个角色）
 *   A9-0c ★★ **取消干净回退**且**没有任何成功提示**（二次确认存在的全部意义）
 *   A9-0d 取消之后还能再进确认态（不是一次性状态）
 *   A9   点「确认覆盖」⇒ 提示「已一键配好 8 个角色」，且按钮**复位解禁**（不是只能点一次）
 *   A9c-b ★ 成功后确认态收干净（确认键与代价说明都消失）
 *   A10 ★ 覆盖语义实证：点之前某角色绑的是"假上游 + 指定模型"，点之后被重置为"平台 + 留空"
 *   A11 ★ 反向不变量：卡上**没有任何**「显示/复制密钥」入口（老板：key 用户不可见、也取不到）
 *
 * ★★ **2026-09-21 起按钮是两段式的**（老板拍板「一键默认加二次确认」）：单击只进确认态、
 *   点「确认覆盖」才真动手 ⇒ 本探针的 A9 段必须走完整流程。若发现 A9b/A9d 红而 A9-0 绿，
 *   先怀疑**探针自己**还在按旧的单击语义写，别急着判产品坏了。
 *
 * ★ 副作用声明（**只对隔离实例**）：本探针会**真的写库**（建 1 个 provider、改 1 条 role_binding、
 *   点一次一键默认设置），故 `SB_DATA_DIR` 指向 `mkdtemp` 出来的临时目录，**绝不碰真实库**；
 *   同时它会拉起一个**本地假上游**（只回答 `/models`）与一个隔离后端 + 一个 vite 开发服，
 *   跑完全部杀掉、临时目录删除。**不会**调用任何真实模型（假上游只回模型名列表，不接 chat）。
 *
 * 前置：本机装有 Chromium 系浏览器（Chrome 或 Edge）；仓内 `node_modules` 已装（要 `tsx` 与 `vite`）。
 * 端口：后端/vite/假上游/CDP 全部**随机**（起 Chrome 前先探 CDP 端口占用，被占就拒绝跑）。
 * 用法：node tools/probes/settings-platform-cdp.mjs
 *   可选：SB_SHOT_DIR=<目录> 截图落点（缺省系统临时目录，**不入仓**）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = process.env.SB_SHOT_DIR ?? join(tmpdir(), 'cdp-shots');
const PROFILE = join(tmpdir(), `cdp-settings-${Date.now()}`);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sb-settings-probe-'));
mkdirSync(SHOTS, { recursive: true });

const pick = (base) => base + Math.floor(Math.random() * 200);
const API_PORT = pick(18820);
const WEB_PORT = pick(5190);
const STUB_PORT = pick(19900);
const CDP_PORT = Number(process.env.SB_CDP_PORT ?? pick(9300));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killed = [];
const killTree = (child) => {
  if (!child?.pid) return;
  killed.push(child.pid);
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
};
const cleanup = () => {
  for (const pid of killed) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch {}
  }
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
};

// ── 浏览器（Chrome 优先，回落 Edge；都没有就直接说清楚，不假装跑过）────────────
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const BROWSER = BROWSERS.find((p) => existsSync(p));
if (!BROWSER) {
  console.error('✗ 没找到 Chrome/Edge —— 本探针需要真浏览器，拒绝假装跑过');
  process.exit(2);
}

const checks = [];
const skips = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const skip = (name, why) => {
  skips.push({ name, why });
  console.log(`SKIP  ${name}  （${why}）`);
};

/** 假上游：只实现 `GET /v1/models`（`listModels` 打的就是这个路径）。★ 不实现 chat ⇒ 探针零模型调用。 */
const STUB_MODELS = ['agnes-2.5-flash', 'agnes-2.5-pro', 'gpt-4o-mini'];
const stub = createServer((req, res) => {
  if (req.url?.includes('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: STUB_MODELS.map((id) => ({ id, object: 'model' })) }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"probe stub: only /models is implemented"}');
});

// ── 起三件套：假上游 → 隔离后端 → vite ────────────────────────────────────────
await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r));
console.log(`stub upstream  http://127.0.0.1:${STUB_PORT}/v1/models  ->  ${STUB_MODELS.join(', ')}`);

const api = spawn('npm', ['run', 'start', '-w', '@sb/server'], {
  cwd: ROOT,
  shell: true,
  stdio: 'ignore',
  env: { ...process.env, SB_PORT: String(API_PORT), SB_DATA_DIR: DATA_DIR, SB_HOST: '127.0.0.1' },
});
killed.push(api.pid);

// ★ vite 直接起（`npx vite`），不走 `npm run dev:web -- --port N`：
//   npm 的 `--` 透传在本仓会把 `--port 5199` 变成**位置参数**（实测变成 `vite 5199`），
//   于是端口设置被静默忽略、vite 去抢默认的 5173（而 5173 常常已被开发中的实例占着）。
// ★ `--host 127.0.0.1`：不显式指定时 vite 绑 `localhost`，Windows 上可能只落 `[::1]`
//   ⇒ 探针 `fetch('http://127.0.0.1:port')` 会连不上（症状像"前端没起来"，实为绑定地址问题）。
const webFree = await (async () => { try { await fetch(`http://127.0.0.1:${WEB_PORT}/`); return false; } catch { return true; } })();
if (!webFree) { console.error(`端口 ${WEB_PORT} 已被占用，拒绝继续`); cleanup(); process.exit(2); }
const web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: join(ROOT, 'packages/web'),
  shell: true,
  stdio: 'ignore',
  env: { ...process.env, SB_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
});
killed.push(web.pid);

const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}/`;
const up = async (url, ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
};
if (!(await up(`${API}/api/health`))) { console.error('✗ 隔离后端没起来'); cleanup(); process.exit(1); }
console.log(`backend        ${API}  (SB_DATA_DIR=${DATA_DIR})`);
if (!(await up(WEB))) { console.error('✗ vite 没起来'); cleanup(); process.exit(1); }
console.log(`web            ${WEB}`);

// ── 造数据（全部走 HTTP，等价于用户在界面上做的事）────────────────────────────
// ★ 写操作必须带 `Origin`（`security.ts#originCheck`：**无 Origin 的写请求一律 403**，SEC-09）。
//   探针是 Node fetch、默认不带 Origin ⇒ 不加这一行会得到「Forbidden: missing or disallowed origin」，
//   而那看起来像"后端没实现这个接口"，其实是我们没按浏览器的方式发请求。
const j = async (path, init) => {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Origin: `http://127.0.0.1:${WEB_PORT}`,
      ...(init?.headers ?? {}),
    },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const created = await j('/api/providers', {
  method: 'POST',
  body: JSON.stringify({ name: '探针假上游', baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, apiKey: 'sk-probe', type: 'openai' }),
});
const stubId = created.body?.id;
if (!stubId) { console.error('✗ 建 provider 失败', created); cleanup(); process.exit(1); }
const listed = await j(`/api/providers/${stubId}/models`);
console.log(`假上游候选    ${JSON.stringify(listed.body)}`);

// 把 explain 绑到假上游 + 指定一个模型：① 让那一行**有候选**（A5）；② 给 A10 的"覆盖"造出可观察的旧值
await j('/api/providers/roles/explain', {
  method: 'PUT',
  body: JSON.stringify({ providerId: stubId, model: 'agnes-2.5-pro' }),
});

// ── CDP ──────────────────────────────────────────────────────────────────────
const stale = await (async () => { try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok; } catch { return false; } })();
if (stale) { console.error(`端口 ${CDP_PORT} 已有 CDP 实例，拒绝继续（换 SB_CDP_PORT）`); cleanup(); process.exit(2); }

const chrome = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });
killed.push(chrome.pid);

let version = null;
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch {}
  await sleep(250);
}
if (!version) { console.error('✗ CDP 未就绪'); cleanup(); process.exit(1); }

const created2 = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(WEB)}`, { method: 'PUT' })).json();
const ws = new WebSocket(created2.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const myId = ++id; pending.set(myId, (m) => res(m.result ?? m.error));
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const evalJs = async (expression) =>
  (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
const waitFor = async (expr, timeoutMs, intervalMs = 200) => {
  const end = Date.now() + timeoutMs; let last = null;
  while (Date.now() < end) { last = await evalJs(expr); if (last) return last; await sleep(intervalMs); }
  return last;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const f = join(SHOTS, `${name}.png`);
  writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log('shot ->', f);
};

await send('Page.enable'); await send('Runtime.enable');

// ── A1 应用壳（不是落地页）────────────────────────────────────────────────────
// ★ 别用「固定 sleep N 秒再断言」：首屏挂载时间不定，早一步就会把「还没挂载」误判成「没渲染」。
//   实测踩过：固定 3 秒后 `innerText` 还是空、A1/A2 双红，而截图里应用壳明明好好的。
const shellUp = await waitFor(
  `document.body.innerText.includes('词条') && document.body.innerText.includes('设置')`,
  30_000,
  300,
);
check('A1 应用壳渲染（本地形态免登录直进）', !!shellUp, '侧栏含「词条」「设置」');

// 进设置页：按**文案**定位（不写死 nth-child —— 侧栏项顺序会变）。
// ★ 只在 button/a/li 里找：找到外层 div 点下去不会触发 React 的 onClick（看着像"点了没反应"）
await evalJs(`(() => {
  const el = [...document.querySelectorAll('button,a,li')].find((n) => n.textContent.trim() === '设置');
  if (el) el.click();
  return !!el;
})()`);
const cardUp = await waitFor(`!!document.querySelector('h3') && /免费通道/.test(document.body.innerText)`, 15_000);
check('A2 「免费通道 · 一键默认设置」卡在场', !!cardUp);
if (!cardUp) { await shot('settings-nocard'); cleanup(); ws.close(); process.exit(1); }

// 等候选拉完（SettingsView 开屏会为每个 provider 拉一次 /models）
await waitFor(`document.querySelectorAll('select.settings-model-select').length > 0`, 15_000, 300);
await sleep(1200);

// ── A3 按钮 ──────────────────────────────────────────────────────────────────
const btn = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '一键默认设置');
  return b ? JSON.stringify({ t: b.textContent.trim(), d: !!b.disabled }) : null;
})()`);
check('A3 一键默认设置按钮在场且可点', !!btn && JSON.parse(btn).d === false, btn ?? '未找到');

// ── A4 额度行 ────────────────────────────────────────────────────────────────
const stateText = await evalJs(`(() => {
  const s = document.querySelector('.settings-state');
  return s ? s.textContent.trim() : null;
})()`);
check('A4 额度行已读到（本地模式：不计入免费额度）', stateText === '本地模式：不计入免费额度', stateText ?? '未找到');

// ── A5/A6 有候选的那一行：真下拉 + 候选 + 「（用默认模型）」──────────────────────
const selInfo = await evalJs(`(() => {
  const s = document.querySelector('select.settings-model-select');
  if (!s) return null;
  return JSON.stringify({ n: document.querySelectorAll('select.settings-model-select').length,
    opts: [...s.options].map((o) => o.textContent), value: s.value });
})()`);
const sel = selInfo ? JSON.parse(selInfo) : null;
check('A5 ★ 有候选的服务商那一行渲染真 <select>', !!sel, sel ? `${sel.n} 个下拉` : '一个都没有');
check('A5b 候选里有假上游返回的模型名', !!sel && STUB_MODELS.every((m) => sel.opts.includes(m)),
  sel ? sel.opts.join(' | ') : '—');
check('A6 「（用默认模型）」选项在场', !!sel && sel.opts.includes('（用默认模型）'), sel ? sel.value : '—');

// ── A7 平台通道那几行：没有下拉（现状事实，见文件头）───────────────────────────
const inputs = await evalJs(`document.querySelectorAll('input[placeholder="模型名（没拉到候选列表，可手填）"]').length`);
check('A7 ★★ 绑平台通道的行是输入框（未配 key ⇒ 平台拉不到候选）', inputs === 7, `${inputs} 个输入框（期望 7）`);

// ── A8 反向：不许出现手填框（空模型 ≠ 自定义）─────────────────────────────────
const customInputs = await evalJs(`document.querySelectorAll('.settings-model-input').length`);
check('A8 ★ 反向：没有任何「自定义…」手填框', customInputs === 0, `${customInputs} 个`);
const customSelected = await evalJs(`[...document.querySelectorAll('select.settings-model-select')].filter((s) => s.value === '__custom__').length`);
check('A8b ★ 反向：下拉没有显示成「自定义…」', customSelected === 0, `${customSelected} 个`);

await shot('settings-before');

// ── A9 点一键默认设置（★ 2026-09-21 起是**两段式**：首屏那枚只进确认态，确认键才真动手）──
// ★★ 探针必须跟着改：本批给按钮加了二次确认 ⇒ 「一键默认设置」**单击不再触发配置**。
//   若探针还按单击写，A9b/A9d 会红——那是**探针过时**，不是产品坏了（同型先例见文件头：
//   「探针的错要自己认，不能记到产品头上」）。故本段改成完整走一遍真机确认流程：
//   首屏 → 确认态 → **取消（不许配）** → 再进确认态 → 确认（才配）。
const clickBtn = (text) =>
  evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
    if (b) b.click();
    return !!b;
  })()`);

const readCard = () =>
  evalJs(`(() => {
    const idle = [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '一键默认设置');
    const ok = [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '确认覆盖');
    const cancel = [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '取消');
    return JSON.stringify({ idle, ok, cancel,
      warn: document.querySelector('.settings-hint.warn')?.textContent?.trim() ?? '',
      flash: document.querySelector('.settings-msg')?.textContent?.trim() ?? '' });
  })()`);

/** 轮询直到 `pred(read)` 为真（或超时），返回最后那次读数。 */
const until = async (pred, ms = 5_000) => {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = JSON.parse((await readCard()) ?? '{}');
    if (pred(last)) return last;
    await sleep(60);
  }
  return last;
};

await clickBtn('一键默认设置');
const confirmState = await until((o) => o.ok === true);
check('A9-0 ★★ 首屏点一下只进确认态：出现「确认覆盖」+「取消」，且**没有**发出配置（无成功提示）',
  !!confirmState && confirmState.cancel === true && !/已一键配好/.test(confirmState.flash ?? ''),
  confirmState ? `确认键=${confirmState.ok} 取消键=${confirmState.cancel} flash="${confirmState.flash}"` : '确认态未出现');
check('A9-0b ★ 代价说明点名后果（覆盖 / 模型名 / 8 个角色）',
  !!confirmState && /覆盖/.test(confirmState.warn) && /模型名/.test(confirmState.warn) && /8 个角色/.test(confirmState.warn),
  confirmState?.warn || '未找到 .settings-hint.warn');

// ★★ A9-0c：**取消必须真的什么都不做**。这是二次确认存在的全部意义——
//    若取消也会配（或取消后残留确认态），用户会以为"点了取消但还是改了"，比不加确认更糟。
await clickBtn('取消');
const afterCancel = await until((o) => o.idle === true && o.ok === false);
check('A9-0c ★★ 取消干净回退：回「一键默认设置」、确认键与代价说明消失、**没有任何成功提示**',
  !!afterCancel && afterCancel.ok === false && !/已一键配好/.test(afterCancel.flash ?? '') && afterCancel.warn === '',
  JSON.stringify(afterCancel));

await clickBtn('一键默认设置');
const reConfirm = await until((o) => o.ok === true);
check('A9-0d 取消之后还能再进确认态（不是一次性状态）', !!reConfirm && reConfirm.ok === true, JSON.stringify(reConfirm));

await clickBtn('确认覆盖');
// 「在途态」按 §5：操作可能比采样还快 ⇒ 同时看"结果出没出"，采不到就 SKIP 而不是判 FAIL
let busySeen = null;
const done = await (async () => {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const o = JSON.parse(await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /一键默认设置|配置中/.test(x.textContent));
      return JSON.stringify({ t: b ? b.textContent.trim() : null, d: b ? !!b.disabled : null,
        flash: document.querySelector('.settings-msg')?.textContent?.trim() ?? '' });
    })()`) ?? '{}');
    if (o.t && o.t.includes('配置中')) { busySeen = o; await sleep(60); continue; }
    if (/已一键配好/.test(o.flash ?? '')) return o;
    await sleep(80);
  }
  return null;
})();
if (busySeen) check('A9a 在途态：按钮转「配置中…」且禁用', busySeen.d === true, busySeen.t);
else skip('A9a 在途态：按钮转「配置中…」且禁用', '操作在首次采样前已完成，在途态无从观测');
check('A9b 提示文案报出配好的角色数', !!done && /已一键配好 8 个角色/.test(done.flash ?? ''), done?.flash ?? '未捕获到提示');

const after = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '一键默认设置');
  return JSON.stringify({ t: b ? b.textContent.trim() : null, d: b ? !!b.disabled : null,
    confirmLeft: [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '确认覆盖'),
    warn: document.querySelector('.settings-hint.warn')?.textContent?.trim() ?? '',
    selects: document.querySelectorAll('select.settings-model-select').length,
    inputs: document.querySelectorAll('input[placeholder="模型名（没拉到候选列表，可手填）"]').length });
})()`);
const a = after ? JSON.parse(after) : null;
check('A9c ★ 按钮复位解禁（不是只能点一次）', !!a && a.t === '一键默认设置' && a.d === false, JSON.stringify(a));
// ★ 成功之后确认态必须收干净：留着「确认覆盖」或那句代价说明，用户会以为"还没配完"
check('A9c-b ★ 成功后确认态收干净（确认键与代价说明都消失）',
  !!a && a.confirmLeft === false && a.warn === '', JSON.stringify({ confirmLeft: a?.confirmLeft, warn: a?.warn }));
check('A9d 8 行全部改绑平台通道（下拉消失 ⇒ 全变输入框）', !!a && a.selects === 0 && a.inputs === 8, JSON.stringify(a));

// ── A10 覆盖语义实证 + 真落库 ────────────────────────────────────────────────
// ★ 读取形状：`GET /roles` 回的是 `{ roles, bindings }`，**不是数组**（`roles` 是 8 个角色的
//   定义，`bindings` 才是落库的绑定）。字段是 **snake_case**（`provider_id`）。
//   首轮探针按数组读 ⇒ 恒得 `null` / `? 行`，是**探针自己的形状错**，不是产品缺陷。
const roles = await j('/api/providers/roles');
const bindings = roles.body?.bindings;
const explain = Array.isArray(bindings) ? bindings.find((r) => r.role === 'explain') : null;
const allPlatform =
  Array.isArray(bindings) && bindings.length === 8 && bindings.every((r) => r.model === '');
check('A10 ★ 覆盖语义：explain 从「假上游 + agnes-2.5-pro」被重置为「平台 + 留空」',
  !!explain && explain.provider_id !== stubId && explain.model === '', JSON.stringify(explain));
check('A10b 真落库：8 行 model 全为空串', allPlatform, `${Array.isArray(bindings) ? bindings.length : '?'} 行`);

// ── A11 反向：卡上没有任何"看/复制密钥"入口 ──────────────────────────────────
const keyEntry = await evalJs(`(() => {
  const sec = [...document.querySelectorAll('section.settings-sec')].find((s) => /一键默认设置/.test(s.textContent));
  if (!sec) return 'no-section';
  return [...sec.querySelectorAll('button,a')].map((n) => n.textContent.trim()).join(' | ');
})()`);
check('A11 ★ 反向：卡上没有任何「显示/复制密钥」入口', keyEntry === '一键默认设置', keyEntry);

await shot('settings-after');

// ── 收尾 ─────────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.pass);
console.log(`\n${failed.length ? `FAILED ${failed.length}/${checks.length}` : `DONE ${checks.length}/${checks.length} 全过`}` +
  (skips.length ? `（${skips.length} 条无从观测）` : ''));
ws.close(); cleanup(); await sleep(600);
process.exit(failed.length ? 1 : 0);
