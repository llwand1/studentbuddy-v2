/**
 * quiz-e2e-cdp — 出题页真机渲染验证探针（零依赖：Node 22 内置 fetch + WebSocket 直驱 CDP）。
 *
 * 为什么需要它：纯函数测不到 DOM，`.test.tsx`（jsdom）又测不到真 CSS 与真实浏览器行为，
 * 而「屏幕上一行文案到底有没有出来」只有真渲染才有答案。
 * 本探针用无头 Chrome 真点真看，是核验真渲染层的手段。
 *
 * 它验的正是那类只有真机能抓的问题：`QuizCard` 的「来源：」行只在**答后揭晓**时才渲染、
 * `RefList` 默认折叠所以链接得先展开才拿得到、`searchNote` 与来源清单的**二选一**是否真的只出现一个。
 *
 * 用法（**必须先把服务起起来**，见下）：
 *   node tools/probes/quiz-e2e-cdp.mjs <场景名> [主题]
 *   # 例：node tools/probes/quiz-e2e-cdp.mjs after "2026年诺贝尔物理学奖"
 *
 * 前置（隔离实例，**别对着真实数据目录跑**）：
 *   ① 后端起在 18799（`SB_PORT=18799` + 独立的 `SB_DATA_DIR`，见 CHANGELOG 2026-09-13 批的复验手法）；
 *   ② 前端 `vite` 起在 5174 并 `SB_PROXY_TARGET=18799`（本探针把 5174 写死在 APP 常量）。
 *   截图落在 `SB_SHOT_DIR`（缺省＝系统临时目录），**不入仓**。
 *
 * ★ 踩过的坑（别重犯）：「点选项」与「点提交」**必须隔一拍**——两个动作挤在同一 tick 里，
 *   React 还没提交 picked，提交处理器读到空选择会直接返回，题目不揭晓，「答后来源行」永远抓不到。
 *   这坑看着像功能 bug（来源行不渲染），实际是探针自己太快。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const APP = 'http://localhost:5174/';
const OUT = process.env.SB_SHOT_DIR ?? join(process.env.TEMP ?? '/tmp', 'sb-cdp-shots');
const scene = process.argv[2] ?? 'default';
const topic = process.argv[3] ?? '2026年人工智能重要进展';
const profile = join(process.env.TEMP ?? '/tmp', `sb-cdp-${Date.now()}`);

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

// 等 CDP 起来
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

await send('Page.enable');
await send('Runtime.enable');
await sleep(2500); // 等 React 挂载

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = join(OUT, `${scene}-${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('shot ->', file);
};

await shot('01-initial');

// 点「题库」
const clicked = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.sb-nav-item')].find(x => x.textContent.includes('题库'));
  if (!b) return 'no-nav';
  b.click(); return 'ok';
})()`);
console.log('click 题库 =', clicked);
await sleep(1500);

// 抓联网开关状态 + 输入框
const preState = await evalJs(`(() => {
  const inp = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('一键出题'));
  const toggle = document.querySelector('.online-toggle, [class*="online"]');
  return JSON.stringify({
    hasInput: !!inp,
    placeholder: inp?.placeholder ?? null,
    toggleText: toggle ? toggle.textContent.trim() : null,
    toggleClass: toggle?.className ?? null,
  });
})()`);
console.log('页面初态 =', preState);
await shot('02-quizbank');

// 填主题（React 受控：用原生 setter + input 事件）
const typed = await evalJs(`(() => {
  const inp = [...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('一键出题'));
  if (!inp) return 'no-input';
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(inp, ${JSON.stringify(topic)});
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return inp.value;
})()`);
console.log('填入主题 =', typed);
await sleep(300);

// 点「一键出题」
const gen = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '一键出题');
  if (!b) return 'no-btn';
  b.click(); return 'ok';
})()`);
console.log('click 一键出题 =', gen);

// 轮询等出题完成（出题后页面切进练习视图、出题按钮消失，故只看出题卡出现）
let done = false;
for (let i = 0; i < 120; i += 1) {
  await sleep(1000);
  const s = await evalJs(`(() => {
    const cards = document.querySelectorAll('.quiz-card, [class*="quiz-card"]').length;
    const busy = document.body.innerText.includes('出题中');
    return JSON.stringify({ cards, busy });
  })()`);
  const st = JSON.parse(s);
  if (i % 10 === 0) console.log(`  t=${i + 1}s`, s);
  if (st.cards > 0 && !st.busy) { done = true; break; }
}
console.log('出题完成 =', done);
await sleep(600);

// 抓屏上文案（出题提示 + 题目 + 来源）
const summary = await evalJs(`(() => {
  const text = document.body.innerText;
  const note = [...document.querySelectorAll('*')].filter(e => /联网：/.test(e.textContent||'') && e.children.length === 0).map(e => e.textContent.trim())[0] ?? null;
  const srcNodes = [...document.querySelectorAll('*')].filter(e => /^来源：/.test((e.textContent||'').trim()) && e.children.length === 0).map(e => e.textContent.trim());
  const refsLis = document.querySelectorAll('.quiz-refs li').length;
  const refsLinks = [...document.querySelectorAll('.quiz-refs a')].map(a => a.getAttribute('href'));
  return JSON.stringify({ note, srcNodes, refsLis, refsLinks, hasQuizCard: !!document.querySelector('[class*="quiz-card"]'), bodyLen: text.length });
})()`);
console.log('屏上文案 =', summary);
await shot('03-after-generate');

// 展开来源清单（默认折叠）
const opened = await evalJs(`(() => {
  const d = document.querySelector('details.quiz-refs');
  if (!d) return 'no-details';
  d.open = true;
  d.scrollIntoView({ block: 'center' });
  return 'ok';
})()`);
console.log('展开来源清单 =', opened);
await sleep(400);
await shot('04-refs-open');

// 答一题暴露「来源：」行（QuizCard 的 source 只在 revealed 后渲染）
// ★ 必须「点选项 → 等一拍 → 点提交」（同 tick 会因 picked 还是空而直接返回，见文件头踩坑）
const picked = await evalJs(`(() => {
  const opt = document.querySelector('button.quiz-opt');
  if (!opt) return 'no-opt';
  opt.click();
  return 'ok';
})()`);
console.log('选选项 =', picked);
await sleep(400);
const submitted = await evalJs(`(() => {
  const submit = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '提交');
  if (!submit) return 'no-submit';
  submit.click();
  return 'ok';
})()`);
console.log('提交 =', submitted);
await sleep(800);
const srcAfter = await evalJs(`JSON.stringify({
  explain: document.querySelectorAll('.quiz-explain-body').length,
  srcNodes: [...document.querySelectorAll('.quiz-source')].map(e => e.textContent.trim()),
  srcLinks: [...document.querySelectorAll('.quiz-source a')].map(a => a.getAttribute('href')),
})`);
console.log('答后来源行 =', srcAfter);
const scrolled = await evalJs(`(() => {
  const c = document.querySelector('[class*="quiz-card"]');
  if (!c) return 'no-card';
  c.scrollIntoView({ block: 'start' });
  return 'ok';
})()`);
console.log('scroll =', scrolled);
await sleep(500);
await shot('05-quizcard');

ws.close();
chrome.kill();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 占用残留可忽略 */ }
console.log('DONE  scene=' + scene);
