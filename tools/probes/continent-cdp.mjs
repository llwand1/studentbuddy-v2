/**
 * continent-cdp — 知识大陆「优化批」的**真机验收探针**（零依赖：Node 22 fetch + WebSocket 直驱 CDP）。
 *
 * ★ 为什么必须有它（本仓的账）：这一批全在 canvas 里——走位、领地、宝箱、特效**一个 DOM 都不给**，
 *   jsdom + `*.test.ts` 只能证明"源码里有这段指令"，证明不了"真样式算出来它真的在那一格"。
 *   本仓 B-020 的通则写得很清楚：**动效取证必须带几何断言**（截图只能证明"这一帧有没有东西"）。
 *   故本探针的判据全是**运行态量出来的**：canvas 像素质心 / 格块均色 / 真实事件驱动的状态变化。
 *
 * ★ 它测的是**真产品**：走 vite 页面 ＋ 真 `/api/*` 写口 ⇒ 组件怎么拼、地图怎么画，探针就怎么量。
 *
 * ★ 五组断言（对应验收单）：
 *   ① 地图形态：canvas 尺寸、头部五项统计、四类像素（草/领地/怪/英雄）都在场
 *   ② 英雄走位：键盘步进、点地寻路（多步排队）、走到怪旁边才开打、被挡要说话（ADR-5 禁静默）
 *   ③ 领地：真的扩散出来了（格数 ≥2）、领地格与草地**像素可辨**、点领地＝打领主
 *   ④ 宝箱：答对全部题目 ⇒ 地上留箱 ＋ banner ＋ 像素；点它走 `POST /api/cards/chest/open`
 *   ⑤ 情景题：题型标签/情境框/血条点数与 `shared/continent.ts` 的派生**逐项对齐**
 *
 * ★ 关于「探针自己算一遍哈希」这件事（诚实说明）：要**确定性地**选中一只"1 级＝情景题"的怪，
 *   只能在 Node 侧按 `continentHash`（FNV-1a 32 位）＋ `speciesTypes` 同式反推。这是**唯一**的
 *   复制点，且第 ⑤ 组会把屏上 `.continent-q-type` 的**实际标签**与反推值逐字对齐——那边一换哈希，
 *   本探针当场**断言失败**，不会静默漂移。
 *
 * 前置（**隔离实例，别对着真实数据目录跑**）：
 *   ① `SB_PORT=18911 SB_DATA_DIR=%TEMP%\sb-continent-acc npm run dev -w @sb/server`
 *   ② `SB_PROXY_TARGET=http://127.0.0.1:18911 node node_modules/vite/bin/vite.js --port 5301 --strictPort packages/web`
 *   ③ `SB_APP=http://localhost:5301/ SB_PROBE_DB=%TEMP%\sb-continent-acc\studentbuddy.db node tools/probes/continent-cdp.mjs`
 *      ⚠️ vite 在本机只绑 `[::1]`，`127.0.0.1:5301` 连不上而 `localhost` 能——所以默认用 `localhost`。
 *   截图落 `SB_SHOT_DIR`（缺省 `%TEMP%\sb-continent-shots`），**不入仓**。
 *   本探针会**写数据**：临时库里造词条／打复习／开箱，跑完把自己造的词条删掉。
 *
 * 退出码：全绿 0；任一不变量违例 1（打印 `RESULT: FAIL` ＋违例行）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.SB_APP ?? 'http://localhost:5301/';
const OUT = process.env.SB_SHOT_DIR ?? join(tmpdir(), 'sb-continent-shots');
const PORT = Number(process.env.SB_CDP_PORT) || 9700 + Math.floor(Math.random() * 200);
const VW = 1480;
const VH = 940;
const DOMAIN = '探针大陆域';
const PROBE_DB = process.env.SB_PROBE_DB ?? '';

/** 网格常量（与 `shared/continent.ts` 同值；探针只用来把格子换成像素坐标） */
const CELL = 48;
const COLS = 14;
const ROWS = 10;

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 派生口径的同式复制（见头注「诚实说明」）────────────────────────────────── */
const Q = ['judge', 'choice', 'fill', 'match', 'scene'];
const QLABEL = { judge: '判断题', choice: '选择题', fill: '填空题', match: '连线题', scene: '情景题' };
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const speciesOf = (id, level) =>
  Array.from({ length: level }, (_, i) => Q[fnv1a(`${id}#${i}`) % Q.length] ?? 'judge');
const levelOfStage = (stage) => Math.min(1 + Math.floor(Math.max(0, Math.trunc(stage)) / 2), 3);

const R = { fails: [], finds: [] };
const fail = (m) => R.fails.push(m);
const find = (m) => R.finds.push(m);

// 本机可能只有 Edge（实测老板机器无 Chrome）
const BROWSER = process.env.SB_CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync) || 'chrome';

// 起前先探端口：残留实例会连到别人的浏览器
try {
  const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.error(`端口 ${PORT} 上已有 CDP 实例（${j.Browser}）——拒绝继续。可 SB_CDP_PORT 换一个。`);
  process.exit(1);
} catch { /* 空着，可以用 */ }

const profile = join(tmpdir(), `sb-continent-cdp-${Date.now()}`);
const chrome = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${VW},${VH}`, '--force-device-scale-factor=2',
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 60 && !version; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) version = await r.json(); } catch { /* 还没起 */ }
  await sleep(250);
}
if (!version) { console.error('CDP 未就绪（浏览器没起来？SB_CHROME 指个可执行文件）'); chrome.kill(); process.exit(1); }
console.log('Browser =', version.Browser, '| APP =', APP);

const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pending.set(i, (m) => res(m.result ?? m.error)); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
await send('Page.enable');
await send('Runtime.enable');
await sleep(2500);   // 等 React 挂载（登录态＝本机单人模式，无需凭据）

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  if (!r?.data) { console.error('截图失败', JSON.stringify(r).slice(0, 160)); return; }
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('shot ->', file);
};

/** 页面侧工具箱：坐标换算 / 事件派发 / canvas 取像素。每次 reload 后重装（幂等）。 */
const install = async () => evalJs(`(() => {
  const cv = () => document.querySelector('.continent-map');
  const box = (r) => ({ left: r.left, top: r.top, w: r.width, h: r.height });
  const toXY = (row, col) => {
    const b = box(cv().getBoundingClientRect());
    return { x: b.left + ((col + 0.5) * b.w) / ${COLS}, y: b.top + ((row + 0.5) * b.h) / ${ROWS} };
  };
  const px = () => {
    const c = cv();
    return { w: c.width, h: c.height, d: c.getContext('2d').getImageData(0, 0, c.width, c.height).data };
  };
  window.__sbC = {
    ready: () => !!cv(),
    rect: () => box(cv().getBoundingClientRect()),
    hint: () => (document.querySelector('.continent-map-hint') || {}).textContent || '',
    hintWarn: () => !!document.querySelector('.continent-map-hint.warn'),
    banner: () => [...document.querySelectorAll('.continent-banner')].map((p) => p.textContent).join(' | '),
    stats: () => {
      const el = document.querySelector('.continent-stats');
      const txt = el ? el.innerText.replace(/\\s+/g, ' ') : '';
      const num = (label) => {
        const m = txt.match(new RegExp(label + '\\\\s*(\\\\d+)'));
        return m ? Number(m[1]) : null;
      };
      return { txt, total: num('词条'), inScope: num('已纳入复习'), monsters: num('待收复的怪'),
        lands: num('被占领的地'), codex: num('图鉴') };
    },
    hover: (row, col) => { const p = toXY(row, col); cv().dispatchEvent(new MouseEvent('mousemove', { clientX: p.x, clientY: p.y, bubbles: true })); return p; },
    /** ★ 必须把指针挪到 canvas **外**：React 的 onMouseLeave 是拿 mouseout 模拟的，直接派 mouseleave
       它收不到，悬停框会赖在最后那格上——而悬停框用的正是 hero 同一个色（#e8e9ee），会把英雄质心污染
       （首版就是这么量出"英雄在第 8 行第 12 列"的：那一格根本没有词条）。 */
    unhover: () => { const b = cv().getBoundingClientRect(); cv().dispatchEvent(new MouseEvent('mousemove', { clientX: b.left - 24, clientY: b.top - 24, bubbles: true })); },
    click: (row, col) => { const p = toXY(row, col); cv().dispatchEvent(new MouseEvent('click', { clientX: p.x, clientY: p.y, bubbles: true })); },
    /** 英雄质心（只认 hero 白 #e8e9ee）：先 unhover，否则悬停框是**同一个颜色**会污染质心 */
    hero: () => {
      const { w, d } = px();
      let n = 0, sx = 0, sy = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === 232 && d[i + 1] === 233 && d[i + 2] === 238) { const p = i / 4; n += 1; sx += p % w; sy += Math.floor(p / w); }
      }
      if (!n) return { n: 0, row: -1, col: -1 };
      return { n, row: Math.floor(sy / n / ${CELL}), col: Math.floor(sx / n / ${CELL}) };
    },
    /** 关键色的**精确**像素数（都是 globalAlpha=1 画的，故可精确匹配） */
    counts: () => {
      const { d } = px();
      const want = { hero: [232, 233, 238], body: [107, 74, 122], chest: [201, 138, 51] };
      const out = { hero: 0, body: 0, chest: 0 };
      for (let i = 0; i < d.length; i += 4) {
        for (const k of Object.keys(want)) {
          const t = want[k];
          if (d[i] === t[0] && d[i + 1] === t[1] && d[i + 2] === t[2]) out[k] += 1;
        }
      }
      return out;
    },
    /** 一格内区的均色（避开边界 4px，免得吃到邻格的抗锯齿） */
    cellMean: (row, col) => {
      const { w, d } = px();
      let n = 0, r = 0, g = 0, b = 0;
      for (let y = row * ${CELL} + 4; y < (row + 1) * ${CELL} - 4; y += 1) {
        for (let x = col * ${CELL} + 4; x < (col + 1) * ${CELL} - 4; x += 1) {
          const i = (y * w + x) * 4;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n += 1;
        }
      }
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
    },
    /** 帧指纹（每 7 个像素取一个，够灵敏也够便宜）：用来判"静止时画面到底还在不在动" */
    frameHash: () => {
      const { d } = px();
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i += 28) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; h ^= d[i + 1]; h = Math.imul(h, 0x01000193) >>> 0; }
      return h >>> 0;
    },
    nav: (label) => {
      const b = [...document.querySelectorAll('.sb-nav-item')].find((x) => x.textContent.includes(label));
      if (!b) return 'no-nav';
      b.click();
      return 'ok';
    },
  };
  return 'ok';
})()`);

const waitFor = async (expr, ms = 2500, step = 120) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evalJs(expr)) return true;
    await sleep(step);
  }
  return false;
};

/* ── 1. 造种子（走产品自己的写口）────────────────────────────────────────────
   ★ 想要"怪"就必须让词条 `review.status ∈ {due, overdue}` 且**在复习范围内**（`shared/continent.ts` 头注 2）。
   产品没有任何写口能把复习记到**过去某天**（`reviewed_day` 由服务端时钟写死），而"逾期几天"决定的正是
   领地大小——所以只能像 `cards-pixel-cdp.mjs` 那样**绕开写口直接改临时库的两个派生列**。
   ★ 三条护栏：① 只接受 `SB_PROBE_DB` 且必须在系统临时目录下；② 只动本源**自己刚造**的 id；
   ③ 探针末尾把自己造的词条全删掉。 */
const RUN = String(Date.now()).slice(-6);
const purge = await evalJs(`(async () => {
  const j = async (p, o) => (await fetch(p, o)).json();
  const all = await j('/api/terms/review/map');
  let n = 0;
  for (const t of (all.terms || [])) {
    if (String(t.term).indexOf('探针字号') === 0) { const r = await fetch('/api/terms/' + t.id, { method: 'DELETE' }); if (r.ok) n += 1; }
  }
  return n;
})()`);
console.log('清掉上次残留的探针词条 =', purge);

const makeBatch = async (n) => evalJs(`(async () => {
  const j = async (p, o) => (await fetch(p, o)).json();
  const made = [];
  for (let i = 0; i < ${n}; i += 1) {
    window.__sbSeq = (window.__sbSeq || 0) + 1;
    const k = window.__sbSeq;
    const term = '探针字号${RUN}-' + k;
    const definition = '探针释义第' + k + '号，长度八到十二个字上下。';
    const r = await j('/api/terms', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: term, definition: definition, domain: '${DOMAIN}' }) });
    if (r && r.id) made.push({ id: r.id, term: r.term, definition: r.definition });
  }
  return made;
})()`);

const all = [];
let sceneId = null;
for (let b = 0; b < 6 && !sceneId; b += 1) {
  const made = await makeBatch(6);
  if (!Array.isArray(made) || !made.length) { fail(`造词条写口没返回 id（第 ${b + 1} 批）：${JSON.stringify(made).slice(0, 120)}`); break; }
  all.push(...made);
  const hit = all.find((t) => speciesOf(t.id, 1)[0] === 'scene');
  sceneId = hit ? hit.id : null;
}
console.log('造出的词条 =', all.length, '｜情景题靶子 =', sceneId ? '找到了' : '没找到');

/* ★ 陪练词条（**必须晚于上面那批**）：`created_at` 升序→螺旋内圈，见 `shared/continent.ts` 的铺格序。
   为什么非灌不可：只种 6 条时，三只怪的领地（4 格）会把**全部**非怪词条格吃干净（`spreadLands`
   的「词条格优先」），可通行格归零 ⇒ 走位/点地/被挡三组验收全都没有落脚地（首版就是这么 FAIL 的）。
   灌到外圈后，怪的领地够不着它们，可通行格才留得下来。`SB_FILLER` 可调（默认 24）。 */
await sleep(1400);
const filler = await makeBatch(Number(process.env.SB_FILLER ?? 24));
if (Array.isArray(filler)) all.push(...filler);
console.log('陪练词条 =', Array.isArray(filler) ? filler.length : 0, '｜合计 =', all.length);
const byId = new Map(all.map((t) => [t.id, t]));
const others = all.filter((t) => t.id !== sceneId);

await evalJs(`(async () => {
  await fetch('/api/terms/review/scope', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain: '${DOMAIN}', enabled: true }) });
  return 'ok';
})()`);

/* 三只怪的档位（间隔表 [1,2,4,7,15,30,60]，stage 决定 level，逾期天数决定领地格数）：
   ① 情景题靶子：stage 0 ⇒ 1 级 1 题；逾期 4 天 ⇒ `landCountFor(4)=3`（含本体，即 2 格领地）
   ② 3 级怪：stage 4 ⇒ `monsterLevel(4)=3`；逾期 2 天 ⇒ 2 格
   ③ 2 级怪：stage 2 ⇒ 2 级；逾期 2 天 ⇒ 2 格
   ⇒ 期望 `被占领的地 = 4`（≥2 才算真的扩散出来了）*/
const plan = [
  { t: byId.get(sceneId), stage: 0, days: 5, level: 1 },
  { t: others[0], stage: 4, days: 17, level: 3 },
  { t: others[1], stage: 2, days: 6, level: 2 },
].filter((p) => p.t);

const norm = (p) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
let backdated = 0;
if (PROBE_DB && norm(PROBE_DB).startsWith(norm(realpathSync(tmpdir())))) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(PROBE_DB);
  db.pragma('busy_timeout = 4000');
  const upd = db.prepare('UPDATE term_library SET review_stage = ?, last_reviewed_at = datetime(\'now\', ?) WHERE id = ?');
  const run = db.transaction(() => {
    for (const p of plan) { upd.run(p.stage, `-${p.days} days`, p.t.id); backdated += 1; }
  });
  run();
  /* 每日钥匙账也归零：本探针每轮都会开掉一把，而「今天免费 3 次」两轮就见底 ⇒ 第三轮开箱按钮就灰了
     （首版正是这么把自己卡住的：`开箱按钮是灰的（钥匙用完了）`）。同上，只动临时库。 */
  const reset = db.prepare('UPDATE chest_keys SET free_used = 0, opened_today = 0').run();
  db.close();
  console.log(`改过的复习基准 = ${backdated} 条（临时库；stage/days = ${plan.map((p) => `${p.stage}/${p.days}`).join(', ')}）｜钥匙账归零 = ${reset.changes} 行`);
} else {
  fail(`没给 SB_PROBE_DB（或它不在临时目录下）⇒ 造不出"逾期"，怪与领地都验不了。给的是 ${PROBE_DB || '(空)'}`);
}

await evalJs(`location.reload()`);
await sleep(2800);
await install();
console.log('点「知识大陆」=', await evalJs(`window.__sbC.nav('知识大陆')`));
await sleep(1800);

/* ── 2. ① 地图形态 ─────────────────────────────────────────────────────────── */
const shape = await evalJs(`(() => {
  const b = window.__sbC.rect();
  const cv = document.querySelector('.continent-map');
  return { ok: window.__sbC.ready(), cssW: Math.round(b.w), cssH: Math.round(b.h),
    w: cv.width, h: cv.height, stats: window.__sbC.stats(), counts: window.__sbC.counts(),
    scrollable: document.documentElement.scrollHeight > window.innerHeight };
})()`);
console.log('地图形态 =', JSON.stringify(shape));
await shot('01-map');
if (!shape.ok) fail('地图没挂载：页面上找不到 .continent-map（侧栏入口没接？路由挂了？）');
if (shape.w !== COLS * CELL || shape.h !== ROWS * CELL) fail(`canvas 逻辑尺寸 = ${shape.w}×${shape.h}，应为 ${COLS * CELL}×${ROWS * CELL}`);
if (!shape.cssW || !shape.cssH) fail('canvas 的 CSS 尺寸为 0（被父盒压没了）');
if (shape.stats.monsters === null || shape.stats.lands === null) fail('头部统计缺项：待收复的怪 / 被占领的地 至少一个读不到');
if (!(shape.stats.monsters >= 3)) fail(`屏上怪数 = ${shape.stats.monsters}，种下 3 只却不到 3 —— "在范围内且到期"的闸门没生效`);
if (!(shape.stats.lands >= 2)) fail(`被占领的地 = ${shape.stats.lands}，领地扩散没出来（landCountFor ≥2 却没地）`);
if (shape.counts.hero < 40) fail(`英雄像素只有 ${shape.counts.hero} 个（<40）——英雄没画出来或被盖住`);
if (shape.counts.body < 40) fail(`怪体像素只有 ${shape.counts.body} 个（<40）——怪没画出来`);

/* ── 3. ② 英雄走位 ─────────────────────────────────────────────────────────── */
const cellKeyOf = (h) => `${h.row},${h.col}`;
/** 悬停扫全图：`.continent-map-hint` 是 `tileHint` 的**唯一文案源**，故探针不用自己算谁有怪/谁占了地 */
const sweep = await evalJs(`(async () => {
  const out = {};
  for (let row = 0; row < ${ROWS}; row += 1) {
    for (let col = 0; col < ${COLS}; col += 1) {
      window.__sbC.hover(row, col);
      await new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
      const t = window.__sbC.hint();
      let kind = 'empty';
      if (t.indexOf('级怪') >= 0) kind = 'monster';
      else if (t.indexOf('领地') >= 0) kind = 'land';
      else if (t.indexOf('已收复') >= 0) kind = 'normal';
      out[row + ',' + col] = { kind: kind, text: t };
    }
  }
  window.__sbC.unhover();
  return out;
})()`);
const kinds = Object.values(sweep ?? {});
const cnt = (k) => kinds.filter((v) => v.kind === k).length;
const grid = (row, col) => sweep?.[`${row},${col}`]?.kind ?? 'empty';
/** 悬停文案里的词条名。★ 必须**逐字相等**地比：探针字号…-1 是 …-13 的前缀，
    用 includes 的话「-1 那只怪」会被「-13 那只怪」抢走（首版就这么误判过一次等级）。 */
const hintTerm = (t) => {
  const s = String(t);
  return s.match(/^「([^」]+)」/)?.[1] ?? s.split('（')[0].trim();
};
console.log(`扫图 = 怪 ${cnt('monster')} 格 / 领地 ${cnt('land')} 格 / 可通行 ${cnt('normal')} 格 / 荒地 ${cnt('empty')} 格`);
if (cnt('monster') < 3) fail(`扫图只找到 ${cnt('monster')} 只怪（种下 3 只）——悬停文案与派生口径不一致`);
if (cnt('land') < 2) fail(`扫图只找到 ${cnt('land')} 格领地（头部说得 ≥2）——荒地上的领地没被画/没被命中`);
if (cnt('normal') < 3) fail(`可通行格只有 ${cnt('normal')} 格，走位验收没有落脚地`);

/** 等级从**悬停文案**（`tileHint` 的「N 级怪」）读回来，与 stage 的派生对齐——不必开弹窗就能验 */
for (const p of plan) {
  const hit = Object.entries(sweep ?? {}).find(([, v]) => v.kind === 'monster' && hintTerm(v.text) === p.t.term);
  if (!hit) { fail(`「${p.t.term}」没在地图上冒出来（stage=${p.stage} / 逾期 ${p.days} 天）`); continue; }
  const lv = Number(String(hit[1].text).match(/(\d+)\s*级怪/)?.[1]);
  if (lv !== p.level || p.level !== levelOfStage(p.stage)) {
    fail(`「${p.t.term}」屏上 ${lv} 级怪，stage=${p.stage} 应派生 ${levelOfStage(p.stage)} 级`);
  }
}
console.log('三只怪的等级派生 =', plan.map((p) => `${p.t.term}=${levelOfStage(p.stage)} 级`).join(' / '));

/* ── 走位工具：点一格 → 读排队提示 → 等它走到（后面三处都用它）──────────────
   ★ 为什么不自己推一条路径：路是产品自己的 `useContinentHero` 走出来的，探针只**观察结果**
   （照 B-020 的口径：断言落在"跑到没跑到"，不落在"猜它该怎么跑"）。 */
const waitHeroAt = async (row, col, ms = 12000) => {
  const t0 = Date.now();
  let h = await evalJs(`window.__sbC.hero()`);
  while (Date.now() - t0 < ms) {
    if (h.row === row && h.col === col) return h;
    await sleep(150);
    h = await evalJs(`window.__sbC.hero()`);
  }
  return h;
};
const walkToCell = async (row, col) => {
  await evalJs(`window.__sbC.click(${row}, ${col})`);
  await sleep(180);
  const note = await evalJs(`(document.querySelector('.continent-dpad-queue') || {}).textContent || ''`);
  await evalJs(`window.__sbC.unhover()`);   // 悬停框与英雄同色，不挪开会把质心算歪（见 unhover 注）
  const h = await waitHeroAt(row, col);
  return { note, landed: cellKeyOf(h), arrived: h.row === row && h.col === col };
};

/** 可通行格集合（悬停文案说「已收复」＝无怪、无领地归属）——探针不自己推一遍派生 */
const walkableSet = () => {
  const s = new Set();
  for (const k of Object.keys(sweep ?? {})) if (grid(...k.split(',').map(Number)) === 'normal') s.add(k);
  return s;
};
/** 走不到的格用 BFS 兜底：★ `useContinentHero.walkTo` 是**直线贪心**——被怪/领地挡在中间时它不绕路，
     会停在中途且**不提示**（首版两次判决都栽在这：点 (4,7) 停在 (6,8)）。BFS 出一条最短路再按键过去。 */
const bfsPath = (from, to, walkable) => {
  if (from === to) return [];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    const [r, c] = cur.split(',').map(Number);
    for (const [dr, dc, key] of [[-1, 0, 'ArrowUp'], [1, 0, 'ArrowDown'], [0, -1, 'ArrowLeft'], [0, 1, 'ArrowRight']]) {
      const nk = `${r + dr},${c + dc}`;
      if (!walkable.has(nk) || prev.has(nk)) continue;
      prev.set(nk, { from: cur, key });
      if (nk === to) {
        const path = [];
        let node = nk;
        while (prev.get(node)) { const p = prev.get(node); path.unshift(p.key); node = p.from; }
        return path;
      }
      queue.push(nk);
    }
  }
  return null;
};
/** 一格一格按键走完一条 BFS 路线 */
const walkByKeys = async (path) => {
  for (const key of path) {
    await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
    await sleep(200);
  }
  await sleep(350);
  await evalJs(`window.__sbC.unhover()`);
  return evalJs(`window.__sbC.hero()`);
};

await sleep(400);
await evalJs(`window.__sbC.unhover()`);
await sleep(200);
const hero0 = await evalJs(`window.__sbC.hero()`);
console.log('英雄起点 =', JSON.stringify(hero0));
if (!hero0.n) fail('英雄像素一个都没有（#e8e9ee）');

// 键盘走一步：向右（找一格可通行的方向，别一上来就撞领地）
const dirs = [['ArrowRight', 0, 1], ['ArrowLeft', 0, -1], ['ArrowDown', 1, 0], ['ArrowUp', -1, 0]];
let stepOk = null;
for (const [key, dr, dc] of dirs) {
  if (grid(hero0.row + dr, hero0.col + dc) !== 'normal') continue;
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
  await sleep(430);
  const h1 = await evalJs(`window.__sbC.hero()`);
  stepOk = { key, from: cellKeyOf(hero0), to: cellKeyOf(h1), moved: h1.row === hero0.row + dr && h1.col === hero0.col + dc };
  break;
}
console.log('键盘走一步 =', JSON.stringify(stepOk));
if (!stepOk) fail('英雄四邻没有一格可通行 —— 走位验收无从下手（种子太挤？）');
else if (!stepOk.moved) fail(`按 ${stepOk.key} 后英雄没走到相邻格（${stepOk.from} → ${stepOk.to}）`);
await shot('02-hero-step');

// 点地寻路：优先挑**同一直线上中间全可通行**的远格（贪心走直线必然成功，判据最干净）；行、列都找。
// ★ 一个都没有时（种子一变就可能如此）退而挑一个"离得远、且不在同一条直线上"的可通行格：
//   这时只硬判「点了要冒出排队提示」，到不到得了记为**发现**——因为 `walkTo` 是直线贪心，
//   正对着挡路的怪/领地时它不绕路，会停在中途且**不吭声**（见 `bfsPath` 注，前几轮实测栽过两次）。
const heroNow = await evalJs(`window.__sbC.hero()`);
const straightClear = (r, c) => {
  if (r !== heroNow.row && c !== heroNow.col) return false;
  if (r === heroNow.row) {
    for (let x = Math.min(c, heroNow.col); x <= Math.max(c, heroNow.col); x += 1) if (grid(r, x) !== 'normal') return false;
  } else {
    for (let y = Math.min(r, heroNow.row); y <= Math.max(r, heroNow.row); y += 1) if (grid(y, c) !== 'normal') return false;
  }
  return true;
};
const walkableCells = Object.keys(sweep ?? {})
  .filter((k) => grid(...k.split(',').map(Number)) === 'normal')
  .map((k) => { const [row, col] = k.split(',').map(Number); return { row, col, dist: Math.abs(row - heroNow.row) + Math.abs(col - heroNow.col) }; });
const lineTargets = walkableCells.filter((t) => t.dist >= 3 && straightClear(t.row, t.col)).sort((a, b) => b.dist - a.dist);
const bendTarget = walkableCells.filter((t) => t.dist >= 3 && !straightClear(t.row, t.col)).sort((a, b) => b.dist - a.dist)[0] ?? null;
const walkTarget = lineTargets[0] ?? bendTarget;
let walkObserved = null;
if (!walkTarget) {
  find('图上没有"离英雄 ≥3 格"的可通行格 ⇒ 点地寻路这一条没测到');
} else {
  walkObserved = { target: cellKeyOf(walkTarget), viaLine: lineTargets.length > 0, ...(await walkToCell(walkTarget.row, walkTarget.col)) };
  console.log('点地寻路 =', JSON.stringify(walkObserved));
  if (!/还要走\s*\d+\s*步/.test(walkObserved.note)) fail(`点地后没出现排队提示（D-pad 那行写着「${walkObserved.note}」）——多步寻路没接上`);
  if (!walkObserved.arrived) {
    if (walkObserved.viaLine) fail(`点地寻路没走到目标格（直线且中间全空）：目标 ${walkObserved.target}，落点 ${walkObserved.landed}`);
    else find(`点地寻路遇到挡路的怪/领地时**停在中途且不吭声**：从 ${cellKeyOf(heroNow)} 点 ${walkObserved.target}，英雄停在 ${walkObserved.landed}，提示行也没报「走不到」。`);
  }
  await shot('02b-walk-to');

  // 被挡要说话（ADR-5 禁静默）：朝一个**不可通行**的方向按一次
  // ★ 就近取值、不挪位：荒地（没铺词条的格）本身就是不可通行的（`walkableAt` 要求格子在 tiles 里），
  //   而 140 格里只有 30+4 格被占 ⇒ 英雄四邻里几乎必然有荒地。优先挑怪本体/领地（语义更贴"挡路"）。
  const now1 = await evalJs(`window.__sbC.hero()`);
  let blocked = null;
  for (const want of ['monster', 'land', null]) {
    for (const [key, dr, dc] of dirs) {
      const into = `${now1.row + dr},${now1.col + dc}`;
      const kind = grid(now1.row + dr, now1.col + dc);
      if (want ? kind !== want : kind === 'normal') continue;
      await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true }))`);
      await sleep(420);
      blocked = { key, into, kind, warn: await evalJs(`window.__sbC.hintWarn()`), text: await evalJs(`window.__sbC.hint()`) };
      break;
    }
    if (blocked) break;
  }
  console.log('被挡提示 =', JSON.stringify(blocked));
  if (!blocked) find('英雄四邻都是可通行格 ⇒ "被挡要说话"这一条这轮没测到');
  else if (!blocked.warn) fail(`朝${blocked.kind === 'land' ? '领地' : blocked.kind === 'monster' ? '怪本体' : '荒地'}（${blocked.into}）走被挡住却**没有任何提示**（静默卡死，ADR-5 违例）`);
  else if (!/走不过去|走不到/.test(blocked.text)) fail(`被挡提示的文案不对：「${blocked.text}」`);
  await shot('03-blocked');
}

/* ── 4. ③ 领地 ─────────────────────────────────────────────────────────────── */
const landCell = Object.entries(sweep ?? {}).find(([, v]) => v.kind === 'land');
const landXY = landCell ? landCell[0].split(',').map(Number) : null;
const normalCell = Object.entries(sweep ?? {}).find(([, v]) => v.kind === 'normal');
const normalXY = normalCell ? normalCell[0].split(',').map(Number) : null;
if (!landXY || !normalXY) {
  find('扫图里没有同时出现"领地格"与"可通行格" ⇒ 领地像素对比这一条没测到');
} else {
  const landMean = await evalJs(`window.__sbC.cellMean(${landXY[0]}, ${landXY[1]})`);
  const grassMean = await evalJs(`window.__sbC.cellMean(${normalXY[0]}, ${normalXY[1]})`);
  const distinguishable = landMean.r > landMean.g && grassMean.g > grassMean.r;
  console.log(`领地格 (${landXY}) 均色 =`, JSON.stringify(landMean), '｜可通行格均色 =', JSON.stringify(grassMean), '｜可辨 =', distinguishable);
  if (!distinguishable) fail(`领地格与草格**像素上分不出来**（领地 ${JSON.stringify(landMean)} / 草 ${JSON.stringify(grassMean)}）——占领区没有视觉载体`);
}

// 点领地 = 打领主（不要求相邻，照抄 demo 的 review_unlock）
const landOwner = landCell ? String(landCell[1].text).match(/「([^」]+)」/)?.[1] ?? null : null;
let landDialog = null;
if (landXY) {
  await evalJs(`window.__sbC.click(${landXY[0]}, ${landXY[1]})`);
  await sleep(700);
  landDialog = await evalJs(`(() => {
    const d = document.querySelector('.continent-modal, .continent-detail');
    return d ? { label: d.getAttribute('aria-label') || '', text: d.innerText.replace(/\\s+/g, ' ').slice(0, 160) } : null;
  })()`);
}
console.log('点领地 =', JSON.stringify(landDialog), '｜领主 =', landOwner);
if (!landDialog) fail(`点领地格 ${landXY} 什么都没发生（静默死路）`);
else if (!/复习/.test(landDialog.label)) fail(`点领地没开打领主（弹的是「${landDialog.label || landDialog.text}」）`);
else if (landOwner && !landDialog.label.includes(landOwner)) fail(`点领地开打的是别的词条：屏上「${landDialog.label}」，领地归属是「${landOwner}」`);
else await shot('04-land-strike');
// 关掉领地弹窗（不答题，领地要留到后面量）
await evalJs(`(() => { const b = [...document.querySelectorAll('.continent-btn')].find((x) => x.textContent.trim() === '关闭'); if (b) b.click(); return 'ok'; })()`);
await sleep(400);

/* ── 5. ⑤ 情景题（先把靶子谈下来，再顺手验 ④ 宝箱）────────────────────────── */
const target = plan[0] ?? { t: { id: '', term: '（种子没成，无靶子）', definition: '' }, level: 1 };
const targetCell = Object.entries(sweep ?? {}).find(([, v]) => v.kind === 'monster' && hintTerm(v.text) === target.t.term);
const monsterCell = targetCell ? targetCell[0].split(',').map(Number) : null;
console.log('情景题靶子格 =', monsterCell, '｜期望题型序列 =', speciesOf(target.t.id, 1).join('+'));
if (!monsterCell) {
  fail(`扫图里没找到「${target.t.term}」这只怪（种下去了却没冒出来？）`);
} else {
  /** 走到怪旁边：在**可通行格**上 BFS 出一条最短路，再一格一格按键过去
      （不走点地寻路：`walkTo` 是直线贪心，绕不过挡在中间的领地/怪，会停在中途且不提示——见 `bfsPath` 注） */
  const heroBefore = await evalJs(`window.__sbC.hero()`);
  const walkable = walkableSet();
  const from0 = cellKeyOf(heroBefore);
  const goals = [[-1, 0], [1, 0], [0, -1], [0, 1]]
    .map(([dr, dc]) => `${monsterCell[0] + dr},${monsterCell[1] + dc}`)
    .filter((k) => walkable.has(k));
  const routes = goals.map((k) => ({ k, path: bfsPath(from0, k, walkable) })).filter((r) => r.path);
  routes.sort((a, b) => a.path.length - b.path.length);
  console.log(`走到怪旁边：起点 ${from0}｜可落脚邻格 = ${goals.join(' ') || '(无)'}｜选定 = ${routes[0] ? `${routes[0].k}（${routes[0].path.length} 步）` : '(无路可走)'}`);
  const heroNear = routes[0] ? await walkByKeys(routes[0].path) : heroBefore;
  const adjacent = Math.abs(heroNear.row - monsterCell[0]) + Math.abs(heroNear.col - monsterCell[1]) <= 1;
  console.log('走到怪旁边 =', JSON.stringify(heroNear), '｜相邻 =', adjacent);

  await evalJs(`window.__sbC.click(${monsterCell[0]}, ${monsterCell[1]})`);
  await sleep(700);
  const dialog = await evalJs(`(() => {
    const d = document.querySelector('.continent-modal[aria-label^="复习"]');
    if (!d) return null;
    return { label: d.getAttribute('aria-label'),
      title: (d.querySelector('.continent-modal-title') || {}).innerText || '',
      type: (d.querySelector('.continent-q-type') || {}).textContent || '',
      frame: (d.querySelector('.continent-q-frame') || {}).textContent || '',
      hp: d.querySelectorAll('.continent-hp-dot').length };
  })()`);
  console.log('打怪弹窗 =', JSON.stringify(dialog));
  if (!dialog) fail(`站在怪旁边点它没开打（相邻=${adjacent}，英雄 ${cellKeyOf(heroNear)}，怪 ${monsterCell}）`);
  else {
    const expect = speciesOf(target.t.id, 1);
    if (dialog.hp !== expect.length) fail(`血条点数 = ${dialog.hp}，等级/题数应为 ${expect.length}`);
    if (dialog.type !== QLABEL[expect[0]]) fail(`屏上题型标签「${dialog.type}」，反推应为「${QLABEL[expect[0]]}」——题型序列口径漂了`);
    if (expect[0] === 'scene' && !dialog.frame) fail('情景题没有情境框（.continent-q-frame 为空）');
    await shot('05-monster-scene');

    // 答题：情景题＝选择题干 + 情境框，正确项就是这只怪自己的释义
    const solved = await evalJs(`(async () => {
      const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      const d = function () { return document.querySelector('.continent-modal[aria-label^="复习"]'); };
      const opts = [...d().querySelectorAll('.continent-opt')];
      const want = ${JSON.stringify(target.t.definition)};
      const hit = opts.find((b) => b.textContent.trim() === want) || opts[0];
      hit.click();
      await wait(80);
      const foot = [...d().querySelectorAll('.continent-btn')].find((b) => /提交|最后一击/.test(b.textContent));
      foot.click();
      await wait(900);
      return { gone: !d(), banner: [...document.querySelectorAll('.continent-banner')].map((p) => p.textContent).join(' | ') };
    })()`);
    console.log('答对之后 =', JSON.stringify(solved));
    if (!solved?.gone) fail('答对全部题目后弹窗没关（保存失败？题目没判对？）');

    /* ── 6. ④ 宝箱 ───────────────────────────────────────────────────────────── */
    await sleep(900);
    const after = await evalJs(`(() => ({ stats: window.__sbC.stats(), counts: window.__sbC.counts(), banner: window.__sbC.banner() }))()`);
    console.log('收复之后 =', JSON.stringify(after));
    if (!/宝箱/.test(after.banner)) fail(`打掉怪以后地上没有宝箱（banner：「${after.banner}」）`);
    if (after.counts.chest < 20) fail(`宝箱像素只有 ${after.counts.chest} 个（<20）——地上没画出箱子`);
    if (!(after.stats.monsters <= shape.stats.monsters - 1)) fail(`收复后怪数没减：${shape.stats.monsters} → ${after.stats.monsters}`);
    await shot('06-chest-drop');

    await evalJs(`window.__sbC.click(${monsterCell[0]}, ${monsterCell[1]})`);
    await sleep(800);
    const chestModal = await evalJs(`(() => {
      const d = document.querySelector('.continent-modal[aria-label="地图上的宝箱"]');
      if (!d) return null;
      return { text: d.innerText.replace(/\\s+/g, ' ').slice(0, 200),
        btn: [...d.querySelectorAll('.continent-btn')].map((b) => b.textContent.trim()).join('/') };
    })()`);
    console.log('宝箱弹窗 =', JSON.stringify(chestModal));
    if (!chestModal) fail('点地上的宝箱没开出「地图上的宝箱」（掉落物只画了个像素，点不动）');
    else {
      if (!/今天免费/.test(chestModal.text)) fail(`宝箱弹窗没读到钥匙账（转述的上游是「${chestModal.text}」）——没复用每日宝箱账本？`);
      await shot('07-chest-modal');
      const opened = await evalJs(`(async () => {
        const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        const d = document.querySelector('.continent-modal[aria-label="地图上的宝箱"]');
        const b = [...d.querySelectorAll('.continent-btn')].find((x) => /开一次|开满了|用完了/.test(x.textContent));
        if (!b) return { none: true, text: d.innerText.replace(/\\s+/g, ' ').slice(0, 160) };
        if (b.disabled) return { disabled: true, text: b.textContent };
        b.click();
        await wait(1200);
        return { ritual: !!document.querySelector('.gm-ritual'),
          overlay: (document.querySelector('.gm-ritual') || {}).innerText ? document.querySelector('.gm-ritual').innerText.replace(/\\s+/g, ' ').slice(0, 120) : '' };
      })()`);
      console.log('开箱 =', JSON.stringify(opened));
      if (opened?.none) fail(`宝箱弹窗里没有开箱按钮：${opened.text}`);
      else if (opened?.disabled) fail(`开箱按钮是灰的（${opened.text}）——临时库该有免费次数，这不是被测代码的问题，看 SB_DATA_DIR 是否干净`);
      else if (!opened?.ritual) fail('点开一次没起既有开盒仪式层（.gm-ritual 不在）——没用上每日宝箱那套？');
      else await shot('08-ritual');
    }
  }
}

/* ── 7. 静止时画面还在不在动（常驻演出的真机事实，非硬判据）────────────────────
   `ContinentMap` 的抽帧循环在"地形指纹不变 + 无特效 + 英雄不在走"时**主动停掉**（省电口径，见其文件头）。
   代价是：领地边界的"呼吸"与宝箱的"浮动"也一并冻住（它们都靠 `pulse`/`bob` 每帧重算）。
   本仓的口径是「先用真机量出来，再决定要不要改」，故这里只**如实记录**，不计入失败。 */
await evalJs(`location.reload()`);
await sleep(3000);
await install();
await evalJs(`window.__sbC.nav('知识大陆')`);
await sleep(3500);   // 等"长出来"的错峰动画跑完（STAGGER_CAP*STAGGER_MS + POP_MS ≈ 860ms）
await evalJs(`window.__sbC.unhover()`);
await sleep(600);
const f1 = await evalJs(`window.__sbC.frameHash()`);
await sleep(700);
const f2 = await evalJs(`window.__sbC.frameHash()`);
console.log(`静止 0.7 秒的前后帧指纹 = ${f1} / ${f2}｜${f1 === f2 ? '完全静止' : '仍在动'}`);
if (f1 === f2) find('静止约 1 秒后地图**完全不再重绘**：领地边界的"呼吸"与地上宝箱的"上下浮动"随之冻住（抽帧循环在无特效/无走位时停掉了）。要么给这两个常驻演出留一条持续重绘的判据，要么把文件头"常驻的静止演出"这句改掉。');

/* ── 8. prefers-reduced-motion 降级（只判"结果仍可见"，不判动效）──────────────── */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await send('Page.reload');
await sleep(2600);
await install();
await evalJs(`window.__sbC.nav('知识大陆')`);
await sleep(900);
const rm = await evalJs(`window.__sbC.counts()`);
console.log('减少动态效果下 =', JSON.stringify(rm));
if (!rm.hero) fail('prefers-reduced-motion 下降级**把英雄也丢了**（降级只该去运动，不该去结果）');
if (!rm.body) fail('prefers-reduced-motion 下怪也不画了（同上）');
await shot('09-reduced-motion');
await send('Emulation.setEmulatedMedia', { features: [] });

/* ── 9. 收尾：把自己造的词条删掉（含中途 reload 后残留的）────────────────────── */
const cleaned = await evalJs(`(async () => {
  const j = async (p, o) => (await fetch(p, o)).json();
  const all = await j('/api/terms/review/map');
  let n = 0;
  for (const t of (all.terms || [])) {
    if (String(t.term).indexOf('探针字号') === 0) { const r = await fetch('/api/terms/' + t.id, { method: 'DELETE' }); if (r.ok) n += 1; }
  }
  return n;
})()`);
console.log('删掉自造词条 =', cleaned);

/* ── 10. 判定 ──────────────────────────────────────────────────────────────── */
chrome.kill();
await sleep(600);   // 先杀进程再删 profile：Edge 锁着 CrashpadMetrics，边删边抛 EBUSY
try { rmSync(profile, { recursive: true, force: true }); } catch (e) { console.log('⚠️ profile 没删干净（不影响判定）：', e.code); }
writeFileSync(join(OUT, 'continent.json'), JSON.stringify({ shape, sweep, landDialog, walkObserved, finds: R.finds, fails: R.fails }, null, 1));
console.log('取证落盘 =', join(OUT, 'continent.json'), '| 截图目录 =', OUT);
for (const f of R.finds) console.log('⚠ 发现: ' + f);
if (R.fails.length) {
  console.log('RESULT: FAIL');
  for (const x of R.fails) console.log('  ✘ ' + x);
  process.exit(1);
}
console.log('RESULT: PASS');
process.exit(0);
