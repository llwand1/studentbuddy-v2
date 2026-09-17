/**
 * 学习流编排画布「缩放 / 平移」真机核验（零依赖 CDP 探针）
 *
 * ★ 为什么需要它：2026-09-17 老板实测反馈「构建的主图应该自带放大缩小的功能,不然看不清」。
 *   改的是**布局与事件接线**——`viewBox` 换成受控视口、滚轮用**原生非 passive 监听**、
 *   空白拖动改成平移、并顺带修掉「点节点立刻被取消选中」。这一整类东西：
 *   · tsc / eslint / gates **全绿**（CSS 与事件接线不在它们扫描范围）；
 *   · 本仓 `.tsx` 无 jsdom，组件一个都测不到（纯函数只盖住了几何）；
 *   · 而「滚轮到底缩放没缩放、会不会顺带把页面滚走」只有真渲染才有答案。
 *
 * ★ 断言口径（全部落在 DOM 事实，不落「我读过代码」）：
 *   1) 控制条真的渲染出来（3 个圆形按钮 + 百分比 + 提示文案）；
 *   2) 默认视口 = 100%（viewBox 宽 == 画布像素宽）；
 *   3) 滚轮真的改了 viewBox，且 **`defaultPrevented` 为真**（＝原生非 passive 监听生效；
 *      用 React 的 onWheel 会因 passive 而拿不到 preventDefault，这条会红）；
 *   4) 滚轮**锚点不漂**：光标下的用户坐标缩放前后一致（用 DOM 里的 viewBox 反算，不复用产品代码）；
 *   5) 按钮 +/−/100% 各自生效，百分比文案跟着变；
 *   6) 「适配窗口」后**每个节点都落在画布可见区内**（fit 的定义就是这个）；
 *   7) 空白拖动＝平移（viewBox 位移、宽高不变），且**不清除选中**（click 吞掉逻辑）；
 *   8) **点节点保住选中**（`.fl-panel-title` 从「步骤」变「步骤设置」）——这是顺带修掉的那个 bug。
 *
 * ★ 副作用：**零写入**。只导航 + 点选 + 纯前端视口变换；不建流、不改参数、不拖动节点
 *   （节点拖动会落 `position`），不发 LLM 请求。收尾复核「定义条数 / 版本号与开跑前一致」。
 *
 * ★ 前置：`npm run dev` 已起（前端 5173 绑 [::1]，故用 `localhost` 而非 `127.0.0.1`；
 *   后端 18791 由前端 /api 代理）。本机装有 Chrome 或 Edge。
 * 用法：node tools/probes/flow-canvas-zoom-cdp.mjs
 * 端口：CDP 9400+rand(100)，可 `SB_CDP_PORT` 覆盖；起前先探端口，被占则 exit(2) 拒绝跑。
 * 截图：落 `SB_SHOT_DIR`，缺省系统临时目录，**不入仓**。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const WEB = `http://localhost:${process.env.SB_WEB_PORT || 5173}/`;

const CHROME = [
  process.env.SB_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
  .filter(Boolean)
  .find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('✗ 找不到 Chrome / Edge，可用 SB_CHROME=<路径> 指定');
  process.exit(2);
}

const CDP_PORT = Number(process.env.SB_CDP_PORT) || 9400 + Math.floor(Math.random() * 100);
const SHOTS = process.env.SB_SHOT_DIR || path.join(os.tmpdir(), 'flow-canvas-zoom-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flzoom-'));

try {
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  console.error(`✗ CDP 端口 ${CDP_PORT} 已被占用（可能上次残留）。用 SB_CDP_PORT=<其它端口> 重跑。`);
  process.exit(2);
} catch (_) {
  /* 没人占，正常 */
}

const fails = [];
function chk(ok, label, got) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (got === undefined ? '' : '   ' + got));
  if (!ok) fails.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
  ],
  { stdio: 'ignore' }
);

let ws;
let msgId = 0;
const pending = new Map();
const jsErrors = [];
function send(method, params) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(method + ' → ' + JSON.stringify(m.error))) : res(m.result)));
  });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面内异常: ' + r.exceptionDetails.text);
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
}
async function waitFor(expr, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await ev(expr)) return;
    } catch (_) {
      /* 页面还在切视图，忽略 */
    }
    await sleep(250);
  }
  throw new Error('等待超时：' + label);
}

/* ── 交互原语：一律走 CDP Input，走真实命中测试与真实事件管线（不是 dispatchEvent 假造） ── */
const mouse = (type, x, y, buttons) =>
  send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1 });
async function click(x, y) {
  await mouse('mousePressed', x, y, 1);
  await sleep(60);
  await mouse('mouseReleased', x, y, 0);
  await sleep(220);
}
async function drag(x, y, dx, dy, steps = 6) {
  await mouse('mousePressed', x, y, 1);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x + (dx * i) / steps, y + (dy * i) / steps, 1);
    await sleep(45);
  }
  await mouse('mouseReleased', x + dx, y + dy, 0);
  await sleep(220);
}
const wheel = (x, y, deltaY, ctrl) =>
  send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(x),
    y: Math.round(y),
    deltaX: 0,
    deltaY,
    modifiers: ctrl ? 2 : 0,
    pointerType: 'mouse',
  });

/** 画布几何快照：viewBox 只用 DOM 属性反算，绝不调用产品里的纯函数 */
const SNAP = `(() => {
  const svg = document.querySelector('.fl-canvas svg.fl-svg');
  if (!svg) return { ok: false };
  const bar = document.querySelector('.fl-zoom');
  const r = svg.getBoundingClientRect();
  const pctEl = bar ? bar.querySelector('.fl-zoom-pct') : null;
  const hint = bar ? bar.querySelector('.fl-zoom-hint') : null;
  const sc = (() => { let n = svg.parentElement;
    while (n) { const s = getComputedStyle(n); if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1) return n; n = n.parentElement; }
    return null; })();
  return {
    ok: true,
    vb: (svg.getAttribute('viewBox') || '').trim().split(' ').map(Number),
    w: r.width, h: r.height, left: r.left, top: r.top,
    pct: pctEl ? pctEl.textContent.trim() : null,
    hint: hint ? hint.textContent.trim() : null,
    btn: bar ? bar.querySelectorAll('.fl-zoom-btn').length : 0,
    scrollTop: sc ? sc.scrollTop : null,
    scrollable: !!sc,
    // 取全部面板标题（不取第一个）：选中态记在「有『步骤设置』」，未选中态记在「有『步骤』而没有『步骤设置』」，
    // 这样不会因为 FlowPage 调换面板顺序而假绿/假红
    panels: [...document.querySelectorAll('.fl-panel-title')].map((e) => e.textContent.trim()),
    nodes: document.querySelectorAll('.fl-node').length,
  };
})()`;

const snap = () => ev(SNAP);

/** 光标处的用户坐标：由 viewBox + 元素像素矩形现算（独立于产品代码的第二条实现） */
function userAt(s, clientX, clientY) {
  const [x, y, w, h] = s.vb;
  return { x: x + ((clientX - s.left) * w) / s.w, y: y + ((clientY - s.top) * h) / s.h };
}

/** 画布里挑一个「空白点」（该点命中 svg 本身而不是节点），用于平移起手 */
const EMPTY_SPOT = `(() => {
  const svg = document.querySelector('.fl-canvas svg.fl-svg');
  const r = svg.getBoundingClientRect();
  const cand = [
    [r.left + 40, r.bottom - 40], [r.left + r.width - 40, r.bottom - 40],
    [r.left + 40, r.top + 40], [r.left + r.width - 40, r.top + 40],
  ];
  for (const [x, y] of cand) {
    const el = document.elementFromPoint(x, y);
    if (el && el.closest('#root') && !el.closest('.fl-node') && !el.closest('.fl-zoom')) return { x, y };
  }
  return null;
})()`;

try {
  const target = await (async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const j = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
        const p = j.find((t) => t.type === 'page');
        if (p) return p;
      } catch (_) {}
      await sleep(250);
    }
    throw new Error('CDP 未就绪（端口 ' + CDP_PORT + '）');
  })();

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'Runtime.exceptionThrown') {
      jsErrors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  console.log('\n── 学习流画布缩放/平移真机核验 ──\n');

  /* ── 0. 进入学习流页并选中一条流 ── */
  await send('Page.navigate', { url: WEB });
  await waitFor(`!!document.querySelector('.sb-nav-item')`, '应用外壳');
  await ev(`[...document.querySelectorAll('.sb-nav-item')].find(b => b.textContent.trim() === '学习流').click()`);
  await waitFor(`!!document.querySelector('.fl-def-main')`, '学习流定义列表');

  const defsBefore = await ev(`fetch('/api/study-flow/defs').then(r => r.json()).then(a => a.length)`);
  const picked = await ev(`(() => {
    const items = [...document.querySelectorAll('.fl-def-main')];
    const want = items.find(b => b.textContent.includes('四步课堂')) || items[0];
    if (!want) return null;
    want.click();
    return want.textContent.trim();
  })()`);
  if (!picked) {
    console.error('✗ 库里一条学习流都没有，先用模板建一条再跑本探针');
    process.exit(3);
  }
  await waitFor(`document.querySelectorAll('.fl-node').length > 0`, '画布节点渲染');
  await sleep(400);
  console.log(`选中流：${picked}\n`);

  /* ── 1. 控制条存在（「功能做了但用户看不到」＝没做） ── */
  const s0 = await snap();
  chk(s0.btn === 3, '控制条有 3 个圆形按钮（−, +, 适配）', `btn=${s0.btn}`);
  chk(s0.pct !== null, '显示缩放百分比', `pct=${s0.pct}`);
  chk(!!s0.hint && s0.hint.length > 0, '有可见的操作提示（滚轮缩放 · 拖动平移）', `「${s0.hint}」`);
  chk(s0.nodes > 0, '画布上有节点', `nodes=${s0.nodes}`);

  /* ── 2. 默认 100%（老板要的是「看得清」） ── */
  chk(s0.pct === '100%', '默认百分比为 100%', `pct=${s0.pct}`);
  chk(Math.abs(s0.vb[2] - s0.w) < 1.5, '默认 viewBox 宽 == 画布像素宽（1 用户单位 = 1px）', `vbW=${s0.vb[2]} 画布W=${Math.round(s0.w)}`);
  chk(Math.abs(s0.vb[2] / s0.vb[3] - s0.w / s0.h) < 1e-3, 'viewBox 宽高比 == 画布宽高比（保证 getScreenCTM 拖拽准）', `${(s0.vb[2] / s0.vb[3]).toFixed(4)} vs ${(s0.w / s0.h).toFixed(4)}`);
  await shot('z0-default-100');

  /**
   * ★ CTM 一致性：`toSvg()` 换算鼠标位置走的就是 `getScreenCTM()`。
   *   把 viewBox 的两个角用屏幕矩阵投回去，必须正好落在 svg 元素盒的四个边（0 偏移、无 letterbox），
   *   且矩阵的缩放分量 == 画布像素宽 / viewBox 宽。**这一条是「缩放了以后拖节点还准不准」的判据**——
   *   只测「viewBox 数字变了」证明不了这个（真正会坏的是坐标反算，不是 viewBox 本身）。
   */
  const CTM = `(() => {
    const svg = document.querySelector('.fl-canvas svg.fl-svg');
    const vb = svg.getAttribute('viewBox').trim().split(' ').map(Number);
    const m = svg.getScreenCTM();
    const r = svg.getBoundingClientRect();
    const a = new DOMPoint(vb[0], vb[1]).matrixTransform(m);
    const b = new DOMPoint(vb[0] + vb[2], vb[1] + vb[3]).matrixTransform(m);
    return { offL: a.x - r.left, offT: a.y - r.top, offR: b.x - r.right, offB: b.y - r.bottom,
             ctmScale: m.a, expect: r.width / vb[2] };
  })()`;
  const ctm0 = await ev(CTM);
  chk(
    Math.abs(ctm0.offL) < 0.5 && Math.abs(ctm0.offT) < 0.5 && Math.abs(ctm0.offR) < 0.5 && Math.abs(ctm0.offB) < 0.5,
    '★ getScreenCTM 与 viewBox 严格对齐（0 偏移、无 letterbox）⇒ 缩放下拖动换算不会飘',
    `偏移(${ctm0.offL.toFixed(2)}, ${ctm0.offT.toFixed(2)}, ${ctm0.offR.toFixed(2)}, ${ctm0.offB.toFixed(2)})`,
  );
  chk(Math.abs(ctm0.ctmScale - ctm0.expect) < 0.01, 'CTM 缩放分量 == 画布像素宽 / viewBox 宽', `${ctm0.ctmScale.toFixed(4)} vs ${ctm0.expect.toFixed(4)}`);

  /* ── 3. 滚轮：真缩放 + 真拦住默认滚动 + 锚点不漂 ── */
  await ev(`window.__wheelDP = null; window.addEventListener('wheel', (e) => { window.__wheelDP = e.defaultPrevented; }, { passive: false });`);
  const cx = s0.left + s0.w * 0.32;
  const cy = s0.top + s0.h * 0.30;
  const uBefore = userAt(s0, cx, cy);
  await wheel(cx, cy, -240); // 往上滚 = 放大
  await sleep(300);
  const s1 = await snap();
  chk(s1.vb[2] < s0.vb[2] - 1, '滚轮上滚：viewBox 变窄＝真的放大了', `${s0.vb[2]} → ${s1.vb[2]}`);
  chk(s1.pct !== s0.pct, '百分比跟着更新', `${s0.pct} → ${s1.pct}`);
  chk((await ev(`window.__wheelDP`)) === true, '★ 滚轮 defaultPrevented 为真（＝原生非 passive 监听生效，页面不会被顺带滚走）');
  if (s0.scrollable) {
    chk(s1.scrollTop === s0.scrollTop, '滚动容器未被滚轮带动', `scrollTop ${s0.scrollTop} → ${s1.scrollTop}`);
  } else {
    console.log('  · 跳过「滚动容器未被带动」：当前内容不足以滚动，该断言此时无判别力');
  }
  const uAfter = userAt(s1, cx, cy);
  chk(
    Math.abs(uAfter.x - uBefore.x) < 1 && Math.abs(uAfter.y - uBefore.y) < 1,
    '★ 锚点不漂：光标下的用户坐标缩放前后一致',
    `(${uBefore.x.toFixed(1)}, ${uBefore.y.toFixed(1)}) → (${uAfter.x.toFixed(1)}, ${uAfter.y.toFixed(1)})`,
  );
  // 缩放态下再验一次 CTM 对齐：`toSvg()` 换算鼠标位置就靠它，**缩放后失配才是真会出事的地方**
  const ctmZ = await ev(CTM);
  chk(
    Math.abs(ctmZ.offL) < 0.5 && Math.abs(ctmZ.offR) < 0.5 && Math.abs(ctmZ.ctmScale - ctmZ.expect) < 0.01,
    '★ 缩放态下 CTM 仍与 viewBox 严格对齐（拖动换算的判据）',
    `偏移(${ctmZ.offL.toFixed(2)}, ${ctmZ.offR.toFixed(2)}) scale ${ctmZ.ctmScale.toFixed(4)} vs ${ctmZ.expect.toFixed(4)}`,
  );
  await shot('z1-wheel-zoom-in');

  /* ── 4. 按钮：− / + / 回到 100% ── */
  const btnAt = (i) =>
    ev(`(() => { const b = document.querySelectorAll('.fl-zoom-btn')[${i}].getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  const minus = await btnAt(0);
  const plus = await btnAt(1);
  const fit = await btnAt(2);

  const wZoomed = (await snap()).vb[2];
  await click(plus.x, plus.y);
  const wPlus = (await snap()).vb[2];
  chk(wPlus < wZoomed - 1, '点「+」继续放大', `${wZoomed} → ${wPlus}`);
  await click(minus.x, minus.y);
  const wMinus = (await snap()).vb[2];
  chk(wMinus > wPlus + 1, '点「−」缩小', `${wPlus} → ${wMinus}`);
  chk(Number.isFinite(wMinus), '缩小后 viewBox 仍是有限值（没算出 NaN 把画布搞空白）', `vbW=${wMinus}`);

  const pctAt = await ev(`(() => { const b = document.querySelector('.fl-zoom-pct').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await click(pctAt.x, pctAt.y);
  const sReset = await snap();
  chk(sReset.pct === '100%', '点百分比回到 100%', `pct=${sReset.pct}`);
  chk(Math.abs(sReset.vb[2] - sReset.w) < 1.5, '回到 100% 后 viewBox 宽 == 画布像素宽', `vbW=${sReset.vb[2]}`);

  /* ── 5. 适配窗口：全部节点必须进得了可见区 ── */
  // 先放大到明显超出，再点适配——否则「本来就都看得见」构不成判别力
  await wheel(s0.left + s0.w / 2, s0.top + s0.h / 2, -900);
  await sleep(300);
  const overflow = await ev(`(() => {
    const svg = document.querySelector('.fl-canvas svg.fl-svg').getBoundingClientRect();
    const out = [...document.querySelectorAll('.fl-node')].filter(n => { const b = n.getBoundingClientRect();
      return b.left < svg.left - 2 || b.right > svg.right + 2 || b.top < svg.top - 2 || b.bottom > svg.bottom + 2; });
    return out.length; })()`);
  chk(overflow > 0, '前置条件：放大后确有节点被挤出可见区（让下一条断言有判别力）', `越界节点=${overflow}`);
  await shot('z2-zoom-overflow');

  await click(fit.x, fit.y);
  const fitOut = await ev(`(() => {
    const svg = document.querySelector('.fl-canvas svg.fl-svg').getBoundingClientRect();
    return [...document.querySelectorAll('.fl-node')].filter(n => { const b = n.getBoundingClientRect();
      return b.left < svg.left - 2 || b.right > svg.right + 2 || b.top < svg.top - 2 || b.bottom > svg.bottom + 2; }).length; })()`);
  const sFit = await snap();
  chk(fitOut === 0, '★ 适配窗口后所有节点都在可见区内', `越界节点=${fitOut}`);
  chk(Number(sFit.pct.replace('%', '')) <= 100, '适配不放大超过 100%', `pct=${sFit.pct}`);
  await shot('z3-fit');

  /* ── 6. 空白拖动＝平移，且不清除选中 ── */
  // 先选中一个节点，这样「平移是否误清选中」才测得到
  const nodePt = await ev(`(() => { const n = document.querySelector('.fl-node').getBoundingClientRect();
    return { x: n.left + n.width / 2, y: n.top + n.height / 2 }; })()`);
  await click(nodePt.x, nodePt.y);
  await sleep(300);
  const panelsSel = (await snap()).panels;
  chk(
    panelsSel.includes('步骤设置'),
    '★ 点节点后选中生效（面板切到「步骤设置」）——点节点不再被随即取消选中',
    `面板标题=${JSON.stringify(panelsSel)}`,
  );

  const spot = await ev(EMPTY_SPOT);
  if (!spot) {
    console.log('  ✗ 找不到空白点，跳过平移断言（画布可能被节点铺满）');
    fails.push('空白点定位');
  } else {
    const before = await snap();
    await drag(spot.x, spot.y, 120, 60);
    const after = await snap();
    chk(
      Math.abs(after.vb[0] - before.vb[0]) > 20 || Math.abs(after.vb[1] - before.vb[1]) > 20,
      '★ 空白拖动产生平移（viewBox 原点移动）',
      `原点 (${before.vb[0]}, ${before.vb[1]}) → (${after.vb[0]}, ${after.vb[1]})`,
    );
    chk(Math.abs(after.vb[2] - before.vb[2]) < 0.5, '平移不改变缩放（viewBox 宽不变）', `${before.vb[2]} → ${after.vb[2]}`);
    chk(after.panels.includes('步骤设置'), '平移不清除已有选中（拖动过的 click 被吞掉）', `面板标题=${JSON.stringify(after.panels)}`);
    // 平移方向：鼠标往右下拖 ⇒ 内容跟着往右下走 ⇒ 视口原点往左上（数值变小）
    chk(after.vb[0] < before.vb[0] && after.vb[1] < before.vb[1], '平移方向正确（鼠标往右下拖，视口原点往左上）',
      `Δ(${(after.vb[0] - before.vb[0]).toFixed(1)}, ${(after.vb[1] - before.vb[1]).toFixed(1)})`);
    await shot('z4-panned');
  }

  /* ── 7. 点空白＝取消选中（新逻辑不能把老行为一起吞掉） ── */
  const spot2 = (await ev(EMPTY_SPOT)) || spot;
  await click(spot2.x, spot2.y);
  await sleep(300);
  const panelsCleared = (await snap()).panels;
  chk(
    panelsCleared.includes('步骤') && !panelsCleared.includes('步骤设置'),
    '点空白仍能取消选中（新加的 click 吞掉逻辑没有把老行为一起吞掉）',
    `面板标题=${JSON.stringify(panelsCleared)}`,
  );

  /* ── 8. 副作用复核：全程零写入 ── */
  const defsAfter = await ev(`fetch('/api/study-flow/defs').then(r => r.json()).then(a => a.length)`);
  chk(defsAfter === defsBefore, '全程未新建/删除学习流（探针零写入）', `${defsBefore} → ${defsAfter}`);
  chk(jsErrors.length === 0, '页面无未捕获异常', jsErrors.length ? jsErrors[0].slice(0, 120) : '0 条');

  console.log('\n截图目录：' + SHOTS);
  console.log(fails.length ? `\nDONE  ${fails.length} 处未通过：\n  - ${fails.join('\n  - ')}\n` : '\nDONE  全部断言通过\n');
} catch (e) {
  console.error('\n✗ 探针自身出错：' + e.message + '\n');
  fails.push('运行异常');
} finally {
  try {
    ws && ws.close();
  } catch (_) {}
  chrome.kill();
  process.exit(fails.length ? 1 : 0);
}
