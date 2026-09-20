/**
 * tools/probes/landing-demo-cdp.mjs —— 落地页 hero 演示窗的**真机渲染核验**（2026-09-20 知识图演示批）
 *
 * 为什么要它（纯函数单测一个都锁不住的部分）：
 *   `graph-demo.test.ts` 锁的是「第几帧该出现几个节点/几条边」，`GraphDemo.test.tsx` 锁的是
 *   「`on` 类真的落到 DOM 上了没有」。但这两者都**看不见 CSS 生效之后的真实尺寸**，而本演示
 *   恰恰全靠尺寸：SVG 要按容器等比缩放、节点卡片要落在画布内、文字要装得进卡片。
 *   典型失败形态是「JS 全对、图被裁掉一个角」——单测全绿、肉眼一眼能看出，只有真机拦得住。
 *
 * 本探针断的是**几何事实**（getBoundingClientRect 相对于 SVG 视口），不是"我读过 CSS"：
 *   G1 演示窗在首屏内、不溢出舞台（`overflow:hidden` 会把越界悄悄吃掉）
 *   G2 hero 真的是**双栏**（文案与演示窗并排，而不是窄屏塌成上下堆叠）
 *   G3 每个节点卡片完整落在 SVG 视口内（等比缩放下越界即被裁）
 *   G4 任意两张卡片不相交
 *   G5 节点文字不溢出它的卡片（字号随缩放变小，溢出会糊成一团）
 *   F1..F5 五帧各自的 DOM 事实（节点数/边数/追问按钮/抽词清单/末帧转正与图例）
 *
 * 前置（这一节最容易白调半天）：
 *   ① **必须有一个在跑的前端 dev server**，且它的**代码是本次改动后的**。本探针只读页面，不起服务。
 *      自检一行：`curl -s "$URL/src/app/demo/registry.ts" | grep -c GRAPH_FLOW` ⇒ 应 ≥ 1。
 *   ② 本项目的 vite **只绑 IPv6 `[::1]`**：用 `http://localhost:5173/` 访问，写 `127.0.0.1` 会打到
 *      别处（若 shell 有 http_proxy，你会拿到代理的 **502 而不是连接失败**，极像"服务起了但报错"）。
 *      ★ 探针给浏览器加了 `--no-proxy-server`，页内请求不会被代理截走。
 *   ③ 未登录才会渲染落地页：`/api/auth/me` 返回 401 即可（`/api/auth/surface` 404 无妨，
 *      main.tsx 会按线上口径兜底 ⇒ 走 Landing）。
 *   ★③′ **本机后端默认是 `local` 单人形态**（`GET /api/auth/providers` → `{"form":"local"}`），
 *      此时**未登录也直进应用壳、落地页根本不出现**（`entryFor(null,'local')==='app'`，
 *      这是既定产品口径，不是 bug）。故本探针会在页面 JS 起来前**注入补丁**把该响应的
 *      `form` 掰成 `cloud`——只改这一个字段，不碰产品代码、不碰后端、不写库。
 *      排查"落地页怎么没出现"时先看这条，别去翻 Landing.tsx。
 *   ④ 本机若无 Chrome 用 Edge：`SB_CHROME="C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"`。
 *
 * 烧额度：**不烧**。演示数据全部前端写死，探针只读取页面 + 等 CSS transition，不调模型、不写库，
 *   因此**无需自清**（不改任何持久状态）。跑一次约 30 秒（五帧正好一个播放周期）。
 *
 * 用法：
 *   node tools/probes/landing-demo-cdp.mjs
 *   SB_URL=http://localhost:5174/ SB_CHROME=<浏览器路径> SB_SHOT_DIR=<截图目录> node tools/probes/landing-demo-cdp.mjs
 * 输出：逐条 ✓/✗ + 末尾 `DONE`，退出码 0 = 全绿。截图落 `SB_SHOT_DIR`（缺省系统临时目录，不入仓）。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_URL = process.env.SB_URL || 'http://localhost:5173/';
const SHOT_DIR = process.env.SB_SHOT_DIR || join(tmpdir(), 'sb-hero-shots');
const PORT = Number(process.env.SB_CDP_PORT) || 9300 + Math.floor(Math.random() * 400);
const VW = 1440;
const VH = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0;
let fail = 0;
const ck = (ok, label, detail) => {
  if (ok) {
    pass += 1;
    console.log(`    ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`    ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
};

// 起前先探端口：残留浏览器占着调试端口会连到别人的实例
try {
  const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.error(`端口 ${PORT} 上已有 CDP 实例（${j.Browser}）——拒绝继续，可 SB_CDP_PORT 换一个。`);
  process.exit(1);
} catch {
  /* 空着，可以用 */
}

const BROWSER = process.env.SB_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'sbprobe-'));
const chrome = spawn(
  BROWSER,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    // ★ 关键：否则浏览器可能走系统代理，本机端口会被代理回 502（见文件头前置②）
    '--no-proxy-server',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${VW},${VH}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ver = null;
for (let i = 0; i < 40 && !ver; i += 1) {
  try {
    ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    await sleep(250);
  }
}
if (!ver) {
  console.error('CDP 未就绪（浏览器没起来？检查 SB_CHROME 路径）');
  chrome.kill();
  process.exit(1);
}
console.log('浏览器 =', ver.Browser);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

const evalJs = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return m.result?.result?.value;
};

/** 轮询直到 `expr` 为真（不要固定 sleep 硬等） */
async function until(expr, maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await evalJs(expr)) return true;
    await sleep(150);
  }
  return false;
}

async function shot(name, selector) {
  const clip = await evalJs(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.max(0, b.x), y: Math.max(0, b.y), width: b.width, height: b.height, scale: 2 };
  })()`);
  if (!clip) return;
  const m = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  const data = m.result?.data;
  if (data) writeFileSync(join(SHOT_DIR, name), Buffer.from(data, 'base64'));
}

// ── 打开真实页面 ──
// ★★ 必须先注入「把部署形态掰成 cloud」的补丁，否则**根本看不到落地页**：
//   本机开发后端是 `local` 单人形态 ⇒ `/api/auth/providers` 回 `{"form":"local"}`
//   ⇒ `entryFor(null,'local') === 'app'`（2026-09-20 拍板的既定口径）⇒ 未登录也直进应用壳。
//   这不是 bug，是本地形态的核心承诺；但验落地页就必须站在 cloud 那一档上。
//   故在页面 JS 起来**之前**拦掉那个请求（只改这一个响应的 form 字段，不碰产品代码、不碰后端）。
console.log(`\n打开 ${APP_URL}（未登录 + 注入 cloud 形态 ⇒ 应渲染落地页）`);
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/auth/providers') >= 0) {
        return Promise.resolve(new Response(
          JSON.stringify({ providers: { github: false }, form: 'cloud' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
      }
      return orig.apply(this, arguments);
    };
  })();`,
});
await send('Page.navigate', { url: APP_URL });
if (!(await until('Boolean(document.querySelector(".landing-hero-demo .ld-window"))', 25000))) {
  console.error('落地页演示窗没出现——检查：dev server 是否在跑 / me 是否 401 / 选择器是否改过');
  ws.close();
  chrome.kill();
  process.exit(1);
}
await sleep(600); // 让字体与首帧动画落定

// ── G1/G2 hero 布局 ──
console.log('\n[G] hero 布局（真机几何）');
const hero = await evalJs(`(() => {
  const q = (s) => document.querySelector(s);
  const box = (s) => { const e = q(s); if (!e) return null; const b = e.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom) }; };
  return { vh: innerHeight, copy: box('.landing-hero-copy'), demo: box('.landing-hero-demo'),
    stage: q('.ld-stage') ? { sh: q('.ld-stage').scrollHeight, ch: q('.ld-stage').clientHeight } : null,
    svg: box('.ld-g-svg'), tabs: [...document.querySelectorAll('.ld-tab')].map(t => t.textContent.trim()) };
})()`);
ck(Boolean(hero.copy && hero.demo), 'G1a hero 双栏两块都在');
ck(hero.copy && hero.demo && Math.abs(hero.copy.y - hero.demo.y) < 120 && hero.demo.x > hero.copy.x + hero.copy.w - 10,
  'G1b hero 是**并排双栏**（不是窄屏塌成的上下堆叠）',
  hero.copy && hero.demo ? `文案 x${hero.copy.x} w${hero.copy.w} / 演示 x${hero.demo.x} y${hero.demo.y}` : '元素缺失');
ck(hero.demo && hero.demo.b <= hero.vh + 1, 'G1c 演示窗在首屏内（首屏要能看见产品在动）', hero.demo ? `底 ${hero.demo.b} > 视口 ${hero.vh}` : '');
// ★ 这里刻意**不断言** `.ld-stage` 自身不溢出：它的 `overflow:hidden` 是设计的一部分（词条演示的
//   悬浮速览卡挂在回复下方、允许超出舞台高度再被裁掉）。实测 scrollH 416 > clientH 302 属**既有行为**，
//   与本批无关，别把它当成回归。本批真正要防的是"图被裁"——由切到知识图后的 G1d 与逐帧 G3 断住。
ck(hero.tabs.length === 2, 'G1e 两个演示的切换 Tab 都出现了', `Tab = ${JSON.stringify(hero.tabs)}`);

await shot('00-hero-词条演示.png', '.landing-hero');

// ── 切到知识图演示 ──
console.log('\n[F] 知识图演示逐帧');
const clicked = await evalJs(`(() => {
  const t = [...document.querySelectorAll('.ld-tab')].find(b => b.textContent.includes('知识图'));
  if (!t) return false; t.click(); return true;
})()`);
ck(clicked, 'F0a 找到并点击了「知识图」Tab');
await until('Boolean(document.querySelector(".ld-g-svg"))', 8000);
await sleep(500);

// G1d：本批的图层不许溢出舞台（舞台是 overflow:hidden，溢出会被**静默**裁掉）
const fit = await evalJs(`(() => {
  const a = document.querySelector('.ld-stage'); const g = document.querySelector('.ld-g');
  return a && g ? { sh: Math.round(g.scrollHeight), ch: Math.round(a.clientHeight) } : null;
})()`);
ck(fit && fit.sh <= fit.ch + 1, 'G1d 知识图演示层不溢出舞台（溢出会被静默裁掉）',
  fit ? `.ld-g scrollH ${fit.sh} > 舞台 clientH ${fit.ch}` : '元素缺失');

/** 当前帧号（播放器把 on 类移到对应的阶段点上） */
const FRAME_NO = `[...document.querySelectorAll('.ld-pip')].findIndex(p => p.classList.contains('ld-pip-on'))`;
/** 该帧的 DOM 事实：节点/边/按钮/清单/图例/实线数 */
const SNAP = `(() => {
  const n = (s) => document.querySelectorAll(s).length;
  return { f: ${FRAME_NO}, caption: (document.querySelector('.ld-caption') || {}).textContent || '',
    nodes: n('.ld-g-n.on'), edges: n('.ld-g-e.on'), userEdges: n('.ld-g-e.user'),
    ask: n('.ld-g-ask.on'), terms: n('.ld-g-terms.on'), legend: n('.ld-g-legend.on'),
    termTexts: [...document.querySelectorAll('.ld-g-term')].map(e => e.textContent),
    legendItems: [...document.querySelectorAll('.ld-g-legend .gr-legend-item')].map(e => e.textContent) };
})()`;

/** 几何：节点卡片是否落在 SVG 视口内 / 是否互相重叠 / 文字是否溢出卡片 */
const GEOM = `(() => {
  const svg = document.querySelector('.ld-g-svg');
  if (!svg) return null;
  const sb = svg.getBoundingClientRect();
  const nodes = [...document.querySelectorAll('.ld-g-n.on')].map((g) => {
    const rect = g.querySelector('rect').getBoundingClientRect();
    const name = g.querySelector('.gr-node-name').getBoundingClientRect();
    const label = g.querySelector('.gr-node-name').textContent;
    return { label, rect: { l: rect.left, r: rect.right, t: rect.top, b: rect.bottom },
      textW: Math.round(name.width), boxW: Math.round(rect.width) };
  });
  return { svg: { l: sb.left, r: sb.right, t: sb.top, b: sb.bottom }, nodes };
})()`;

const plan = [
  { frame: 0, nodes: 2, edges: 1, ask: 0, terms: 0, legend: 0, user: 1, must: '关系还是稀的' },
  { frame: 1, nodes: 2, edges: 1, ask: 1, terms: 0, legend: 0, user: 1, must: '向 AI 追问' },
  { frame: 2, nodes: 5, edges: 4, ask: 0, terms: 1, legend: 0, user: 1, must: '星型' },
  { frame: 3, nodes: 7, edges: 6, ask: 0, terms: 1, legend: 0, user: 1, must: '树' },
  { frame: 4, nodes: 7, edges: 6, ask: 0, terms: 0, legend: 1, user: 2, must: '未经确认' },
];

for (const p of plan) {
  const ok = await until(`${FRAME_NO} === ${p.frame}`, 26000);
  const s = await evalJs(SNAP);
  const g = await evalJs(GEOM);
  console.log(`\n  第 ${p.frame} 帧（caption: ${s.caption.slice(0, 30)}…）`);
  ck(ok && s.f === p.frame, `F${p.frame}-a 播放到该帧`, `实际帧 ${s.f}`);
  ck(s.nodes === p.nodes, `F${p.frame}-b 显现节点数 = ${p.nodes}`, `实际 ${s.nodes}`);
  ck(s.edges === p.edges, `F${p.frame}-c 显现边数 = ${p.edges}`, `实际 ${s.edges}`);
  ck(s.ask === p.ask, `F${p.frame}-d 追问按钮 ${p.ask ? '可见' : '隐藏'}`, `实际 ${s.ask}`);
  ck(s.terms === p.terms, `F${p.frame}-e 抽词清单 ${p.terms ? '可见' : '隐藏'}`, `实际 ${s.terms}`);
  ck(s.legend === p.legend, `F${p.frame}-f 图例 ${p.legend ? '可见' : '隐藏'}`, `实际 ${s.legend}`);
  ck(s.userEdges === p.user, `F${p.frame}-g 实线（已确认）数 = ${p.user}`, `实际 ${s.userEdges}`);
  ck(s.caption.includes(p.must), `F${p.frame}-h 解说词含「${p.must}」`, `实际：${s.caption}`);

  // 真机几何：只在有节点时验
  if (g && g.nodes.length > 0) {
    const out = g.nodes.filter((n) => n.rect.l < g.svg.l - 1 || n.rect.r > g.svg.r + 1 || n.rect.t < g.svg.t - 1 || n.rect.b > g.svg.b + 1);
    ck(out.length === 0, `G3-${p.frame} 卡片都在 SVG 视口内`, out.map((n) => n.label).join('、') + ' 越界');
    let overlap = '';
    for (let i = 0; i < g.nodes.length; i += 1) {
      for (let j = i + 1; j < g.nodes.length; j += 1) {
        const a = g.nodes[i].rect;
        const b = g.nodes[j].rect;
        if (!(a.r <= b.l + 1 || b.r <= a.l + 1 || a.b <= b.t + 1 || b.b <= a.t + 1)) overlap += `${g.nodes[i].label}×${g.nodes[j].label} `;
      }
    }
    ck(overlap === '', `G4-${p.frame} 卡片互不重叠`, overlap);
    const sp = g.nodes.filter((n) => n.textW > n.boxW - 6);
    ck(sp.length === 0, `G5-${p.frame} 节点文字没挤满卡片`, sp.map((n) => `${n.label} ${n.textW}/${n.boxW}px`).join('、'));
  }
  if (p.frame === 2 || p.frame === 3) {
    ck(s.termTexts.length > 0, `F${p.frame}-i 列出了抽出的词条`, JSON.stringify(s.termTexts));
  }
  if (p.frame === 4) {
    ck(s.legendItems.length === 2, 'F4-i 图例**只有图上存在的两种**（不列图上看不到的 derived）', JSON.stringify(s.legendItems));
    ck(s.legendItems.join('').includes('未经确认'), 'F4-j 图例点明 AI 抽的边「未经确认」', JSON.stringify(s.legendItems));
  }
  // ★ 截图前让 CSS transition 走完：帧刚切换的瞬间元素还在淡入/淡出中途，截下来是"两串文字
  //   叠在一起"的中间态，看着像 bug（第一版探针就踩了这个坑）。底部带换场的时相是
  //   0.16s 退 + 0.18s 延迟 + 0.3s 进 ≈ 0.64s，故等 700ms 留足余量。
  await sleep(700);
  // 五帧**全部**留证（老板要"看效果"，逐帧截图是最低成本、最不掺水的证据）
  const NAMES = ['10-帧0-起点.png', '11-帧1-追问按钮.png', '12-帧2-星型长出.png', '13-帧3-星长成树.png', '14-帧4-出处分层.png'];
  await shot(NAMES[p.frame], '.landing-hero-demo');
}

console.log(`\n${fail === 0 ? '✓ 全绿' : '✗ 有失败'}：${pass} passed, ${fail} failed`);
console.log(`截图目录：${SHOT_DIR}`);
console.log('DONE');
ws.close();
chrome.kill();
process.exit(fail === 0 ? 0 : 1);
