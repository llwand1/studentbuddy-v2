/**
 * coach-trend-cdp — 督促趋势卡（记忆联动 P5）的**真浏览器**渲染/布局探针。
 *
 * 为什么需要它：P5 的两半都落在 vitest 够不着的地方——
 *   ① **图形链**：`renderTrendSvg` 出的字符串要过 `prepareSvg`（`DOMParser` 解析 → 剔危险标签 →
 *      重新序列化）才进 `innerHTML`，而 `svg-utils` 在 **node 里走的是正则回退分支**
 *      （`typeof DOMParser === 'undefined'`）⇒ 单测绿**不代表浏览器那条路也绿**
 *      （XMLSerializer 把 `viewBox` 序列没了、或把 `<polyline>` 拆了，单测一律看不见）；
 *   ② **布局**：`.coach-tr-chart svg` 要按容器宽铺开、`.coach-dock-rail` 要把气泡排在胶囊正上方，
 *      而 **CSS 既不在 vitest 也不在 gates 的扫描范围**（gates 只管 .ts/.tsx 的行数/内联样式/any）。
 *      本仓为此吃过一次学费（`bug-ledger` B-008：复习面板一口吃光容器、把词条库压成 4px）。
 *
 * ★ **零依赖、零写入、不需要后端**：只需要一个在跑的 vite（缺省 5175）。
 *   本探针**不碰数据库、不登录、不发请求**，只做两件事：
 *     A. 在页内 `import('/src/lib/chart-utils.ts')` / `import('/src/lib/svg-utils.ts')`
 *        —— vite 把源码当 ESM 直接喂给浏览器 ⇒ 跑的是**改完之后**的真代码；
 *     B. 用真 `coach.css`（`CoachDock` 挂载时已注入）量几组**不变量**。
 *
 * ★ **断言的是不变量，不是像素快照**（同 `terms-layout-cdp.mjs`）：换配色、改字号不会假红；
 *   只有"图被裁了 / 气泡压住胶囊 / 声明根本没生效"这类真坏了才会红。
 *
 * ★ **已知局限（必须写在文件头，同 terms-layout 的口径）**：B 段的卡片与气泡都是**照组件
 *   JSX 手搭的 DOM**（探针不驱动 React）。组件结构变更时须**同步更新骨架**，否则量的是过期结构。
 *   两道防"空过"的锁：① 断言 `.coach-card-trend` 的 `border-left-width` 恰好 3px、
 *   `.coach-tr-chart svg` 的 `display` 恰好 block —— **证明 coach.css 真的应用到了我搭的骨架上**；
 *   ② 气泡靠 `border-left-width === 3px` 与 `font-size === 11px` 两条 computed 值兜底。
 *
 * ★ **未覆盖（诚实记账）**：气泡的**触发**（服务端 `coach-card` 推送 → 抽屉关着才冒）不在本探针内——
 *   它要一条真的 SSE 推送，属于「真机端到端」范畴；本探针只锁"气泡长什么样、排在哪"。
 *
 * 用法（起一个 vite 即可，不需要后端）：
 *   (cd packages/web && npm run dev -- --port 5175 --strictPort)     # 或复用已在跑的 5175
 *   node tools/probes/coach-trend-cdp.mjs
 *   SB_PROBE_APP=http://127.0.0.1:5175/ SB_CDP_PORT=9411 node tools/probes/coach-trend-cdp.mjs
 * 截图落在 `SB_SHOT_DIR`（缺省＝系统临时目录），**不入仓**。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
/** 端口随机（9300~9499，可用 `SB_CDP_PORT` 固定）——残留 Chrome 占着固定端口会让新实例绑不上，
 *  而 `/json/version` 反而连到**旧浏览器**，探针就跑到别人的页面上去了（本仓已知坑） */
const PORT = Number(process.env.SB_CDP_PORT ?? 9300 + Math.floor(Math.random() * 200));
const APP = process.env.SB_PROBE_APP ?? 'http://127.0.0.1:5175/';
const OUT = process.env.SB_SHOT_DIR ?? join(process.env.TEMP ?? '/tmp', 'sb-cdp-shots');
/** 两档视口：桌面与常见笔记本。气泡/胶囊是 fixed 悬浮件，两档都必须完整可见 */
const VIEWPORTS = [
  { w: 1440, h: 900, name: 'desktop' },
  { w: 1024, h: 680, name: 'laptop' },
];

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!/^https?:\/\/127\.0\.0\.1:/.test(APP) && !/^https?:\/\/localhost:/.test(APP)) {
  console.error(`SB_PROBE_APP 必须指向本机 vite（拿到 ${APP}）——本探针只读页面，不写任何东西。`);
  process.exit(2);
}

const stale = await (async () => {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok;
  } catch {
    return false;
  }
})();
if (stale) {
  console.error(`端口 ${PORT} 上已有 CDP 实例（残留 Chrome？）——拒绝继续，否则会连到别人的浏览器。`);
  console.error('换个端口：SB_CDP_PORT=9xxx node tools/probes/coach-trend-cdp.mjs');
  process.exit(2);
}

const reachable = await (async () => {
  try {
    return (await fetch(APP)).ok;
  } catch {
    return false;
  }
})();
if (!reachable) {
  console.error(`打不开 ${APP} —— 先把 vite 起起来（本探针不需要后端）：`);
  console.error('  (cd packages/web && npm run dev -- --port 5175 --strictPort)');
  process.exit(2);
}

const profile = join(process.env.TEMP ?? '/tmp', `sb-cdp-trend-${Date.now()}`);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let version = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) {
      version = await r.json();
      break;
    }
  } catch {
    /* 还没起 */
  }
  await sleep(250);
}
if (!version) {
  console.error('CDP 未就绪');
  chrome.kill();
  process.exit(1);
}
console.log('Chrome =', version['Browser'], '| APP =', APP);

const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const myId = ++id;
    pending.set(myId, (m) => res(m.result ?? m.error));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) {
    console.error('页内异常：', r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r?.result?.value;
};
const waitFor = async (expr, timeoutMs = 20000, intervalMs = 200) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evalJs(expr);
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
};

await send('Page.enable');
await send('Runtime.enable');
await sleep(2500); // 等 React 挂载（coach.css 是 CoachDock 带进来的，必须等它注入）

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

// ── A. 图形链：真浏览器里的 renderTrendSvg + prepareSvg ────────────────────────
// 这一段是本探针**最不可替代**的部分：svg-utils 在 node 走正则回退，浏览器走 DOMParser 路径。
const graph = await evalJs(`(async () => {
  const cu = await import('/src/lib/chart-utils.ts');
  const su = await import('/src/lib/svg-utils.ts');
  const labels = ['09-12','09-13','09-14','09-15','09-16','09-17','09-18'];
  const values = [1, 0, 3, 2, 0, 5, 4];
  const raw = cu.renderTrendSvg({ labels, values });
  const safe = su.prepareSvg(raw);
  const probe = document.createElement('div');
  probe.setAttribute('data-probe', 'graph');
  probe.style.position = 'fixed';
  probe.style.left = '-9999px';
  probe.style.top = '0';
  probe.innerHTML = safe;
  document.body.appendChild(probe);
  const svg = probe.querySelector('svg');
  let bbox = null;
  let parsedOk = null;
  let titleText = null;
  if (svg) {
    try { const b = svg.getBBox(); bbox = { w: b.width, h: b.height }; } catch { bbox = null; }
    titleText = svg.querySelector('title')?.textContent ?? null;
  }
  // 独立解析一遍：确认净化后的字符串是**良构 XML**（XMLSerializer 输出坏掉是最隐蔽的一类失败）
  const doc = new DOMParser().parseFromString(safe, 'image/svg+xml');
  parsedOk = !doc.querySelector('parsererror');
  const nodes = {
    polyline: probe.querySelectorAll('polyline').length,
    circles: probe.querySelectorAll('circle').length,
    texts: probe.querySelectorAll('text').length,
  };
  const viewBox = svg?.getAttribute('viewBox') ?? null;
  const svgW = svg ? svg.getBoundingClientRect().width : 0;
  const evil = su.prepareSvg(cu.renderTrendSvg({ labels: ['<script>bad()</script>'], values: [1] }));
  probe.remove();
  return JSON.stringify({
    rawHead: raw.slice(0, 12), safeHead: safe.slice(0, 12), safeLen: safe.length,
    parsedOk, viewBox, bbox, nodes, titleText, svgW,
    hasScript: /<script/i.test(safe),
    evilHasScript: /<script/i.test(evil),
    evilHasEscaped: evil.includes('&lt;script&gt;'),
    emptyIsEmpty: cu.renderTrendSvg({ labels: [], values: [] }) === '',
    singleOk: (() => {
      const one = su.prepareSvg(cu.renderTrendSvg({ labels: ['09-18'], values: [7] }));
      const d = new DOMParser().parseFromString(one, 'image/svg+xml');
      const s = d.querySelector('svg');
      let h = 0;
      const host = document.createElement('div');
      host.innerHTML = one;
      document.body.appendChild(host);
      try { h = host.querySelector('svg').getBBox().height; } catch { h = 0; }
      host.remove();
      return !d.querySelector('parsererror') && !!s && h > 0;
    })(),
  });
})()`);

const g = JSON.parse(graph ?? '{}');
console.log('  —— 图形链实测：', JSON.stringify({ viewBox: g.viewBox, bbox: g.bbox, nodes: g.nodes, parsedOk: g.parsedOk }));

check('A1 真浏览器里 renderTrendSvg 出的是 svg 根', g.safeHead?.startsWith('<svg'), g.safeHead);
check('A2 prepareSvg（DOMParser 路径）后仍是良构 XML', g.parsedOk === true);
check('A3 净化没吃掉 viewBox（缩放全靠它）', g.viewBox === '0 0 320 112', g.viewBox);
check('A4 折线结构完整：1 条 polyline + 7 个圆点 + 有横轴文本', g.nodes?.polyline === 1 && g.nodes?.circles === 7 && g.nodes?.texts >= 2, JSON.stringify(g.nodes));
check('A5 图真有几何（getBBox 非零）—— 不是一张空壳', g.bbox && g.bbox.w > 100 && g.bbox.h > 20, JSON.stringify(g.bbox));
check('A6 净化后不含 <script>，且日期文本已转义', g.hasScript === false && g.evilHasScript === false && g.evilHasEscaped === true);
check('A7 空数据 ⇒ 空串（前端据此不渲染图，摘要照常）', g.emptyIsEmpty === true);
check('A8 单点不炸（n=1 时 xOf 的除零分支）', g.singleOk === true);
check('A9 无障碍标题在（<title> 没被净化剥掉）', typeof g.titleText === 'string' && g.titleText.length > 0, g.titleText);

// ── B/C. 布局不变量（两档视口各跑一遍）─────────────────────────────────────────
/** 注入骨架（照 CoachCardViews 的 trend 分支 + CoachDock 的 rail 手搭，见文件头「已知局限」） */
const buildFixture = async () =>
  evalJs(`(async () => {
  const cu = await import('/src/lib/chart-utils.ts');
  const su = await import('/src/lib/svg-utils.ts');
  const svg = su.prepareSvg(cu.renderTrendSvg({ labels: ['09-12','09-13','09-14','09-15','09-16','09-17','09-18'], values: [1,0,3,2,0,5,4] }));
  const host = document.createElement('div');
  host.setAttribute('data-probe', 'card');
  host.style.position = 'fixed';
  host.style.left = '-9999px';
  host.style.top = '0';
  host.style.width = '400px';           // 抽屉宽度（coach.css 的 .coach-drawer）
  host.innerHTML =
    '<div class="coach-card coach-card-trend" data-card-id="probe-trend">' +
      '<div class="coach-tr-head">近期学习趋势 · 近 7 天</div>' +
      '<div class="coach-tr-chart">' + svg + '</div>' +
      '<div class="coach-tr-body">近 7 天共提及 15 次，最活跃的是「graph」（5 次）。</div>' +
      '<div class="coach-tr-ranks">' +
        '<span class="coach-tr-chip">graph<span class="coach-tr-n">5</span></span>' +
        '<span class="coach-tr-chip">algo<span class="coach-tr-n">4</span></span>' +
        '<span class="coach-tr-chip term">二分查找<span class="coach-tr-n">3</span></span>' +
      '</div>' +
    '</div>';
  document.body.appendChild(host);
  const card = host.querySelector('.coach-card-trend');
  const chart = host.querySelector('.coach-tr-chart');
  const svgEl = host.querySelector('.coach-tr-chart svg');
  const ranks = host.querySelector('.coach-tr-ranks');
  const cs = getComputedStyle(card);
  const contentW = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const svgRect = svgEl.getBoundingClientRect();
  const out = {
    borderLeft: getComputedStyle(card).borderLeftWidth,
    svgDisplay: getComputedStyle(svgEl).display,
    contentW: Math.round(contentW * 10) / 10,
    svgW: Math.round(svgRect.width * 10) / 10,
    svgH: Math.round(svgRect.height * 10) / 10,
    ratio: Math.round((svgRect.width / svgRect.height) * 1000) / 1000,
    ranksOverflow: ranks.scrollWidth - ranks.clientWidth,
    chartRightOver: Math.round((svgRect.right - card.getBoundingClientRect().right) * 10) / 10,
  };
  host.remove();
  return JSON.stringify(out);
})()`);

const buildBubble = async () =>
  evalJs(`(async () => {
  const rail = document.querySelector('.coach-dock-rail');
  const cap = document.querySelector('.coach-cap');
  if (!rail || !cap) return JSON.stringify({ missing: !rail ? 'rail' : 'cap' });
  const bub = document.createElement('div');
  bub.className = 'coach-bubble';
  bub.setAttribute('role', 'status');
  bub.setAttribute('data-probe', 'bubble');
  bub.innerHTML = '<button class="coach-bubble-main">你的近期学习趋势生成了！</button>' +
                  '<button class="coach-bubble-x" title="先不看了">×</button>';
  rail.insertBefore(bub, cap);   // 与 CoachDock 的渲染次序一致：气泡在胶囊之前
  // ★ 必须先等入场动画跑完再量：\`.coach-bubble\` 有 200ms 的 \`translateY(6px)\` 入场，
  //   动画途中的 rect 会比最终位置低 6px ⇒ 缝隙被少算 6px（首版就据此误判成"只隔 2px"）。
  await new Promise((r) => setTimeout(r, 350));
  const cs = getComputedStyle(bub);
  const mainCs = getComputedStyle(bub.querySelector('.coach-bubble-main'));
  const b = bub.getBoundingClientRect();
  const c = cap.getBoundingClientRect();
  const r = rail.getBoundingClientRect();
  const out = {
    railIsParent: cap.parentElement === rail,
    railRight: Math.round(r.right * 10) / 10,
    railGap: getComputedStyle(rail).gap,
    railPointer: getComputedStyle(rail).pointerEvents,
    bubH: Math.round(b.height * 10) / 10,
    capH: Math.round(c.height * 10) / 10,
    capTop: Math.round(c.top * 10) / 10,
    capRight: Math.round(c.right * 10) / 10,
    capBottom: Math.round(c.bottom * 10) / 10,
    capLeft: Math.round(c.left * 10) / 10,
    bubBottom: Math.round(b.bottom * 10) / 10,
    bubRight: Math.round(b.right * 10) / 10,
    bubLeft: Math.round(b.left * 10) / 10,
    bubTop: Math.round(b.top * 10) / 10,
    bubBorderLeft: cs.borderLeftWidth,
    mainFontSize: mainCs.fontSize,
    // ★ 真命中测试（坑：注释里别写裸反引号，会截断这个模板字符串）：舱体是 pointer-events:none，
    //   若子元素没拿到 auto，胶囊会"看得见点不着"——而 el.click() 是程序化调用、**绕过命中测试**，
    //   老探针那套点法**永远发现不了**这个错。
    capHit: (() => {
      const el = document.elementFromPoint((c.left + c.right) / 2, (c.top + c.bottom) / 2);
      return el ? (el.closest('.coach-cap') ? 'cap' : el.className || el.tagName) : null;
    })(),
    bubHit: (() => {
      const el = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
      return el ? (el.closest('.coach-bubble') ? 'bubble' : el.className || el.tagName) : null;
    })(),
    // 容器本身不该吃点击（它是右下角一块空区域），只有里面两个控件可点
    railPointerEvents: getComputedStyle(rail).pointerEvents,
    capPointerEvents: getComputedStyle(cap).pointerEvents,
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
  return JSON.stringify(out);
})()`);

const dropBubble = () =>
  evalJs(`(() => { document.querySelector('[data-probe="bubble"]')?.remove(); return 'ok'; })()`);

for (const vp of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.w,
    height: vp.h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(350);
  console.log(`\n── 视口 ${vp.name} ${vp.w}×${vp.h} ──`);

  // B. 趋势卡：图铺满容器、不溢出、榜单不横向溢出
  const c = JSON.parse((await buildFixture()) ?? '{}');
  check(`B1[${vp.name}] coach.css 真的应用到了骨架上（border-left 3px）`, c.borderLeft === '3px', c.borderLeft);
  check(`B2[${vp.name}] 折线画布 display:block（不是 inline 基线留白）`, c.svgDisplay === 'block', c.svgDisplay);
  check(
    `B3[${vp.name}] 图按容器宽铺满（±2px）且不被裁`,
    Math.abs(c.svgW - c.contentW) <= 2 && c.chartRightOver <= 0.5,
    `svgW=${c.svgW} contentW=${c.contentW} 溢出=${c.chartRightOver}`,
  );
  check(
    `B4[${vp.name}] 高度等比（viewBox 320:112 生效，±0.02）`,
    Math.abs(c.ratio - 320 / 112) <= 0.02,
    `ratio=${c.ratio} 期望≈${(320 / 112).toFixed(3)}`,
  );
  check(`B5[${vp.name}] top 榜在自己行内换行、不横向溢出`, c.ranksOverflow <= 1, `scrollW-clientW=${c.ranksOverflow}`);

  // C. 悬浮舱：胶囊/气泡都完整可见、气泡在胶囊正上方且不重叠
  const b = JSON.parse((await buildBubble()) ?? '{}');
  if (b.missing) {
    check(`C*[${vp.name}] 悬浮舱与胶囊在位`, false, `缺 ${b.missing}`);
  } else {
    check(`C1[${vp.name}] 胶囊就在悬浮舱里（P5 重构点）`, b.railIsParent === true);
    check(
      `C2[${vp.name}] 胶囊完整在视口内（重构没把它挤出屏）`,
      b.capRight <= b.vw + 0.5 && b.capBottom <= b.vh + 0.5 && b.capLeft >= -0.5 && b.capTop >= -0.5,
      `cap=${b.capLeft},${b.capTop},${b.capRight},${b.capBottom} vp=${b.vw}×${b.vh}`,
    );
    check(
      `C3[${vp.name}] 气泡排在胶囊正上方、留出可见缝隙且**不重叠**（flex 列托着，不靠手算偏移）`,
      b.bubBottom <= b.capTop - 1 && b.capTop - b.bubBottom <= 12,
      `bubble.bottom=${b.bubBottom} cap.top=${b.capTop} 缝隙=${Math.round((b.capTop - b.bubBottom) * 10) / 10} railGap=${b.railGap} bubH=${b.bubH} capH=${b.capH}`,
    );
    check(
      `C4[${vp.name}] 气泡与胶囊右对齐、且完整在视口内`,
      Math.abs(b.bubRight - b.capRight) <= 1 && b.bubLeft >= -0.5 && b.bubTop >= -0.5 && b.bubRight <= b.vw + 0.5,
      `bub.right=${b.bubRight} cap.right=${b.capRight} bub.left=${b.bubLeft}`,
    );
    check(
      `C5[${vp.name}] 气泡带上了 coach.css 的皮肤（防"断言空过"）`,
      b.bubBorderLeft === '3px' && b.mainFontSize === '11px',
      `border-left=${b.bubBorderLeft} main-font-size=${b.mainFontSize}`,
    );
    check(
      `C6[${vp.name}] 舱体本身不吃点击、只有控件可点`,
      b.railPointerEvents === 'none' && b.capPointerEvents !== 'none',
      `rail=${b.railPointerEvents} cap=${b.capPointerEvents}`,
    );
    check(
      `C7[${vp.name}] 真命中测试：胶囊与主按钮的中心点各自打得中自己`,
      b.capHit === 'cap' && b.bubHit === 'bubble',
      `capHit=${b.capHit} bubHit=${b.bubHit}`,
    );
  }
  await dropBubble();
  await evalJs(`(() => { document.querySelector('[data-probe="card"]')?.remove(); return 'ok'; })()`);

  const shotR = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `coach-trend-${vp.name}.png`);
  writeFileSync(file, Buffer.from(shotR.data, 'base64'));
  console.log('shot ->', file);
}

const fails = checks.filter((x) => !x.pass);
console.log(`\n${checks.length - fails.length} passed / ${fails.length} failed`);
for (const f of fails) console.log('  FAIL', f.name);
ws.close();
chrome.kill();
process.exit(fails.length ? 1 : 0);
