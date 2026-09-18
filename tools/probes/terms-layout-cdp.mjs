/**
 * terms-layout-cdp.mjs — 词条页布局「不被撑爆」真机探针（零依赖，直驱无头 Chrome）。
 *
 * ★ 为什么需要它（真事故）：`80e97a4` 把复习面板（艾宾浩斯）插进词条页后，**词条库本体整个不可达**——
 *   页面是「固定高度 + `overflow:hidden` + 只有 `.term-list` 一个弹性子项」的布局，
 *   复习面板按内容撑到 **2073px**，把唯一的弹性子项压成 **4px**，工具栏/添加框被推出视口，
 *   父级 `overflow:hidden` 连滚动条都不给 ⇒ 搜索/手动添加/编辑/删除全看不见也无处可滚。
 *   **本仓 web 侧无 jsdom，编译/单测/gates 对这类 bug 完全无感**，只有真机量像素能拦住。
 *
 * 本探针断言的是**不变量**（不是像素快照，避免一改样式就假红）：
 *   I1 页面不被裁：`.term-page` 的 `scrollHeight` 不得显著超过 `clientHeight`（否则内容静默不可达）
 *   I2 复习面板有界：`.rv-panel` 高度 ≤ 视口的 45%（它曾无界 → 2073px）
 *   I3 词条库本体在场：`.term-list` 高度 ≥ 150px 且落在可见区内
 *   I4 CRUD/查询在场：搜索框、添加框、首条的编辑/删除、添加按钮 全部落在可见区内
 *   I5 滚动归位：列表自身可滚（内滚而非靠整页滚）
 * 三态各跑一遍：无面板（基线）／面板收起（默认）／面板展开（点开队列）。
 *
 * ★ **已知局限（必须知道，别拿它当全覆盖）**：DOM 是**按 `TermsPage.tsx` / `ReviewPanel.tsx`
 *   的 JSX 结构手搭**的，CSS 从源真读。所以它只测「布局规则 + 这个结构」的组合，
 *   若有人改了组件的 DOM 结构，探针会测一份**过期的结构**（此时需同步更新本文件的 DOM 骨架）。
 *   同理它不验数据、不验交互逻辑，只验「东西在不在可视区里」。
 *
 * 前置：本机装有 Chrome（路径同同目录其它探针），**无需** vite / 服务器 / 登录（纯静态渲染）。
 * 端口：CDP 端口随机（9300+rand(400)），可 `SB_CDP_PORT` 覆盖；起 Chrome 前先探端口占用。
 * 用法：node tools/probes/terms-layout-cdp.mjs   （全绿 EXIT=0；任一断言失败 EXIT=1）
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '../../packages/web/src');
const readCss = (p) => readFileSync(join(WEB_SRC, p), 'utf8');
const ALL_CSS = [readCss('styles/tokens.css'), readCss('app/app.css'), readCss('features/terms/terms.css')].join('\n');

/** 复习面板的队列项（20 条 = 服务端 QUEUE_LIMIT，也是把页面撑爆的那个量） */
const rvQueue = (n) =>
  Array.from({ length: n }, (_, i) => `
    <div class="rv-item rv-overdue"><div class="rv-item-main">
      <div class="rv-item-top"><span class="rv-term">恢复系${i}</span><span class="rv-domain">biology</span>
      <span class="rv-badge rv-badge-overdue">逾期 ${15 - (i % 15)} 天</span><span class="rv-days">${15 - (i % 15)} 天没复习</span></div>
      <button class="rv-btn">看释义</button>
      <div class="rv-meta">第 1/7 节点 · 记忆保持 ≈ 42%</div>
    </div><div class="rv-item-actions"><button class="rv-btn ok">记住了</button><button class="rv-btn danger">忘了</button></div></div>`).join('');

const termList = (n) =>
  Array.from({ length: n }, (_, i) => `
    <div class="term-item"><div class="term-main">
      <div class="term-top"><span class="term-name">恢复系${i}</span><span class="term-domain">biology</span><span class="term-used">已在对话中使用 7 次</span></div>
      <div class="term-def">三系之一，花粉可育且含有恢复因子。</div>
      <div class="term-meta"><span>2026-09-17</span><span class="term-rv overdue">15 天没复习</span></div>
    </div><div class="term-side"><div class="term-imp"><i style="--imp-w:100%"></i></div>
    <div class="term-actions"><button class="term-btn">编辑</button><button class="term-btn danger">删除</button></div></div></div>`).join('');

const rvPanel = (state) => {
  if (state === 'none') return '';
  const open = state === 'expanded';
  return `<div class="rv-panel">
    <div class="rv-head">
      <b>复习计划</b>
      <span class="rv-sum"><span class="rv-sum-warn">逾期 217</span><span>待复习 271</span><span>今日已复习 7</span></span>
      <button class="rv-toggle">${open ? '收起队列' : '展开队列'}<i class="${open ? 'rv-caret on' : 'rv-caret'}"></i></button>
    </div>
    ${open ? `
    <div class="rv-sched">经典节点 1 / 2 / 4 / 7 / 15 / 30 / 60 天</div>
    <div class="rv-stats"><span class="rv-stat"><b>271</b> 待复习</span><span class="rv-stat rv-stat-warn"><b>217</b> 逾期</span><span class="rv-stat"><b>7</b> 今日已复习</span><span class="rv-stat"><b>15</b> 天最久欠账</span><span class="rv-stat"><b>0</b> 已入长期记忆</span></div>
    <div class="rv-bars">${Array.from({ length: 7 }, (_, i) => `<span class="rv-bar-wrap"><i class="rv-bar" style="--rv-h:${i * 10}%"></i><em>09-1${i}</em></span>`).join('')}</div>
    <div class="rv-queue-head">今日队列（先还旧账）</div>
    <div class="rv-queue">${rvQueue(20)}</div>` : ''}
  </div>`;
};

/** 与 TermsPage.tsx 的 JSX 同构（改动组件结构时**必须同步改这里**，见文件头「已知局限」） */
const html = (state) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${ALL_CSS}
  html,body{margin:0;height:100%}#root{height:100%}
</style></head><body><div id="root"><div class="sb-shell"><div class="sb-sidebar"></div><div class="sb-main">
  <div class="term-page">
    <div class="term-head"><h2>词条库</h2><span class="term-sub">AI 会在对话中自动记住重要词条，之后回答会优先使用这些术语</span></div>
    <div class="term-stats"><span class="term-stat"><b>278</b> 词条</span><span class="term-stat"><b>12</b> 领域</span><span class="term-stat"><b>3</b> 今日新增</span></div>
    <div class="term-preferred"><span class="term-preferred-label">偏好领域</span><button class="term-preferred-chip on">cs<span class="term-preferred-num">62</span></button><button class="term-preferred-chip">biology<span class="term-preferred-num">66</span></button></div>
    ${rvPanel(state)}
    <div class="term-toolbar">
      <div class="term-tabs"><button class="term-tab on">全部</button><button class="term-tab">cs<span class="term-tab-count">67</span></button></div>
      <div class="term-search"><input placeholder="搜词条…"></div>
    </div>
    <div class="term-list">${termList(12)}</div>
    <div class="term-add">
      <div class="term-add-title">手动添加词条</div>
      <div class="term-add-row"><input placeholder="词条"><input placeholder="领域"></div>
      <div class="term-add-row"><input class="term-add-def" placeholder="释义"><button class="term-btn primary">添加</button></div>
    </div>
  </div>
</div></div></div></body></html>`;

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const r = (s) => { const e = q(s); if (!e) return null; const b = e.getBoundingClientRect();
    return { top: Math.round(b.top), h: Math.round(b.height), inView: b.height > 4 && b.top < innerHeight && b.bottom <= innerHeight + 1 }; };
  const page = q('.term-page'); const qq = q('.rv-queue'); const list = q('.term-list');
  return {
    vh: innerHeight,
    pageClientH: page.clientHeight, pageScrollH: page.scrollHeight,
    rvPanelH: q('.rv-panel') ? Math.round(q('.rv-panel').getBoundingClientRect().height) : 0,
    rvQueue: qq ? { h: Math.round(qq.getBoundingClientRect().height), scrolls: qq.scrollHeight > qq.clientHeight + 1 } : null,
    termList: r('.term-list'), listScrolls: list ? list.scrollHeight > list.clientHeight + 1 : false,
    searchInput: r('.term-search'), termAdd: r('.term-add'),
    editBtn: r('.term-actions .term-btn'), delBtn: r('.term-actions .term-btn.danger'), addBtn: r('.term-add .term-btn.primary'),
  };
})()`;

const PORT = Number(process.env.SB_CDP_PORT) || 9300 + Math.floor(Math.random() * 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 起前先探端口：残留 Chrome 占着端口会连到别人的浏览器
try {
  const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.error(`端口 ${PORT} 上已有 CDP 实例（${j.Browser}）——拒绝继续，否则会连到别人的浏览器。可 SB_CDP_PORT 换一个。`);
  process.exit(1);
} catch { /* 空着，可以用 */ }

const CHROME = process.env.SB_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'sbprobe-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

let ver = null;
for (let i = 0; i < 40 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); } }
if (!ver) { console.error('CDP 未就绪'); chrome.kill(); process.exit(1); }
console.log('Chrome =', ver.Browser);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable');
const frameId = (await send('Page.getFrameTree')).result.frameTree.frame.id;

const STATE_NAME = { none: '无面板（基线）', collapsed: '面板收起（默认）', expanded: '面板展开' };
let pass = 0; let fail = 0;
const ck = (ok, label, detail) => { if (ok) { pass++; console.log(`    ✓ ${label}`); } else { fail++; console.log(`    ✗ ${label}${detail ? ` —— ${detail}` : ''}`); } };

for (const vh of [800, 1000]) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: vh, deviceScaleFactor: 1, mobile: false });
  for (const st of ['none', 'collapsed', 'expanded']) {
    await send('Page.setDocumentContent', { frameId, html: html(st) });
    await sleep(320);
    const m = (await send('Runtime.evaluate', { expression: MEASURE, returnByValue: true })).result?.result?.value;
    console.log(`\n[1280×${vh}] ${STATE_NAME[st]}  （面板 ${m.rvPanelH}px / 列表 ${m.termList.h}px）`);

    ck(m.pageScrollH <= m.pageClientH + 1, 'I1 页面不被裁',
      `scrollH ${m.pageScrollH} > clientH ${m.pageClientH} ⇒ 内容静默不可达`);
    ck(m.rvPanelH <= vh * 0.45, 'I2 复习面板有界',
      `面板 ${m.rvPanelH}px > 视口 45%(${Math.round(vh * 0.45)}px)`);
    ck(m.termList.h >= 150 && m.termList.inView, 'I3 词条库本体在场',
      `列表高 ${m.termList.h}px，在视区内 ${m.termList.inView}`);
    ck(m.listScrolls, 'I5 列表自身可滚');
    for (const [label, el] of [['搜索框', m.searchInput], ['添加框', m.termAdd], ['编辑按钮', m.editBtn], ['删除按钮', m.delBtn], ['添加按钮', m.addBtn]]) {
      ck(Boolean(el && el.inView), `I4 ${label}可见`, el ? `top ${el.top} 高 ${el.h}` : '元素不存在');
    }
    if (m.rvQueue) ck(m.rvQueue.scrolls || m.rvQueue.h === 0, 'I6 展开态队列内滚', `队列高 ${m.rvQueue.h}px 但不可滚`);
  }
}

console.log(`\n${fail === 0 ? '✓ 全绿' : '✗ 有失败'}：${pass} passed, ${fail} failed`);
ws.close(); chrome.kill();
process.exit(fail === 0 ? 0 : 1);
