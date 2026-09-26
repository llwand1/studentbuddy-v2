/**
 * cards-pixel-cdp — 卡牌游戏皮「像素层 + 特效层」的**真机几何探针**（零依赖：Node 22 fetch + WebSocket 直驱 CDP）。
 *
 * ★ 为什么需要它（本仓的账）：B-020 的通则写得很清楚——**动效的取证必须带几何断言**，
 *   静态截图只能证明"这一帧有没有东西"，证明不了"它相对谁居中、有没有被父盒裁掉"。
 *   2026-09-26 像素批把星槽／角标／进度轨／粒子改成硬边点阵，新增的三件事全都**只在真样式计算里**才判得出：
 *     ① 8 颗像素星在 168px 卡宽下到底溢不溢出（`cards-view.css` 的 `.cv-card` 有 `overflow: hidden` ⇒ 溢出＝静默裁）；
 *     ② 全息扫描线是否真的只挂在进了视口的卡上（`.gm-seen` 合成层闸，见 `use-in-view.ts`）；
 *     ③ 开盒彩带 16 片有没有被 `.gm-ritual` 的圆角白框裁住（B-020 ④ 同族）。
 *   jsdom 与 `*.test.tsx` 结构上做不了这些判断，`card-motion.test.ts` 锁的是源码一致性，也不是运行态。
 *
 * ★ 它测的是**真产品**：走 vite 页面 ＋ 真 `/api/*` 写口 ＋ 真 SSE ⇒ 组件怎么拼 DOM，探针就怎么量，
 *   不手搭骨架（同族先例 `terms-layout-cdp.mjs` 手搭 DOM，它的文件头就承认"骨架会腐烂"）。
 *
 * 前置（**隔离实例，别对着真实数据目录跑**；生产端口 18791／5173 禁写）：
 *   ① `SB_PORT=18899 SB_DATA_DIR=%TEMP%\\sb-cards-ui npm run dev -w @sb/server`
 *   ② `SB_PROXY_TARGET=http://127.0.0.1:18899 npx vite --port 5299 --strictPort`（在 `packages/web` 下）
 *   ③ `SB_APP=http://localhost:5299/ node tools/probes/cards-pixel-cdp.mjs`
 *      ⚠️ vite 在本机只绑 `[::1]`，`http://127.0.0.1:5299` 连不上而 `localhost` 能——所以默认用 `localhost`。
 *   截图落 `SB_SHOT_DIR`（缺省 `%TEMP%\\sb-pixel-shots`），**不入仓**。
 *   本探针会**写数据**：只在临时库里造词条／打复习，跑完自己删掉造出来的词条。
 *
 * 退出码：全绿 0；任一不变量违例 1（打印 `RESULT: FAIL` ＋违例行）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = process.env.SB_APP ?? 'http://localhost:5299/';
const OUT = process.env.SB_SHOT_DIR ?? join(tmpdir(), 'sb-pixel-shots');
const PORT = Number(process.env.SB_CDP_PORT) || 9300 + Math.floor(Math.random() * 400);
const VW = 1360;
const VH = 900;
/** 造多少条词条：卡墙要**高过一屏**，`useInViewIds` 那道闸才有"没进视口"的卡可关 */
const SEED_N = Number(process.env.SB_SEED_N ?? 28);
const DOMAIN = '探针像素域';

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const profile = join(tmpdir(), `sb-pixel-cdp-${Date.now()}`);
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
console.log('Browser =', version.Browser, '| APP =', APP, '| DPR 请求 = 2');

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

/* ── 1. 走产品自己的写口造数据（临时库，跑完删）────────────────────────────── */
const seeded = await evalJs(`(async () => {
  const j = async (p, opt) => (await fetch(p, opt)).json();
  const made = [];
  for (let i = 0; i < ${SEED_N}; i++) {
    const r = await j('/api/terms', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: '探针词' + i, definition: '探针释义，长度为八到十二个字左右' + i, domain: ${JSON.stringify(DOMAIN)} }) });
    if (r?.id) made.push({ id: r.id, term: r.term });
  }
  await j('/api/terms/review/scope', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain: ${JSON.stringify(DOMAIN)}, enabled: true }) });
  // ★ 深度全交给下面那份 SQL（只写**过去**某天，把"今天"留空）：I7 那颗靶子要靠
  //   一次真写口的复习**新增一个不同的天**才会升星，今天已经被占掉的卡再怎么点都不会动。
  return made;
})()`);
console.log('造出的词条 =', Array.isArray(seeded) ? seeded.length : JSON.stringify(seeded));

/* ── 1b. 把复习流水铺到**不同的天**上（★ 这一步必须直接写库，说明如下）────────
   卡数口径是 `COUNT(DISTINCT reviewed_day)`（`learning/term-cards.ts#cardsByTerm`），
   而 `reviewed_day` 由服务端时钟写死 ⇒ **产品没有任何写口能把复习记到过去某天**。
   探针要的是"墙上有 N/R/SR/SSR 四档"这个**画面事实**，不是复习这件事本身，
   所以这里绕开写口直接往**临时库**插行。★ 三条护栏：
     ① 只接受 `SB_PROBE_DB` 显式给出的路径，且必须在系统临时目录下（防手滑指到真实库）；
     ② 只插 `term_review_log`，只动本探针自己刚造的那批 `term_id`；
     ③ 探针末尾把整条域删掉（走产品 DELETE 写口），临时库也不留。 */
const PROBE_DB = process.env.SB_PROBE_DB ?? '';
const norm = (p) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
let backdated = 0;
if (PROBE_DB && norm(PROBE_DB).startsWith(norm(realpathSync(tmpdir()))) && Array.isArray(seeded) && seeded.length) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(PROBE_DB);
  db.pragma('busy_timeout = 4000');
  const ins = db.prepare(
    'INSERT INTO term_review_log (id, term_id, stage, remembered, reviewed_at, reviewed_day) VALUES (?, ?, ?, 1, ?, ?)',
  );
  /** 每张卡的"不同天数"＝卡数（`cardsByTerm` 数的是 `COUNT(DISTINCT reviewed_day)`）：
      N(1)／R(2-3)／SR(4-7)／SSR(8+) 四档同时在墙上出现。
      ★ 全部落在**过去**的连续几天，一格"今天"都不占——I7 的靶子要用真写口新增一天才升星。 */
  const DEPTH = [1, 2, 3, 4, 5, 7, 8, 9];
  const run = db.transaction(() => {
    seeded.forEach((t, k) => {
      const cards = DEPTH[k % DEPTH.length];
      for (let d = 1; d <= cards; d++) {
        const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
        ins.run(`${t.id}-probe-${d}`, t.id, Math.min(d, 7), `${day} 09:00:00`, day);
        backdated += 1;
      }
    });
  });
  run();
  console.log(`补写过去某天的复习行 = ${backdated} 条（临时库，探针末尾随域一起删）`);
  /** ★ 开盒的当日额度也是运行态事实：本探针一天跑两遍就会撞上"今天开满了"，
      那不是被测代码的问题。临时库里的 `chest_open` 全部由探针自己造，直接清空。
      ⚠️ 2026-09-26 第二次跑就空手而归，现查才发现**额度不在流水表上**：它是 `chest_keys`
         那一行计数器（`free_used` / `opened_today`，按 `free_day` 跨天归零），
         `chest_open` 只是流水。所以两张都要清，清一张等于没清。 */
  const opened = db.prepare('DELETE FROM chest_open').run();
  const quota = db.prepare('UPDATE chest_keys SET free_used = 0, opened_today = 0').run();
  console.log(`清掉今日开盒流水 = ${opened.changes} 行；重置额度计数器 = ${quota.changes} 行（临时库）`);
  db.close();
} else {
  console.log('⚠️ 没给 SB_PROBE_DB（或它不在临时目录下）⇒ 墙上只会有 N 档，I4/I5 的闸门测不到。'
    + (PROBE_DB ? `（给的是 ${PROBE_DB}，临时目录根 ${realpathSync(tmpdir())}）` : ''));
}
await evalJs(`location.reload()`);
await sleep(2600);

/* ── 2. 切到卡牌页 ─────────────────────────────────────────────────────────── */
const nav = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.sb-nav-item')].find((x) => x.textContent.includes('卡牌'));
  if (!b) return 'no-nav';
  b.click();
  return 'ok';
})()`);
console.log('点「卡牌」=', nav);
await sleep(1800);
await shot('01-wall-top');

/* ── 3. I1/I2/I3/I8：墙上量像素（不点任何东西就能判的那批）─────────────────── */
const wall = await evalJs(`(() => {
  const r2 = (v) => Math.round(v * 100) / 100;
  const cards = [...document.querySelectorAll('.gm-card')];
  const clipChain = (e) => {   // 走到根，列出"装不下我又不给滚动条"的裁切框（B-017 那套判据的横向版）
    const bad = [];
    let cur = e.parentElement;
    while (cur && cur !== document.body) {
      const cb = cur.getBoundingClientRect(), eb = e.getBoundingClientRect();
      const ox = getComputedStyle(cur).overflowX;
      if (/hidden|clip|auto|scroll/.test(ox) && (eb.right > cb.right + 1 || eb.left < cb.left - 1)) {
        const scrolls = cur.scrollWidth > cur.clientWidth + 1 && !/hidden|clip/.test(ox);
        if (!scrolls) bad.push(cur.className || cur.tagName);
      }
      cur = cur.parentElement;
    }
    return bad;
  };
  return {
    dpr: devicePixelRatio,
    cardCount: cards.length,
    wallWidth: r2(document.querySelector('.gm-wall')?.getBoundingClientRect().width ?? 0),
    // 台账里那条算术（"168px 轨扣掉边框与内边距只剩 140px 可用"）在这儿变成实测值
    cardBox: [...new Set(cards.map((c) => {
      const cs = getComputedStyle(c);
      return [r2(c.getBoundingClientRect().width), r2(c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))].join('/');
    }))].slice(0, 6),
    footInner: cards.slice(0, 4).map((c) => {
      const f = c.querySelector('.gm-card-foot');
      return f ? { sw: f.scrollWidth, cw: f.clientWidth, starW: r2(f.querySelector('.cv-starline, .gm-stars')?.getBoundingClientRect().width ?? 0) } : null;
    }).filter(Boolean),
    cardWidths: [...new Set(cards.map((c) => r2(c.getBoundingClientRect().width)))].slice(0, 6),
    // I1：脚行（角标＋星位）溢出＝静默裁
    foot: cards.map((c) => {
      const f = c.querySelector('.gm-card-foot');
      if (!f) return null;
      return { tid: c.dataset.tid, rarity: c.dataset.r, sw: f.scrollWidth, cw: f.clientWidth,
        clipped: f.scrollWidth - f.clientWidth, clipper: clipChain(f), seen: c.classList.contains('gm-seen') };
    }).filter(Boolean),
    // I2：硬边落点的**计算值**（源码锁查的是文本，这里查的是真样式）
    radii: {
      count: [...new Set(cards.map((c) => getComputedStyle(c.querySelector('.gm-card-count')).borderRadius))],
      star: [...new Set([...document.querySelectorAll('.gm-stars > i')].map((i) => getComputedStyle(i).borderRadius))].slice(0, 4),
      track: [...new Set([...document.querySelectorAll('.gm-track.gm-px')].map((t) => getComputedStyle(t).borderRadius))],
      spark: null,
    },
    // I3：点阵精灵——crispEdges 在不在、CSS 边长是不是 8 的整数倍、一格换算成物理像素是多少
    sprites: [...new Set([...document.querySelectorAll('.cv-card svg, .cv-wall svg')].map((s) => {
      const w = r2(s.getBoundingClientRect().width);
      const vb = s.getAttribute('viewBox') || '';
      return [s.getAttribute('shape-rendering'), vb, w, w % 8 === 0 ? 0 : 1, r2(w / (Number(vb.split(' ')[2]) || 8))].join('|');
    }))],
    // I8：进度轨填充宽度对得上 --gm-w 吗
    tracks: [...document.querySelectorAll('.gm-track.gm-px')].slice(0, 5).map((t) => {
      const fill = t.querySelector('i');
      return { varW: getComputedStyle(fill).getPropertyValue('--gm-w').trim() || getComputedStyle(t).getPropertyValue('--gm-w').trim(),
        trackW: r2(t.getBoundingClientRect().width), fillW: r2(fill.getBoundingClientRect().width) };
    }),
    // I4/I5：全息层是否只挂在 .gm-seen 的卡上
    srSeen: [...document.querySelectorAll('.gm-card[data-r="SR"]')].map((c) => ({ seen: c.classList.contains('gm-seen'),
      anim: getComputedStyle(c, '::before').animationName })),
    ssrSeen: [...document.querySelectorAll('.gm-card[data-r="SSR"]')].map((c) => ({ seen: c.classList.contains('gm-seen'),
      anim: getComputedStyle(c, '::after').animationName })),
    running: document.getAnimations().filter((a) => a.playState === 'running').map((a) => {
      const t = a.effect?.target;
      const cls = typeof t?.getAttribute === 'function' ? (t.getAttribute('class') || t.tagName) : String(t?.className || t?.tagName);
      return { name: a.animationName ?? 'transition', infinite: a.effect?.getTiming?.().iterations === Infinity,
        pseudo: a.effect?.pseudoElement || '', cls: String(cls).slice(0, 42) };
    }),
  };
})()`);
console.log('墙上量到：', JSON.stringify(wall, null, 1).slice(0, 4000));

/* ── 4. I7：升星爆帧——用真写口触发，采样粒子中心与卡片中心的差 ─────────────── */
/** ★ 靶子必须是"卡数刚好停在 3"那张：今天再复习一次就是第 4 个不同的天
    ⇒ 卡数 3→4、★1→★2，`useUpgraded` 才会登记 burst。
    ★ 这里**从 DOM 上找**而不是照着造数据的下标猜——墙有排序，下标对不上画面，
      上一版就是这么空手而归的（0 帧样本不等于"没动画"，等于"靶子挑错"）。 */
const targetTid = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.gm-card')];
  /** 文本是「N 张」，直接 Number() 会得 NaN，先抠数字（注释里别打反引号，这里整段是模板字符串）。 */
  const fmt = cards.map((c) => {
    const raw = (c.querySelector('.gm-card-count')?.textContent ?? '').trim();
    return { tid: c.getAttribute('data-tid'), n: Number(raw.match(/\\d+/)?.[0]), burst: c.classList.contains('gm-burst') };
  });
  const hit = fmt.find((f) => f.n === 3 && !f.burst);
  window.__sbProbeTargets = fmt;
  return hit ? String(hit.tid) : ('none｜屏上卡数是 ' + fmt.map((f) => f.n).join(','));
})()`);
console.log('爆帧靶子 =', targetTid);
let burst = '{"note":"没找到卡数=3 的卡，跳过"}';
if (/^[\w-]+$/.test(String(targetTid))) {
  const armed = await evalJs(`(() => {
    const card = document.querySelector('.gm-card[data-tid="${targetTid}"]');
    if (!card) return '那张卡不在屏上（被领域筛选挡住了？）';
    window.__sbBurst = { samples: [] };
    const tick = () => {
      const sparks = [...card.querySelectorAll('.gm-spark')];
      if (!sparks.length) return;
      const c = card.getBoundingClientRect();
      const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
      const pts = sparks.map((s) => {
        const b = s.getBoundingClientRect();
        const o = Number(getComputedStyle(s).opacity);
        return { dx: b.left + b.width / 2 - cx, dy: b.top + b.height / 2 - cy, w: b.width, o };
      });
      /** ★ 粒子是从中心往外飞的，所以"整体是否回中"看的是**最远那颗与最近那颗的中点**：
          若中心算错了，整个点云的包围盒会朝一个方向偏（首版偏 (-61,-59)px，见 B-020 ⑥）。 */
      const mid = (key) => (Math.max(...pts.map((p) => p[key])) + Math.min(...pts.map((p) => p[key]))) / 2;
      window.__sbBurst.samples.push({
        at: Math.round(performance.now()),
        visible: pts.filter((p) => p.o > 0.05).length,
        cloudMidX: Math.round(mid('dx')), cloudMidY: Math.round(mid('dy')),
        reach: Math.round(Math.max(...pts.map((p) => Math.hypot(p.dx, p.dy)))),
        size: pts[0]?.w ?? 0,
        radii: [...new Set(sparks.map((s) => getComputedStyle(s).borderRadius))],
        timing: getComputedStyle(sparks[0]).animationTimingFunction,
        flash: (() => { const f = card.querySelector('.gm-flash'); return f ? Number(getComputedStyle(f).opacity) : null; })(),
      });
    };
    const h = setInterval(tick, 90);
    setTimeout(() => clearInterval(h), 1500);
    return 'armed';
  })()`);
  console.log('爆帧采样器 =', armed);
  await evalJs(`fetch('/api/terms/${targetTid}/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remembered: true }) }).then(() => 'sent')`);
  await sleep(700);
  await shot('02-burst');
  await sleep(800);
  burst = await evalJs(`JSON.stringify(window.__sbBurst ?? { note: '没采到样本' })`);
}

/* ── 5. I6：开盒彩带是否被仪式框裁住 ───────────────────────────────────────── */
const chestBtn = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.cv-chest-actions .gm-btn')].find((x) => !x.disabled && x.textContent.includes('开'));
  if (!b) return 'no-btn｜那格现在写着：' + (document.querySelector('.cv-chest-actions')?.innerText.replace(/\s+/g, ' ') ?? '(没有这一格)');
  window.__sbConfetti = [];
  const grab = () => {
    const ritual = document.querySelector('.gm-ritual');
    if (!ritual) return;
    const rb = ritual.getBoundingClientRect();
    const pieces = [...document.querySelectorAll('.gm-confetti > i')];
    if (!pieces.length) return;
    const cs = getComputedStyle(ritual);
    const wrap = document.querySelector('.gm-confetti');
    window.__sbConfetti.push({
      at: Math.round(performance.now()), n: pieces.length,
      ritual: { w: Math.round(rb.width), h: Math.round(rb.height), overflow: cs.overflow, radius: cs.borderRadius },
      wrapOverflow: wrap ? getComputedStyle(wrap).overflow : null,
      outside: pieces.filter((p) => { const b = p.getBoundingClientRect(); return b.right > rb.right + 1 || b.left < rb.left - 1 || b.top < rb.top - 1 || b.bottom > rb.bottom + 1; }).length,
      invisible: pieces.filter((p) => Number(getComputedStyle(p).opacity) < 0.05).length,
      radius: [...new Set(pieces.map((p) => getComputedStyle(p).borderRadius))],
      colors: [...new Set(pieces.map((p) => getComputedStyle(p).backgroundColor))],
      timing: getComputedStyle(pieces[0]).animationTimingFunction,
    });
  };
  const h = setInterval(grab, 120);
  setTimeout(() => clearInterval(h), 1600);
  b.click();
  return 'clicked';
})()`);
console.log('点开盒 =', chestBtn);
await sleep(900);
await shot('03-chest-reveal');
const confetti = await evalJs(`JSON.stringify(window.__sbConfetti ?? [])`);

/* ── 6. 收尾：把造出来的词条删掉（只删自己造的）────────────────────────────── */
const cleaned = await evalJs(`(async () => {
  const ids = ${JSON.stringify((Array.isArray(seeded) ? seeded : []).map((s) => s.id))};
  let n = 0;
  for (const id of ids) { const r = await fetch('/api/terms/' + id, { method: 'DELETE' }); if (r.ok) n++; }
  return n;
})()`);
console.log('删掉自造词条 =', cleaned);

/* ── 7. 判定 ───────────────────────────────────────────────────────────────── */
const fails = [];
const W = wall ?? {};
if ((W.cardCount ?? 0) < 6) fails.push(`I0 卡墙只有 ${W.cardCount} 张，样本不足以判溢出/视口闸`);
for (const f of W.foot ?? []) {
  if (f.clipped > 1) fails.push(`I1 卡脚溢出又没滚动条：tid=${f.tid} scrollWidth=${f.sw} clientWidth=${f.cw} 差=${f.clipped}px`);
  if (f.clipper.length) fails.push(`I1 脚行被祖先静默裁切：tid=${f.tid} 裁它的=${f.clipper.join(',')}`);
}
const nz = (arr, what) => (arr ?? []).filter((v) => v !== '0px').forEach((v) => fails.push(`I2 ${what} 计算值不是硬边：border-radius=${v}`));
nz(W.radii?.count, '.gm-card-count'); nz(W.radii?.track, '.gm-track.gm-px'); nz(W.radii?.star, '.gm-stars > i');
if (!(W.srSeen ?? []).length && !(W.ssrSeen ?? []).length) {
  fails.push('I0 墙上一张 SR/SSR 都没有 ⇒ 四档没铺起来（SB_PROBE_DB 没给？），I4 那道视口闸这轮等于没测');
}
for (const s of W.sprites ?? []) {
  const [sr, vb, w, bad] = String(s).split('|');
  if (sr !== 'crispEdges') fails.push(`I3 精灵没声明 crispEdges：shape-rendering=${sr} viewBox=${vb}`);
  if (bad !== '0') fails.push(`I3 调用点边长不是 8 的整数倍：${w}px（一格会摊成 ${Number(w) % 8} 分之一格）`);
}
const srBad = (W.srSeen ?? []).filter((c) => c.anim === 'gmScan' && !c.seen);
if (srBad.length) fails.push(`I4 扫描线绕过视口闸：${srBad.length} 张 SR 卡没进视口却在跑 gmScan`);
const ssrBad = (W.ssrSeen ?? []).filter((c) => c.anim === 'gmSheen' && !c.seen);
if (ssrBad.length) fails.push(`I4 全息绕过视口闸：${ssrBad.length} 张 SSR 卡没进视口却在跑 gmSheen`);
/** 反向也查：闸**关过头**（进了视口却不亮）同样是 bug，只是症状反过来 */
const srDark = (W.srSeen ?? []).filter((c) => c.seen && c.anim !== 'gmScan');
if (srDark.length) fails.push(`I5 ${srDark.length} 张已进视口的 SR 卡没跑 gmScan（闸门关过头／规则漂了）`);
const loops = (W.running ?? []).filter((a) => a.infinite);
const holoLoops = loops.filter((l) => l.name === 'gmSheen' || l.name === 'gmScan');
console.log(`屏上真在跑的常驻循环 ${loops.length} 条，其中全息层 ${holoLoops.length} 张：`
  + [...new Set(loops.map((l) => `${l.name}@${l.cls.replace(/cv-card gm-card\S*/g, 'card').slice(0, 24)}${l.pseudo ? '::' + l.pseudo : ''}`))].join(' / '));
if (holoLoops.length > 6) {
  fails.push(`I5 全息层同时在跑 ${holoLoops.length} 张 > MAX_HOLO_LAYERS=6 ⇒ 那道裁层没生效（B-022：不封顶实测 17 层）`);
}
if (loops.length > 9) fails.push(`I5 常驻循环总数 ${loops.length} > 9（全息 6 ＋ 吉祥物／宝箱灯这类非全息层最多 3 条）`);
for (const t of W.tracks ?? []) {
  const declared = parseFloat(t.varW);
  if (Number.isFinite(declared) && declared === 0 && t.fillW > 1) fails.push(`I8 --gm-w:0% 却量到 ${t.fillW}px 宽`);
}
const conf = JSON.parse(confetti || '[]');
const bu = JSON.parse(burst || '{}');
const samples = bu.samples ?? [];
if (!samples.length) fails.push(`I7 升星爆帧一帧都没采到（${bu.note ?? JSON.stringify(bu).slice(0, 80)}）——写口触发了但卡上没出现粒子？`);
const peak = Math.max(0, ...samples.map((s) => s.visible));
/** ★ 判"回中"只能看**落定那几帧**，不能拿全程最大值卡：16 颗粒子按 `nth-child` 错帧起飞
    （0→330ms），中途先起飞的已经飞满、还在原地的把包围盒往起飞方向拽——实测峰值偏移
    (12,-16)px 就是这个错帧瞬态，不是中心算错。真把中心算错（首版少了 `translate(-50%,-50%)`、
    偏 (-61,-59)px）的话**落定帧照样偏**，所以下面这两条都成立、都能逮到：
      ① 落定帧（最后 3 帧）的点云中心 ≤ 6px；
      ② 全程任一秒的偏移 ≤ 20px（瞬态也不能歪出卡片去，否则就是轨道错了）。 */
const tail = samples.slice(-3);
const settled = tail.length ? { x: Math.round(tail.reduce((a, s) => a + s.cloudMidX, 0) / tail.length),
  y: Math.round(tail.reduce((a, s) => a + s.cloudMidY, 0) / tail.length) } : null;
const worst = samples.reduce((a, s) => Math.max(a, Math.abs(s.cloudMidX), Math.abs(s.cloudMidY)), 0);
if (settled && (Math.abs(settled.x) > 6 || Math.abs(settled.y) > 6)) {
  fails.push(`I7 粒子点云没回中：落定帧云中心相对卡片中心偏 (${settled.x}, ${settled.y})px（首版偏 (-61,-59) 就是这么逮的）`);
}
if (worst > 20) fails.push(`I7 飞行途中点云偏了 ${worst}px > 20px——错帧瞬态不该这么大，粒子轨道方向有问题`);
if (samples.some((s) => s.radii.some((r) => r !== '0px'))) fails.push('I2 粒子不是硬边（border-radius 非 0）');
console.log(`爆帧峰值同时可见颗粒 = ${peak}，采样 ${samples.length} 帧，落定偏移 = `
  + `(${settled?.x ?? '?'}, ${settled?.y ?? '?'})px，全程最大瞬态 = ${worst}px，尺寸/缓动 = ${JSON.stringify(samples[0] ?? {})}`);
if (samples.length && peak < 8) fails.push(`I7 峰值只有 ${peak} 颗粒子看得见（16 颗的预算没传达出来，B-020 ⑥ 原症状）`);
if (!conf.length) fails.push('I6 彩带一帧都没采到（开盒没触发？还是颗数为 0？）');
for (const c of conf) {
  if (c.n !== 16) fails.push(`I6 彩带片数=${c.n}，与 CONFETTI=16 不符`);
  if (c.radius.some((r) => r !== '0px')) fails.push(`I6 彩带不是硬边：${c.radius.join(',')}`);
  if (c.outside > 0 && /hidden|clip|auto|scroll/.test(c.ritual.overflow)) {
    fails.push(`I6 有 ${c.outside} 片跑到 .gm-ritual 外又被它裁掉（overflow=${c.ritual.overflow}，框 ${c.ritual.w}×${c.ritual.h}）⇒ 彩带出不了框，B-020 ④ 同族`);
    break;
  }
}
writeFileSync(join(OUT, 'wall.json'), JSON.stringify({ wall, burst: bu, confetti: conf }, null, 1));
console.log('取证落盘 =', join(OUT, 'wall.json'), '| 截图目录 =', OUT);
chrome.kill();
await sleep(600);   // ★ 先杀进程再删 profile：Edge 锁着 `CrashpadMetrics-active.pma`，边删边抛 EBUSY
try { rmSync(profile, { recursive: true, force: true }); } catch (e) { console.log('⚠️ profile 没删干净（不影响判定）：', e.code); }
for (const line of conf) console.log('彩带帧 =', JSON.stringify(line));
if (fails.length) {
  console.log('RESULT: FAIL');
  for (const x of fails) console.log('  ✘ ' + x);
  process.exit(1);
}
console.log('RESULT: PASS');
process.exit(0);
