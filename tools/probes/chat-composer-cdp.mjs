/**
 * chat-composer-cdp — 对话页输入区改版（「+」折叠菜单 + 来源清单移进消息流 + 侧栏「对战」入口）
 * 的真机渲染核验探针。零依赖：Node 22 内置 fetch + WebSocket 直驱 CDP。
 *
 * 为什么需要它：纯函数测不到 DOM，而 `.test.tsx`（jsdom，2026-09-20 起）也测不到**真 CSS 与真实浏览器行为**
 * ——jsdom 里没有样式计算、没有 `elementFromPoint`。「+」菜单能不能点开、点开后五项在不在、
 * 状态摘要「联网已开」有没有挂在触发器上、按钮是不是真的从输入框那行消失了，只有真渲染才有答案。
 * 同 `quiz-e2e-cdp.mjs` 的理由。
 *
 * 用法（**必须先把服务起起来**）：
 *   node tools/probes/chat-composer-cdp.mjs [场景名]
 *   # 例：node tools/probes/chat-composer-cdp.mjs after
 * 前置：后端在 18791（默认代理目标）＋ 前端 `vite` 在 **5174**（本探针把 5174 写死在 APP 常量，
 *       与 `quiz-e2e-cdp.mjs` 同口径；5173 上跑的是另一个项目）。
 * 截图落在 `SB_SHOT_DIR`（缺省＝系统临时目录），**不入仓**。
 *
 * ★ 数据自清：本探针会用界面上的「新对话」真建一个会话（不建会话则菜单触发器是禁用的、
 *   点不开），跑完**用页内 fetch 自己删掉**，并复核会话列表回到跑之前的条数——
 *   绝不给用户的真实库留垃圾（test-plan §7 的硬约定）。
 * ★ 不碰 LLM：默认全程不发出题请求，故不花额度、也不依赖模型 key。
 *   只有 `SB_PROBE_QUIZ=1` 时会**真出一次题**（主题「二重积分」）——为的是验「从新菜单触发」这条新接线
 *   （原来是行内按钮直连，现在要经菜单条目转发，纯函数测不到）；跑完连同题库条目一起自清。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334; // 与 quiz-e2e-cdp 的 9333 错开，两个探针可同时跑
const APP = 'http://localhost:5174/';
const OUT = process.env.SB_SHOT_DIR ?? join(process.env.TEMP ?? '/tmp', 'sb-cdp-shots');
const scene = process.argv[2] ?? 'composer';
const profile = join(process.env.TEMP ?? '/tmp', `sb-cdp-composer-${Date.now()}`);

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let version = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) { version = await r.json(); break; }
  } catch { /* 还没起 */ }
  await sleep(250);
}
if (!version) { console.error('CDP 未就绪'); chrome.kill(); process.exit(1); }
console.log('Chrome =', version['Browser']);

const created = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, (m) => res(m.result ?? m.error));
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = join(OUT, `${scene}-${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('shot ->', file);
};

await send('Page.enable');
await send('Runtime.enable');
await sleep(2600); // 等 React 挂载 + 会话列表拉到

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fails += 1;
};

// ── 1. 输入框那行还挤不挤？按钮该没了、只有「+」 ──────────────────────────────
const layout = JSON.parse(await evalJs(`JSON.stringify({
  menuBtns: document.querySelectorAll('.composer-menu-btn').length,
  rowButtons: [...document.querySelectorAll('.chat-composer > button')].map(b => b.textContent.trim() || b.className),
  strayQuizBtnInRow: document.querySelectorAll('.chat-composer > .chat-quiz-btn').length,
  refsAboveComposer: document.querySelectorAll('.chat-composer-wrap .quiz-refs').length,
  docBarAboveComposer: document.querySelectorAll('.chat-composer-wrap .chat-doc-bar').length,
  navLabels: [...document.querySelectorAll('.sb-nav-item')].map(b => b.textContent.trim()),
  triggerDisabled: document.querySelector('.composer-menu-btn')?.disabled ?? null,
  triggerText: document.querySelector('.composer-menu-btn')?.textContent.trim() ?? null,
})`));
console.log('输入区初态 =', JSON.stringify(layout));
check('输入框那行只剩「+」+ 发送（出题/联网/存入记忆/导出已不在行内）', layout.strayQuizBtnInRow === 0 && layout.menuBtns === 1);
check('来源清单不在输入框上方（常驻区已清空）', layout.refsAboveComposer === 0 && layout.docBarAboveComposer === 0);
check('侧栏功能列表含「对战」', layout.navLabels.includes('对战'), JSON.stringify(layout.navLabels));
check('无会话时触发器禁用（那时菜单里每一项确实都不可用）', layout.triggerDisabled === true);
await shot('01-initial');

// ── 2. 侧栏「对战」进得去、也出得来 ──────────────────────────────────────────
const entered = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.sb-nav-item')].find(x => x.textContent.trim() === '对战');
  if (!b) return 'no-nav';
  b.click(); return 'ok';
})()`);
console.log('click 对战 =', entered);
await sleep(1200);
const pk = JSON.parse(await evalJs(`JSON.stringify({
  hash: location.hash,
  hasPk: !!document.querySelector('.sb-pk'),
  back: document.querySelector('.sb-pk-back')?.textContent.trim() ?? null,
  hasShell: !!document.querySelector('.sb-shell'),
})`));
console.log('PK 页 =', JSON.stringify(pk));
check('点「对战」真的进了 PK 页（hash + 根切换都对）', pk.hash.startsWith('#/pk') && pk.hasPk && !pk.hasShell);
check('PK 页有回主壳的出口', !!pk.back, String(pk.back));
await shot('02-pk');

const back = await evalJs(`(() => {
  const a = document.querySelector('.sb-pk-back');
  if (!a) return 'no-back';
  a.click(); return 'ok';
})()`);
console.log('click 返回 =', back);
await sleep(1200);
const returned = JSON.parse(await evalJs(`JSON.stringify({ hash: location.hash, hasShell: !!document.querySelector('.sb-shell') })`));
console.log('返回后 =', JSON.stringify(returned));
check('从 PK 页回得来（主壳与侧栏都在）', returned.hasShell === true && !returned.hash.startsWith('#/pk'));
await shot('03-back');

// ── 3. 建一个会话（否则触发器禁用），再点开「+」 ─────────────────────────────
const idsBefore = JSON.parse(await evalJs(`fetch('/api/sessions').then(r => r.json()).then(a => JSON.stringify(a.map(s => s.id)))`));
console.log('跑之前会话数 =', idsBefore.length);

const newChat = await evalJs(`(() => {
  const b = document.querySelector('.sb-new-chat');
  if (!b) return 'no-btn';
  b.click(); return 'ok';
})()`);
console.log('click 新对话 =', newChat);
let opened = null;
for (let i = 0; i < 20; i += 1) {
  await sleep(300);
  opened = await evalJs(`(() => { const el = document.querySelector('.composer-menu-btn'); return el && !el.disabled ? 'ready' : 'wait'; })()`);
  if (opened === 'ready') break;
}
check('建会话后「+」可用', opened === 'ready');
await sleep(400);

const menuOpen = await evalJs(`(() => {
  const b = document.querySelector('.composer-menu-btn');
  if (!b) return 'no-btn';
  b.click(); return 'ok';
})()`);
console.log('click + =', menuOpen);
await sleep(400);
const menu = JSON.parse(await evalJs(`JSON.stringify({
  items: [...document.querySelectorAll('.composer-menu-panel .composer-menu-item')].map(b => ({
    label: b.querySelector('.composer-menu-label')?.textContent.trim() ?? null,
    state: b.querySelector('.composer-menu-state')?.textContent.trim() ?? null,
    role: b.getAttribute('role'),
  })),
  expanded: document.querySelector('.composer-menu-btn')?.getAttribute('aria-expanded'),
})`));
console.log('菜单项 =', JSON.stringify(menu, null, 0));
check('「+」点得开（aria-expanded 同步）', menu.expanded === 'true');
check('菜单含出题 / 联网搜索 / 文档模式 / 存入记忆 / 导出对话 五项', menu.items.length === 5, menu.items.map((i) => i.label).join(' | '));
check('联网是 toggle 形态（点完保持展开、右侧有开/关态）', menu.items.some((i) => i.label === '联网搜索' && i.state === '已开' && i.role === 'menuitemcheckbox'));
await shot('04-menu-open');

// ── 4. 状态摘要挂在触发器上（收进菜单后唯一会丢的可见性） ─────────────────────
const status = await evalJs(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return 'esc';
})()`);
console.log('按 ESC =', status);
await sleep(300);
const afterEsc = JSON.parse(await evalJs(`JSON.stringify({
  panel: document.querySelectorAll('.composer-menu-panel').length,
  triggerText: document.querySelector('.composer-menu-btn')?.textContent.trim() ?? null,
})`));
console.log('ESC 后 =', JSON.stringify(afterEsc));
check('ESC 能收起菜单（否则会粘在屏上）', afterEsc.panel === 0);
check('触发器上带「联网已开」状态摘要', (afterEsc.triggerText || '').includes('联网已开'), String(afterEsc.triggerText));
await shot('05-collapsed');

// ── 5. 文档模式：触发器在菜单里、面板在 composer 上方（状态与动作分居两处） ────
await evalJs(`document.querySelector('.composer-menu-btn')?.click()`);
await sleep(350);
const docClicked = await evalJs(`(() => {
  const it = [...document.querySelectorAll('.composer-menu-item')].find(b => b.textContent.includes('文档模式'));
  if (!it) return 'no-item';
  it.click(); return 'ok';
})()`);
console.log('click 文档模式 =', docClicked);
await sleep(400);
const doc = JSON.parse(await evalJs(`JSON.stringify({
  panel: document.querySelectorAll('.chat-composer-wrap .chat-doc-panel').length,
  menuPanel: document.querySelectorAll('.composer-menu-panel').length,
  hasFilePicker: !![...document.querySelectorAll('.chat-doc-panel label')].find(l => l.textContent.includes('选文件')),
})`));
console.log('文档模式 =', JSON.stringify(doc));
check('文档模式面板开在 composer 上方（不在菜单里）', doc.panel === 1 && doc.menuPanel === 0);
check('面板里能选文件（折进 168px 的菜单就没法用了，所以留在这儿）', doc.hasFilePicker === true);
await shot('06-doc-panel');

// ── 6. 【可选】从新菜单真触发一次出题 ────────────────────────────────────────
// 为什么值得真跑：出题入口换了代码路径（原来是行内按钮直连 `ask.tap()`，现在要经
// ComposerMenu 的 action 条目转发）。**这条接线纯函数测不到**——菜单点不着或转发丢了，
// 单测与 tsc 全绿而用户按「出题」没反应。会花一次模型额度，故默认关，用 SB_PROBE_QUIZ=1 打开。
let bankBefore = [];
if (process.env.SB_PROBE_QUIZ === '1') {
  bankBefore = JSON.parse(await evalJs(`fetch('/api/quiz/bank').then(r => r.json()).then(a => JSON.stringify(a.map(b => b.id)))`));

  // 收起文档模式面板，免得挡住输入框
  await evalJs(`(() => { const b = [...document.querySelectorAll('.chat-doc-actions button')].find(x => x.textContent.trim() === '收起'); b?.click(); return 'ok'; })()`);
  await sleep(300);

  const typed = await evalJs(`(() => {
    const ta = document.querySelector('.chat-composer textarea');
    if (!ta) return 'no-ta';
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, '二重积分');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value;
  })()`);
  console.log('填入主题 =', typed);
  await sleep(250);

  await evalJs(`document.querySelector('.composer-menu-btn')?.click()`);
  await sleep(350);
  const gen = await evalJs(`(() => {
    const it = [...document.querySelectorAll('.composer-menu-item')].find(b => b.textContent.includes('出题'));
    if (!it) return 'no-item';
    it.click(); return 'ok';
  })()`);
  console.log('click 出题 =', gen);

  let cards = 0;
  for (let i = 0; i < 150; i += 1) {
    await sleep(1000);
    const s = JSON.parse(await evalJs(`JSON.stringify({
      cards: document.querySelectorAll('.chat-scroll .quiz-card, .chat-scroll [class*="quiz-card"]').length,
      busy: document.body.innerText.includes('出题中'),
    })`));
    if (i % 10 === 0) console.log(`  t=${i + 1}s`, JSON.stringify(s));
    if (s.cards > 0 && !s.busy) { cards = s.cards; break; }
  }
  check('点菜单「出题」真的出了题（接线没丢）', cards > 0, `题卡 ${cards} 张`);
  await sleep(600);
  const refsIn = JSON.parse(await evalJs(`JSON.stringify({
    inFlow: document.querySelectorAll('.chat-scroll .quiz-refs').length,
    inComposer: document.querySelectorAll('.chat-composer-wrap .quiz-refs').length,
    refsCount: document.querySelectorAll('.chat-scroll .quiz-refs li').length,
    note: [...document.querySelectorAll('.chat-scroll .chat-quiz-mix')].map(e => e.textContent.trim()),
  })`));
  console.log('来源清单落点 =', JSON.stringify(refsIn));
  check('来源清单落在消息流里、不在输入框上方', refsIn.inFlow + refsIn.inComposer === 0 || (refsIn.inFlow >= 1 && refsIn.inComposer === 0),
    `inFlow=${refsIn.inFlow} inComposer=${refsIn.inComposer} 条=${refsIn.refsCount}`);
  await evalJs(`document.querySelector('.chat-scroll')?.scrollTo(0, 1e6)`);
  await sleep(400);
  await shot('07-quiz-in-flow');
}

// ── 7. 数据自清：删掉本探针建的会话（含题卡）与出题顺带写进题库的条目 ──────────
const cleanup = await evalJs(`(async () => {
  const before = new Set(${JSON.stringify(idsBefore)});
  const all = await (await fetch('/api/sessions')).json();
  const fresh = all.filter(s => !before.has(s.id)).map(s => s.id);
  for (const sid of fresh) await fetch('/api/sessions/' + sid, { method: 'DELETE' });

  const bankBefore = new Set(${JSON.stringify(bankBefore)});
  const bank = await (await fetch('/api/quiz/bank')).json();
  const freshBank = bankBefore.size ? bank.filter(b => !bankBefore.has(b.id)).map(b => b.id) : [];
  for (const bid of freshBank) await fetch('/api/quiz/bank/' + bid, { method: 'DELETE' });

  const after = await (await fetch('/api/sessions')).json();
  const bankAfter = await (await fetch('/api/quiz/bank')).json();
  return JSON.stringify({ removedSessions: fresh.length, afterCount: after.length, removedBank: freshBank.length, bankAfter: bankAfter.length });
})()`);
console.log('清理 =', cleanup);
const cl = JSON.parse(cleanup);
check(`测试会话已自清（${idsBefore.length} 条 → ${cl.afterCount} 条）`, cl.afterCount === idsBefore.length);
check('出题顺带写进题库的条目已自清', cl.removedBank === 0 || cl.bankAfter === bankBefore.length,
  `删了 ${cl.removedBank} 条，题库现 ${cl.bankAfter} 条`);

ws.close();
chrome.kill();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 占用残留可忽略 */ }
console.log(fails === 0 ? `DONE  scene=${scene}  全部断言通过` : `DONE  scene=${scene}  ${fails} 处断言未通过`);
process.exit(fails === 0 ? 0 : 1);
