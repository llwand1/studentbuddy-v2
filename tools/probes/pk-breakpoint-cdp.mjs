/**
 * PK 响应式断点真机核验（零依赖 CDP 探针）
 *
 * ★ 为什么需要它：`pk.css` 的媒体查询判据在 2026-09-16 由 `orientation`（设备方向）
 *   改为**屏宽三档 + 屏高补充档**。而媒体查询「写对了」与「真生效」是两回事——
 *   var 解析失败、层叠顺序写反、`repeat(var(--n),…)` 非法导致整条声明作废，
 *   tsc / eslint / gates 全看不出来（**CSS 不在门禁扫描范围**），只有真渲染才暴露。
 *
 * ★ 与同目录其它探针最大的差别：**它不需要后端、也不需要前端 dev server**。
 *   断点行为是纯 CSS 事实 ⇒ 探针自带一个 http 服务，只把 `tokens.css` + `pk.css`
 *   这两个**真源文件**（每次运行从源复制，不测副本）与一份手搭 DOM 喂给无头 Chrome。
 *   因此它**零副作用**：不碰 DB、不联网、不调 LLM、不写任何用户数据。
 *
 * ★ 前置：本机装有 Chrome（与同目录其它探针同前提），**无需** SB_PORT / vite。
 * 用法：node tools/probes/pk-breakpoint-cdp.mjs
 * 端口：CDP 端口随机（9300+rand(200)），可 `SB_CDP_PORT` 覆盖；起 Chrome 前先探端口，
 *      已被占用就 `exit(2)` **拒绝跑**（固定端口会连到残留旧实例、看着像产品挂了）。
 * 截图：落 `SB_SHOT_DIR`，缺省系统临时目录，**不入仓**。
 *
 * 视口矩阵：9 档 —— 移动 375/414、**矮屏横放** 667/844、平板 768/834、桌面 1024/1280/1440。
 * 每档断言：容器宽 / 对阵方向 / 选项列数 / 侧栏几何 / 旋转提示显隐 / 无横向溢出，
 * 外加两条**全档底线**（题干字号 ≥14px、选项触摸目标 ≥44px）。
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SRC = path.join(ROOT, 'packages/web/src');

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

const CDP_PORT = Number(process.env.SB_CDP_PORT) || 9300 + Math.floor(Math.random() * 200);
const SHOTS = process.env.SB_SHOT_DIR || path.join(os.tmpdir(), 'pk-breakpoint-shots');

/* 起 Chrome 前先探端口：连到残留旧实例会给出假结论，宁可拒绝跑 */
try {
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
  console.error(`✗ CDP 端口 ${CDP_PORT} 已被占用（可能是上一次残留的 Chrome）。用 SB_CDP_PORT=<其它端口> 重跑。`);
  process.exit(2);
} catch (_) {
  /* 没人占，正常 */
}

fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pkbp-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pkbps-'));

/* ── 1. 从真源复制 CSS（不测副本，改动即刻生效）── */
fs.copyFileSync(path.join(SRC, 'styles/tokens.css'), path.join(TMP, 'tokens.css'));
fs.copyFileSync(path.join(SRC, 'features/pk/pk.css'), path.join(TMP, 'pk.css'));

/* ── 2. 照 PkArena + PkMatch + PkAnswerBlock + PkTopicBar 手搭 DOM ── */
const SIDE = (label, nick, score, sub1, sub2) => `        <div class="sb-pk-arena-side">
          <span class="sb-pk-side-label">${label}</span>
          <span class="sb-pk-nick">${nick}</span>
          <span class="sb-pk-arena-score">${score}</span>
          <span class="sb-pk-sub">${sub1}</span>
          <span class="sb-pk-sub">${sub2}</span>
        </div>`;

fs.writeFileSync(
  path.join(TMP, 'probe.html'),
  `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pk 断点核验</title>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="pk.css">
</head>
<body>
<div id="root">
  <div class="sb-pk">
    <header class="sb-pk-head">
      <a class="sb-pk-back" href="#">← 返回</a>
      <span class="sb-pk-title">交互模式</span>
    </header>
    <div class="sb-pk-arena">
      <p class="sb-pk-rotate-tip">横屏体验更佳（竖屏也能玩）</p>
${SIDE('对手', '小豆包', '4', '答对 2/3', '求助 1')}
      <div class="sb-pk-arena-main">
        <div class="sb-pk-topic">
          <span class="sb-pk-topic-label">本轮主题</span>
          <span class="sb-pk-topic-name">世界地理</span>
          <span class="sb-pk-topic-owner">对手指定</span>
        </div>
        <section class="sb-pk-card sb-pk-block">
          <div class="sb-pk-q-head">
            <span class="sb-pk-h2">轮到你答</span>
            <span class="sb-pk-deadline">45s</span>
          </div>
          <p class="sb-pk-stem">世界上面积最大的沙漠是哪一个？请从以下四个选项中选出唯一正确的答案，注意区分「热带沙漠」与「极地荒漠」的口径差异。</p>
          <div class="sb-pk-options">
            <button class="sb-pk-option" type="button"><span class="sb-pk-option-letter">A</span><span class="sb-pk-option-text">撒哈拉沙漠</span></button>
            <button class="sb-pk-option" type="button"><span class="sb-pk-option-letter">B</span><span class="sb-pk-option-text">戈壁沙漠</span></button>
            <button class="sb-pk-option" type="button"><span class="sb-pk-option-letter">C</span><span class="sb-pk-option-text">南极洲（极地荒漠）</span></button>
            <button class="sb-pk-option" type="button"><span class="sb-pk-option-letter">D</span><span class="sb-pk-option-text">塔克拉玛干沙漠</span></button>
          </div>
          <button class="sb-pk-btn ghost" type="button">用求助道具（还剩 1 个）</button>
        </section>
        <div class="sb-pk-fold">
          <button class="sb-pk-fold-btn" type="button">
            <span class="sb-pk-fold-caret">展开</span>
            <span class="sb-pk-fold-sum">已判定 2</span>
          </button>
        </div>
      </div>
${SIDE('我', 'llwan', '6', '答对 3/3', '求助 1')}
    </div>
  </div>
</div>
</body>
</html>
`,
  'utf8'
);

/* ── 3. 起本地静态服务（只服务上面两个 CSS + 一个 HTML）── */
const srv = http.createServer((req, res) => {
  const rel = req.url.split('?')[0].replace(/^\//, '') || 'probe.html';
  const full = path.join(TMP, rel);
  if (!full.startsWith(TMP) || !fs.existsSync(full)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': full.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
  });
  res.end(fs.readFileSync(full));
});
const HTTP_PORT = await new Promise((r) => {
  srv.listen(0, '127.0.0.1', () => r(srv.address().port));
});

/* ── 4. CDP 接线 ── */
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
    '--window-size=1500,1000',
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

/** 一次量齐整套布局事实（避免多次往返、也避免「量完 A 再量 B 时视口已变」）*/
const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const pk = q('.sb-pk'), arena = q('.sb-pk-arena'), main = q('.sb-pk-arena-main');
  const side = q('.sb-pk-arena-side'), opts = q('.sb-pk-options'), tip = q('.sb-pk-rotate-tip');
  const stem = q('.sb-pk-stem'), score = q('.sb-pk-arena-score');
  const cols = getComputedStyle(opts).gridTemplateColumns;
  return {
    vw: window.innerWidth,
    pkW: Math.round(pk.getBoundingClientRect().width),
    pkMax: getComputedStyle(pk).maxWidth,
    arenaDir: getComputedStyle(arena).flexDirection,
    mainW: Math.round(main.getBoundingClientRect().width),
    cols: cols === 'none' ? -1 : cols.split(' ').length,
    colsRaw: cols,
    sideW: Math.round(side.getBoundingClientRect().width),
    sideDir: getComputedStyle(side).flexDirection,
    tipDisplay: getComputedStyle(tip).display,
    stemFs: getComputedStyle(stem).fontSize,
    scoreFs: getComputedStyle(score).fontSize,
    optMinH: getComputedStyle(q('.sb-pk-option')).minHeight,
    rowOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`;

/** 视口矩阵：档位按「屏宽 + 屏高」双判据 —— 矮屏横放与平板档会同时命中，靠层叠顺序定胜负 */
const CASES = [
  { tag: 'm375', w: 375, h: 812, tier: '移动', pk: 375, arena: 'column', cols: 1, sideW: null, sideDir: 'row', tip: 'block', shot: 'b1-mobile-375' },
  { tag: 'm414', w: 414, h: 896, tier: '移动', pk: 414, arena: 'column', cols: 1, sideW: null, sideDir: 'row', tip: 'block', shot: null },
  { tag: 'l667', w: 667, h: 375, tier: '矮屏横放', pk: 667, arena: 'row', cols: 1, sideW: 132, sideDir: 'column', tip: 'none', shot: 'b5-land-667' },
  { tag: 'l844', w: 844, h: 390, tier: '矮屏横放', pk: 844, arena: 'row', cols: 1, sideW: 132, sideDir: 'column', tip: 'none', shot: null },
  { tag: 't768', w: 768, h: 1024, tier: '平板', pk: 720, arena: 'column', cols: 1, sideW: null, sideDir: 'row', tip: 'block', shot: 'b2-tablet-768' },
  { tag: 't834', w: 834, h: 1112, tier: '平板', pk: 720, arena: 'column', cols: 1, sideW: null, sideDir: 'row', tip: 'block', shot: null },
  { tag: 'd1024', w: 1024, h: 768, tier: '桌面', pk: 1024, arena: 'row', cols: 2, sideW: 186, sideDir: 'column', tip: 'none', shot: null },
  { tag: 'd1280', w: 1280, h: 800, tier: '桌面', pk: 1120, arena: 'row', cols: 2, sideW: 186, sideDir: 'column', tip: 'none', shot: 'b3-desktop-1280' },
  { tag: 'd1440', w: 1440, h: 900, tier: '桌面', pk: 1120, arena: 'row', cols: 2, sideW: 186, sideDir: 'column', tip: 'none', shot: 'b4-desktop-1440' },
];

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
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/probe.html' });
  await sleep(900);

  chk(await ev('!!document.querySelector(".sb-pk-arena-main")'), '探针页加载成功（真源 CSS 已挂载）');

  for (const c of CASES) {
    console.log(`\n── ${c.tag} · ${c.w}×${c.h} ｜ 期望档位：${c.tier} ──`);
    await send('Emulation.setDeviceMetricsOverride', {
      width: c.w,
      height: c.h,
      deviceScaleFactor: 1,
      mobile: c.w < 1024,
    });
    await sleep(260);
    const m = await ev(MEASURE);

    chk(m.vw === c.w, `视口宽 = ${c.w}`, 'vw=' + m.vw);
    chk(m.pkW === c.pk, `.sb-pk 实际宽 = ${c.pk}`, `got ${m.pkW}px (max-width ${m.pkMax})`);
    chk(m.arenaDir === c.arena, `对阵方向 = ${c.arena}`, 'got ' + m.arenaDir);
    chk(m.cols === c.cols, `选项列数 = ${c.cols}`, `got ${m.cols}  «${m.colsRaw}»`);
    // 这条专治「var 解析失败 ⇒ 整条 grid 声明作废 ⇒ 悄悄退化成 1 列」——单看列数抓不到
    chk(m.colsRaw !== 'none', '`--sb-pk-cols` 解析成功（grid 声明未被作废）', m.colsRaw);
    chk(m.sideDir === c.sideDir, `侧栏方向 = ${c.sideDir}`, 'got ' + m.sideDir);
    if (c.sideW !== null) chk(Math.abs(m.sideW - c.sideW) <= 1, `侧栏宽 = ${c.sideW}`, 'got ' + m.sideW + 'px');
    chk(m.tipDisplay === c.tip, `旋转提示 display = ${c.tip}`, 'got ' + m.tipDisplay);
    chk(m.rowOverflow <= 1, '无横向溢出', 'overflow=' + m.rowOverflow + 'px');

    // 两条底线全档都查，不只查某一档
    chk(parseFloat(m.stemFs) >= 14, '题干字号 ≥14px（可读底线）', 'got ' + m.stemFs);
    chk(parseFloat(m.optMinH) >= 44, '选项触摸目标 ≥44px（无障碍底线）', 'got ' + m.optMinH);

    if (c.tag === 't768') chk(Math.abs(m.mainW - 620) <= 1, '平板档内容列封顶 620', 'got ' + m.mainW + 'px');
    if (c.tag === 'd1280') {
      chk(m.mainW >= 640, '桌面档中间栏 ≥640（三栏没把主区挤死）', 'got ' + m.mainW + 'px');
      chk(m.scoreFs === '34px', '桌面档比分字号放大到 34px', 'got ' + m.scoreFs);
      chk(m.stemFs === '15px', '桌面档题干放大到 15px', 'got ' + m.stemFs);
    }
    if (c.tag === 'm375') chk(m.scoreFs === '28px', '移动档比分字号 28px', 'got ' + m.scoreFs);

    if (c.shot) await shot(c.shot);
  }

  // 本次断点重构的核心目标：真源里不得再有 orientation 判据（注释里提历史不算）
  const cssText = fs.readFileSync(path.join(TMP, 'pk.css'), 'utf8');
  const orInMedia = (cssText.match(/@media[^{]*orientation/g) || []).length;
  chk(orInMedia === 0, '真源 pk.css 已无 `@media … orientation` 判据', 'found ' + orInMedia);

  console.log('\n── JS 异常 ──');
  chk(jsErrors.length === 0, '全程零页面异常', jsErrors.join(' | ') || 'none');
} finally {
  try {
    ws && ws.close();
  } catch (_) {}
  chrome.kill();
  srv.close();
  await sleep(220);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  } catch (_) {}
}

console.log('\n截图目录：' + SHOTS);
console.log(fails.length === 0 ? '✅ 全部断言通过' : `❌ ${fails.length} 条未通过:\n  - ` + fails.join('\n  - '));
process.exit(fails.length ? 1 : 0);
