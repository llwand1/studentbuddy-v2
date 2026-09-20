/**
 * coach-cdp — 复习督促小窗（B+C+E）真机渲染验证探针（零依赖：Node 22 内置 fetch + WebSocket 直驱 CDP）。
 *
 * 为什么需要它：纯函数测不到 DOM，而 `.test.tsx`（jsdom，2026-09-20 起）也测不到真 CSS 与真实浏览器行为。
 * `coach-cards.test.ts` 的 16 例能证明「给定卡片数组该产出什么文案与排序」，
 * 但**证明不了那些卡真的被挂到了屏幕上、翻牌真的能翻**——`.tsx` 里少写一个
 * `{revealed && <div className="coach-qdef">}`、少判一次 `open &&`，单测全绿、屏上却什么都没有。
 * 本探针用无头 Chrome 真点真看，是当前唯一能自动核验渲染层的手段（清偿 v0.2.48 的「.tsx 无自动化测」欠账）。
 *
 * ★ 核心设计：**期望值从 API 现取，不写死**。探针在页内 `fetch` 那三个**与 UI 同源**的接口
 *   （`/api/coach/state`、`/api/coach/messages`、`/api/terms/review/queue`），再断言 DOM 与其逐字相符。
 *   这正是本批的设计约束「**数字只有一个来源**」在渲染层的落地证据——若哪天组件自己算一套数字，
 *   这条断言会红（而组件自己算、且算对了的那一天，胶囊与抽屉会先互相矛盾）。
 *
 * 三档（由环境变量决定走哪个）：
 *   ① **默认档（零 LLM、零写入）** → 结构层：胶囊文案/tone/脉冲点 → 点开抽屉 → 标题与副标题
 *      → 队列段与流水段的 **DOM 先后顺序**（顺序即使用顺序）→ 队列卡四要素 → **未翻牌时无释义节点**
 *      → 翻牌揭释义 → **再点收起**（翻牌可逆）→ 两颗打卡键在位且解禁 → 三颗快捷指令文案与契约一致
 *      → 输入框与发送键 → 发送键随输入**启用/禁用** → 收起抽屉 → **再开一次，提醒卡不翻倍**。
 *   ② `SB_PROBE_COACH_LLM=1` → **真实模型端到端**：点「今天怎么排」→ 等我的卡上屏（逐字等于快捷指令 prompt）
 *      → 等真实 `ai` 卡**流式结束**（`.coach-card-ai:not(.streaming)`）且正文非占位 → 断无 `.coach-error`。
 *      ★ **会真花模型额度**（一次 agnes 调用），不进 CI。
 *   ③ `SB_PROBE_COACH_REVIEW=1` → **打卡闭环**：在首张队列卡点「记住了」→ 该卡离开队列、
 *      流水里长出 `review` 卡（标记「记住」）、且 `/api/coach/state` 的 `due` **真的减一**。
 *      ★ 写库（term_library 的 review_stage/last_reviewed_at + term_review_log + coach_messages）。
 *
 * ★ **数据安全：必须对着隔离实例跑**。本探针在 ②③ 档会真写库，故写档下**拒绝对着 5173/5174
 *   （老板在跑的实例，代理到生产库 18791）启动**，只允许指向隔离栈（缺省 5175 → server 18798 →
 *   `_probe/data-coach-cdp` 的**库副本**）。库副本是一次性的 ⇒ **无需自清**（清不清都影响不到真库）；
 *   代价是连跑多次会在副本里累积卡片，故所有断言都从 API 现取期望值，**不依赖「库是干净的」**。
 *
 * 用法（**必须先把隔离栈起起来**）：
 *   # 准备库副本（一次性快照，别裸拷文件——老板的实例在跑，WAL 里可能有未落盘的事务）
 *   #   VACUUM INTO '_probe/data-coach-cdp/studentbuddy.db'
 *   # 隔离后端：
 *   #   SB_PORT=18798 SB_DATA_DIR='<repo>/_probe/data-coach-cdp' npx tsx packages/server/src/index.ts
 *   # 隔离前端（★ 必须 --host 127.0.0.1：vite 缺省只绑 [::1]，探针连 127.0.0.1 会得到空响应）
 *   #   (cd packages/web && SB_PROXY_TARGET=http://127.0.0.1:18798 npx vite --host 127.0.0.1 --port 5175 --strictPort)
 *   node tools/probes/coach-cdp.mjs
 *   SB_PROBE_COACH_LLM=1    node tools/probes/coach-cdp.mjs
 *   SB_PROBE_COACH_REVIEW=1 node tools/probes/coach-cdp.mjs
 * 截图落在 `SB_SHOT_DIR`（缺省＝系统临时目录），**不入仓**。
 *
 * ★ 踩过的坑（别重犯）：
 *   ① **端口必须随机且起前先探测**：连续跑多次时上一次的 Chrome 未必已释放端口，固定端口会
 *      让新实例**绑不上**，而 `/json/version` 反而连到**残留的旧浏览器**——探针就跑到别人的
 *      实例上去了（`weak-analysis-cdp.mjs` 为此整片假红过）。
 *   ② **受控 textarea 不能直接赋 `.value`**：React 用自己的 value tracker，直赋不触发 onChange ⇒
 *      「输入了解禁发送键」这条会假红。必须走原生 setter + 派发 `input`。
 *   ③ **两个有依赖的点击要隔一拍**：`openDrawer` 是 async（要等 `/nudge` 与队列回来），
 *      点完胶囊立刻断言抽屉内容会读到空。统一用 `waitFor` 轮询，**不要固定 sleep**。
 *   ④ **tone 类名要按「有没有」判，不要按「类名全等」判**：`coach-cap` 上同时挂着 tone 类与 `open`。
 *   ⑤ ★★ **隔离目录必须补上生产 `DATA_DIR` 的 `.mk`，否则真实模型档会得到一个「假的 401」**：
 *      `storage/crypto.ts` 的主密钥文件 `.mk` **就放在 `DATA_DIR` 里**（DPAPI 包装，CurrentUser 作用域）。
 *      库副本里没有它 ⇒ `initCrypto()` **当场新生成一把随机主密钥** ⇒ 复制过来的 `api_key` 解不开
 *      （AES-GCM 认证失败 ⇒ `decryptSecret` 返回**空串**，服务端只在 stderr 留一行
 *      `[crypto] decryptSecret failed: Unsupported state or unable to authenticate data`）
 *      ⇒ 出站变成 `Authorization: Bearer `（空）⇒ provider 回 **401 无效的令牌**。
 *      **症状极具误导性**：看着像「老板的 key 失效了」，实为自己少拷了一个文件——
 *      本探针首跑就据此差点报出一个错误结论，靠**绕过应用、用同一把 key 直连 provider**（200）才戳穿。
 *      规矩：起隔离栈前先 `cp <生产 DATA_DIR>/.mk <隔离 DATA_DIR>/.mk`；下「key 失效」结论前必须直连复核。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
/** 端口随机（9300~9499，可用 `SB_CDP_PORT` 固定）——理由见文件头坑 ① */
const PORT = Number(process.env.SB_CDP_PORT ?? 9300 + Math.floor(Math.random() * 200));
/** 缺省打**隔离栈**的 5175；写档下若指向 5173/5174 直接拒绝（见文件头「数据安全」） */
const APP = process.env.SB_PROBE_APP ?? 'http://127.0.0.1:5175/';
const OUT = process.env.SB_SHOT_DIR ?? join(process.env.TEMP ?? '/tmp', 'sb-cdp-shots');
const LLM = process.env.SB_PROBE_COACH_LLM === '1';
const REVIEW = process.env.SB_PROBE_COACH_REVIEW === '1';
const scene = LLM ? 'coach-llm' : REVIEW ? 'coach-review' : 'coach';

/** 契约里写死的三句快捷指令（`shared/src/coach.ts` 的 COACH_QUICK_ACTIONS）——对不上就是契约漂了 */
const QUICK_LABELS = ['今天怎么排', '为什么是现在', '我进步了吗'];
/** 首颗快捷指令的 prompt（②档点它，断言我的卡逐字等于它） */
const QUICK_FIRST_PROMPT = '我今天的词条复习怎么安排？给我一个能马上开始的顺序。';

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if ((LLM || REVIEW) && /:517[34]\//.test(APP)) {
  console.error(`写档（${LLM ? 'LLM' : 'REVIEW'}）拒绝打 ${APP}——那会写进老板在跑的生产库。`);
  console.error('起隔离栈并用 SB_PROBE_APP=http://127.0.0.1:5175/ 指过来（见文件头）。');
  process.exit(2);
}

const stale = await (async () => {
  try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { return false; }
})();
if (stale) {
  console.error(`端口 ${PORT} 上已有 CDP 实例（残留 Chrome？）——拒绝继续，否则会连到别人的浏览器。`);
  console.error('换个端口：SB_CDP_PORT=9xxx node tools/probes/coach-cdp.mjs');
  process.exit(2);
}

const profile = join(process.env.TEMP ?? '/tmp', `sb-cdp-coach-${Date.now()}`);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 60; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { version = await r.json(); break; } } catch { /* 还没起 */ }
  await sleep(250);
}
if (!version) { console.error('CDP 未就绪'); chrome.kill(); process.exit(1); }
console.log('Chrome =', version['Browser'], '| APP =', APP);

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
const waitFor = async (expr, timeoutMs = 20000, intervalMs = 150) => {
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
await sleep(2500); // 等 React 挂载

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = join(OUT, `${scene}-${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('shot ->', file);
};
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
/** 不变量「无从观测」≠「被违反」（如「在途态」比采样还短）：记 SKIP，不计失败 */
const skip = (name, why) => { checks.push({ name, skip: true }); console.log(`SKIP  ${name}  ${why}`); };

/** 页内取三个与 UI 同源的接口快照（同源 fetch 会自动带 Origin，不会被跨源闸门拦） */
const apiSnap = () => evalJs(`(async () => {
  const [s, m, q] = await Promise.all([
    fetch('/api/coach/state').then(r => r.json()),
    fetch('/api/coach/messages').then(r => r.json()),
    fetch('/api/terms/review/queue?limit=20').then(r => r.json()),
  ]);
  return JSON.stringify({ snapshot: s.snapshot, cards: m.cards, queue: q });
})()`);

// ── 0. 页面 + 胶囊（折叠态 = B） ─────────────────────────────────────────────
const mounted = await waitFor(`!!document.querySelector('.coach-cap')`, 25000);
check('督促小窗已挂载（胶囊在位）', mounted, `hasCap=${!!mounted}`);
if (!mounted) { await shot('99-no-cap'); }
const snap0 = JSON.parse((await apiSnap()) ?? '{}');
const s0 = snap0.snapshot ?? {};
const cap = await evalJs(`(() => {
  const b = document.querySelector('.coach-cap');
  if (!b) return JSON.stringify({ none: true });
  return JSON.stringify({
    text: b.querySelector('.coach-cap-text')?.textContent?.trim() ?? null,
    classes: [...b.classList],
    dot: !!b.querySelector('.coach-cap-dot'),
    expanded: b.getAttribute('aria-expanded'),
    tag: b.tagName,
  });
})()`);
const c0 = JSON.parse(cap ?? '{}');
// 胶囊文案 = capsuleLine(snapshot)：欠账时「欠 N 条 · 连续 M 天」，清零时另一套
const expectLine = s0.due > 0 ? `欠 ${s0.due} 条 · 连续 ${s0.streak} 天` : (s0.todayDone > 0 ? `今日已清 ${s0.todayDone} 条` : '今日无欠账');
check('胶囊文案与 /coach/state 快照一致（单一数据源）', c0.text === expectLine, `DOM="${c0.text}" 期望="${expectLine}"`);
// 三色判据：有逾期→alert、只有到期→warn、清零→ok（capsuleTone 的口径）
const expectTone = s0.overdue > 0 ? 'alert' : s0.due > 0 ? 'warn' : 'ok';
check('胶囊 tone 与欠账状态相符', c0.classes?.includes(expectTone), `classes=${JSON.stringify(c0.classes)} 期望含 ${expectTone}`);
check('折叠态是 button 且有 aria-expanded', c0.tag === 'BUTTON' && c0.expanded === 'false', `tag=${c0.tag} expanded=${c0.expanded}`);
check('有欠账时折叠态不显示 AI 的话（只有一行数字）', !/\n/.test(c0.text ?? ''), `text=${JSON.stringify(c0.text)}`);
await shot('01-capsule');

// ── 1. 点开抽屉（展开态 = C） ────────────────────────────────────────────────
await evalJs(`(() => { document.querySelector('.coach-cap')?.click(); return 'ok'; })()`);
const opened = await waitFor(`!!document.querySelector('.coach-drawer')`, 20000);
check('点胶囊后抽屉出现', opened, `hasDrawer=${!!opened}`);
await waitFor(`!!document.querySelector('.coach-queue-sec')`, 15000); // 等 openDrawer 的 async 两请求回来
await sleep(400);
await shot('02-drawer-open');
const head = await evalJs(`(() => {
  const d = document.querySelector('.coach-drawer');
  return JSON.stringify({
    expanded: document.querySelector('.coach-cap')?.getAttribute('aria-expanded'),
    tag: d?.tagName, aria: d?.getAttribute('aria-label'),
    title: d?.querySelector('.coach-drawer-title')?.textContent?.trim(),
    sub: d?.querySelector('.coach-drawer-sub')?.textContent?.trim(),
    hasClose: !!d?.querySelector('.coach-drawer-close'),
    hasError: !!document.querySelector('.coach-error'),
  });
})()`);
const h = JSON.parse(head ?? '{}');
check('展开态 aria-expanded=true', h.expanded === 'true', `expanded=${h.expanded}`);
check('抽屉是 aside 且有中文 aria-label', h.tag === 'ASIDE' && h.aria === '复习督促小窗', `tag=${h.tag} aria=${h.aria}`);
check('抽屉标题为「复习督促」', h.title === '复习督促', `title=${h.title}`);
const expectSub = `${s0.due} 条待复习 · 逾期 ${s0.overdue} · 连续 ${s0.streak} 天 · 已记住 ${s0.mastered}`;
check('副标题四个数字与快照逐字一致', h.sub === expectSub, `DOM="${h.sub}" 期望="${expectSub}"`);
check('收起键在位', h.hasClose, `hasClose=${h.hasClose}`);
check('无错误条（拉取队列/提醒未失败）', !h.hasError, `hasError=${h.hasError}`);

// ── 2. 两段顺序（顺序即使用顺序：先还账、再复盘） ─────────────────────────────
const order = await evalJs(`(() => {
  const q = document.querySelector('.coach-queue-sec'), s = document.querySelector('.coach-stream-sec');
  if (!q || !s) return JSON.stringify({ q: !!q, s: !!s });
  const pos = q.compareDocumentPosition(s);
  return JSON.stringify({ q: true, s: true, queueFirst: !!(pos & Node.DOCUMENT_POSITION_FOLLOWING),
    heads: [...document.querySelectorAll('.coach-feed .coach-sec-head')].map(x => x.childNodes[0]?.textContent?.trim()) });
})()`);
const o = JSON.parse(order ?? '{}');
check('今日队列段在督促记录段之前', o.queueFirst === true, `queueFirst=${o.queueFirst}`);
check('两段标题顺序正确', JSON.stringify(o.heads) === JSON.stringify(['今日队列', '督促记录']), `heads=${JSON.stringify(o.heads)}`);

// ── 3. 队列卡四要素 + 翻牌（★ 未翻牌时不得有释义节点） ───────────────────────
const qd = await evalJs(`(() => {
  const cards = [...document.querySelectorAll('.coach-qcard')];
  const first = cards[0];
  return JSON.stringify({
    n: cards.length,
    hint: document.querySelector('.coach-queue-sec .coach-sec-hint')?.textContent?.trim(),
    empty: !!document.querySelector('.coach-queue-empty'),
    term: first?.querySelector('.coach-qterm')?.textContent?.trim() ?? null,
    domain: first?.querySelector('.coach-qdomain')?.textContent?.trim() ?? null,
    days: first?.querySelector('.coach-qdays')?.textContent?.trim() ?? null,
    ret: first?.querySelector('.coach-qret')?.textContent?.trim() ?? null,
    revealed: first?.classList.contains('revealed') ?? null,
    hasDef: !!first?.querySelector('.coach-qdef'),
    btnOk: first?.querySelector('.coach-qbtn.ok')?.textContent?.trim() ?? null,
    btnBad: first?.querySelector('.coach-qbtn.danger')?.textContent?.trim() ?? null,
    btnOkDisabled: first?.querySelector('.coach-qbtn.ok')?.disabled ?? null,
    lv: [...(first?.classList ?? [])].find(x => x.startsWith('lv-')) ?? null,
  });
})()`);
const q1 = JSON.parse(qd ?? '{}');
const apiQueue = snap0.queue ?? [];
check('队列卡条数与 /review/queue?limit=20 一致', q1.n === apiQueue.length, `DOM=${q1.n} API=${apiQueue.length}`);
check('队列非空（有欠账时不该是空态）', q1.n > 0 && !q1.empty, `n=${q1.n} empty=${q1.empty}`);
check('队列段提示文案含条数且点明翻牌', /^\d+ 条 · 点卡片翻面看释义$/.test(q1.hint ?? ''), `hint="${q1.hint}"`);
check('首卡词名为 API 首条（排序一致：先还旧账）', q1.term === apiQueue[0]?.term, `DOM="${q1.term}" API="${apiQueue[0]?.term}"`);
check('首卡有领域与「N 天没碰」', !!q1.domain && /天没碰$/.test(q1.days ?? ''), `domain=${q1.domain} days="${q1.days}"`);
check('首卡显示保持率百分比', /^记忆 ≈ \d+%$/.test(q1.ret ?? ''), `ret="${q1.ret}"`);
check('首卡带保持率等级类（lv-*）用于上色', !!q1.lv, `lv=${q1.lv}`);
check('★ 未翻牌时无释义节点（先回忆再看答案）', q1.hasDef === false && q1.revealed === false, `hasDef=${q1.hasDef} revealed=${q1.revealed}`);
check('两颗打卡键文案为「记住了」「忘了」', q1.btnOk === '记住了' && q1.btnBad === '忘了', `ok=${q1.btnOk} bad=${q1.btnBad}`);
check('打卡键未在处理中（可点）', q1.btnOkDisabled === false, `disabled=${q1.btnOkDisabled}`);
await shot('03-queue');

const flipped = await evalJs(`(() => { document.querySelector('.coach-qcard-face')?.click(); return 'ok'; })()`);
const rev = await waitFor(`!!document.querySelector('.coach-qcard.revealed .coach-qdef')`, 6000);
const defText = await evalJs(`document.querySelector('.coach-qcard.revealed .coach-qdef')?.textContent?.trim() ?? null`);
check('点卡面可翻牌（revealed + 释义上屏）', !!rev && !!defText, `flip=${flipped} def=${JSON.stringify((defText ?? '').slice(0, 40))}`);
await shot('04-flipped');
await evalJs(`(() => { document.querySelector('.coach-qcard-face')?.click(); return 'ok'; })()`);
const unflip = await waitFor(`!document.querySelector('.coach-qcard.revealed .coach-qdef')`, 5000);
check('再点可收起（翻牌可逆）', !!unflip, `stillRevealed=${!unflip}`);

// ── 4. 流水段（无卡时必须是「空态文案」而不是空壳） ──────────────────────────
const st = await evalJs(`(() => JSON.stringify({
  n: document.querySelectorAll('.coach-stream .coach-card').length,
  empty: document.querySelector('.coach-stream-empty')?.textContent?.trim() ?? null,
  kinds: [...document.querySelectorAll('.coach-stream .coach-card')].map(c =>
    c.className.replace('coach-card','').replace('streaming','').trim() || 'ai'),
}))()`);
const s1 = JSON.parse(st ?? '{}');
check('流水区二选一：有卡 或 空态文案（不得是空壳）', (s1.n > 0 && s1.empty === null) || (s1.n === 0 && !!s1.empty), `cards=${s1.n} empty=${JSON.stringify((s1.empty ?? '').slice(0, 20))}`);
// ★★ 期望值必须**与 DOM 同刻**现取，不能用开场那份快照：抽屉打开时 `openDrawer` 会打一次
//   `POST /coach/nudge`，而服务端的冷却（`NUDGE_COOLDOWN_MS = 2h`）**过期时它当场落一张提醒卡**
//   ⇒ 此刻 DOM 比开场快照多一张是**正确的**，拿旧快照比会假红。
//   本探针 2026-09-18（P5 批）就这么误报过一次：DOM=26 / 开场快照=25，差值恰好是那张 nudge 卡
//   （同一次运行后面「再次打开提醒卡不翻倍 前=2 后=2」正是它的自证）。★ 这也是条文档探针的通则：
//   **先问「谁的真值更可信」，再改断言**——不是把断言改松让它变绿。
const freshCount = await evalJs(`fetch('/api/coach/messages').then(r => r.json()).then(j => j.cards.length)`);
check(
  '流水卡数与 /coach/messages 同刻一致',
  s1.n === freshCount,
  `DOM=${s1.n} API=${freshCount}（开场快照=${(snap0.cards ?? []).length}；差额＝抽屉开启时 nudge 落的那张卡）`,
);

// ── 5. 输入区 + 快捷指令（契约文案） ────────────────────────────────────────
const comp = await evalJs(`(() => JSON.stringify({
  quick: [...document.querySelectorAll('.coach-quick-btn')].map(b => b.textContent.trim()),
  quickDisabled: [...document.querySelectorAll('.coach-quick-btn')].map(b => b.disabled),
  hasInput: !!document.querySelector('.coach-input'),
  placeholder: document.querySelector('.coach-input')?.getAttribute('placeholder') ?? null,
  hasSend: !!document.querySelector('.coach-send:not(.stop)'),
  sendDisabled: document.querySelector('.coach-send:not(.stop)')?.disabled ?? null,
}))()`);
const cp = JSON.parse(comp ?? '{}');
check('三颗快捷指令与契约文案逐字一致', JSON.stringify(cp.quick) === JSON.stringify(QUICK_LABELS), `DOM=${JSON.stringify(cp.quick)}`);
check('快捷指令未在处理中（可点）', (cp.quickDisabled ?? []).every((d) => d === false), `disabled=${JSON.stringify(cp.quickDisabled)}`);
check('输入框在位且提示 Enter 发送', cp.hasInput && /Enter 发送/.test(cp.placeholder ?? ''), `placeholder="${(cp.placeholder ?? '').slice(0, 30)}..."`);
check('未输入时发送键禁用', cp.hasSend && cp.sendDisabled === true, `hasSend=${cp.hasSend} disabled=${cp.sendDisabled}`);
// ★ 受控输入必须走原生 setter + input 事件（直赋 .value 不触发 onChange ⇒ 会假红，见文件头坑 ②）
const typed = await evalJs(`(() => {
  const el = document.querySelector('.coach-input');
  if (!el) return 'no-input';
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  set.call(el, '今天先背哪个');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);
const enabled = await waitFor(`document.querySelector('.coach-send:not(.stop)')?.disabled === false`, 4000);
check('输入后发送键解禁', typed === 'ok' && enabled, `typed=${typed} enabled=${!!enabled}`);
await shot('05-composer');
// 清空回禁用（不真发请求——发请求是 ②③ 档的事）
await evalJs(`(() => {
  const el = document.querySelector('.coach-input');
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);
const reDisabled = await waitFor(`document.querySelector('.coach-send:not(.stop)')?.disabled === true`, 4000);
check('清空后发送键复禁', !!reDisabled, `disabled=${!!reDisabled}`);

// ── 6. 收起 → 复开：提醒卡不得翻倍（「冷却在服务端」的渲染层证据） ───────────
const nudgeBefore = await evalJs(`document.querySelectorAll('.coach-card-nudge').length`);
await evalJs(`(() => { document.querySelector('.coach-drawer-close')?.click(); return 'ok'; })()`);
const closed = await waitFor(`!document.querySelector('.coach-drawer')`, 5000);
const capStill = await evalJs(`(() => JSON.stringify({
  hasCap: !!document.querySelector('.coach-cap'),
  expanded: document.querySelector('.coach-cap')?.getAttribute('aria-expanded'),
}))()`);
const cs = JSON.parse(capStill ?? '{}');
check('点收起键抽屉关闭', !!closed, `drawerGone=${!!closed}`);
check('收起后胶囊仍在且 aria-expanded=false', cs.hasCap && cs.expanded === 'false', `hasCap=${cs.hasCap} expanded=${cs.expanded}`);
await evalJs(`(() => { document.querySelector('.coach-cap')?.click(); return 'ok'; })()`);
await waitFor(`!!document.querySelector('.coach-queue-sec')`, 20000);
await sleep(600);
const nudgeAfter = await evalJs(`document.querySelectorAll('.coach-card-nudge').length`);
check('★ 再次打开：提醒卡不翻倍（冷却在服务端生效）', nudgeAfter === nudgeBefore, `前=${nudgeBefore} 后=${nudgeAfter}`);
// 抽屉重开后队列/输入区仍在（状态没被重置）
const reopened = await evalJs(`(() => JSON.stringify({
  q: document.querySelectorAll('.coach-qcard').length,
  input: !!document.querySelector('.coach-input'),
}))()`);
const ro = JSON.parse(reopened ?? '{}');
check('复开后队列与输入区仍在（状态未被重置）', ro.q > 0 && ro.input, `q=${ro.q} input=${ro.input}`);
await shot('06-reopened');

// ── 7. ②档：真实模型端到端（会花额度） ──────────────────────────────────────
if (LLM) {
  console.log('—— 真实模型档：点「今天怎么排」，等真 AI 回复 ——');
  await evalJs(`(() => { [...document.querySelectorAll('.coach-quick-btn')].find(b => b.textContent.trim() === ${JSON.stringify(QUICK_LABELS[0])})?.click(); return 'ok'; })()`);
  // ★ 必须按「**这一轮新增**的那张」认，不能 `querySelector('.coach-card-ai')`：
  //   库里可能已有历史卡（含历史**失败**卡），取第一张就会把上一轮的结论当成本轮结论
  //   —— 本探针首跑就踩到：拿上一轮那张 401 失败卡判了「模型答上了」（假绿）。
  // ★ 开跑前的 ai 卡条数**按 API 取**（服务端真相），不按 DOM 取：DOM 里有流式临时卡、
  //   还受加载时序影响，拿它当基数不稳（本探针上一版就是这么红的：连跑三次两红一绿，
  //   红的那次现场 dump 显示 DOM 与 API 其实都对——**是取法本身不稳，不是产品有问题**）。
  const aiBeforeApi = ((JSON.parse((await apiSnap()) ?? '{}').cards ?? []).filter((c) => c.kind === 'ai')).length;
  await evalJs(`(() => { [...document.querySelectorAll('.coach-quick-btn')].find(b => b.textContent.trim() === ${JSON.stringify(QUICK_LABELS[0])})?.click(); return 'ok'; })()`);
  const meCard = await waitFor(`(() => {
    const all = [...document.querySelectorAll('.coach-card-me .coach-me-body')];
    const last = all[all.length - 1];
    return last && last.textContent.trim() === ${JSON.stringify(QUICK_FIRST_PROMPT)} ? last.textContent.trim() : '';
  })()`, 30000);
  check('我的卡逐字等于快捷指令的 prompt', meCard === QUICK_FIRST_PROMPT, `DOM="${(meCard ?? '').slice(0, 40)}..."`);
  // 流式期间是临时卡（带 .streaming）；done 后整表重拉换成落库的真卡
  const streamingSeen = await evalJs(`!!document.querySelector('.coach-card-ai.streaming')`);
  if (streamingSeen) check('生成中出现流式临时卡（.streaming）', true, 'streaming=true');
  else skip('生成中出现流式临时卡（.streaming）', '首次采样前已结束（空真，不计失败）');
  // ★ 第一步：**认服务端的真相**——轮询 `/api/coach/messages`，等 ai 卡比开跑前多一张。
  const aiDone = await waitFor(`(async () => {
    const j = await fetch('/api/coach/messages').then(r => r.json());
    const ai = j.cards.filter(c => c.kind === 'ai');
    if (ai.length <= ${aiBeforeApi}) return '';
    return String(ai[ai.length - 1].text ?? '').trim();
  })()`, 180000, 500);
  check('服务端落库了这一轮的 AI 回复', !!aiDone, `正文长度=${(aiDone ?? '').length}`);
  // ★ 第二步：**落库 ≠ 渲染**。按**正文前缀**在 DOM 里认那张卡（不按索引、不按流式态）——
  //   这一步才是真正清偿「`.tsx` 渲染层无自动化测」的那条：它证的是「屏幕上真的有这张卡」，
  //   而不只是「库里有」。两条分开写，一旦红就能立刻分清是服务端没落库还是前端没渲染。
  const rendered = await waitFor(`(() => {
    const want = ${JSON.stringify((aiDone ?? '').slice(0, 24))};
    return want && [...document.querySelectorAll('.coach-ai-body')]
      .some(x => x.textContent.trim().startsWith(want)) ? 'ok' : '';
  })()`, 90000, 400);
  check('★ 该回复真的渲染到了抽屉里（DOM 含该卡）', rendered === 'ok', `rendered=${rendered}`);
  if (!aiDone || rendered !== 'ok') {
    const dbg = await evalJs(`(async () => {
      const api = await fetch('/api/coach/messages').then(r => r.json()).then(j => j.cards.filter(c => c.kind === 'ai'));
      const all = [...document.querySelectorAll('.coach-card-ai')];
      return JSON.stringify({ aiBeforeApi: ${aiBeforeApi}, apiAi: api.length,
        apiLast: String(api[api.length - 1]?.text ?? '').slice(0, 40),
        domAi: all.length, domStreaming: all.filter(x => x.classList.contains('streaming')).length,
        domTexts: all.map(x => (x.querySelector('.coach-ai-body')?.textContent ?? '').trim().slice(0, 24)),
        busyStop: !!document.querySelector('.coach-send.stop'),
        err: document.querySelector('.coach-error')?.textContent?.trim() ?? null });
    })()`);
    console.log('  [debug] 现场 =', dbg);
  }
  const err = await evalJs(`document.querySelector('.coach-error')?.textContent?.trim() ?? null`);
  check('无错误条（模型真的被调通）', !err, `error=${err}`);
  // ★「正文非空」不足以证明「模型答上了」：`generateCoachReply` 的**失败路径**同样会把原因
  //   当正文落成一张 ai 卡（ADR-5 不静默降级）⇒ 不排掉失败文案就会**假绿**
  //   （本探针首跑就踩到：拿到的是 provider 的 401 文案，却判了 PASS）。
  check('★ 该卡不是失败回灌（模型真的答了内容）', !!aiDone && !/模型调用失败|API error|没回上/.test(aiDone), `body="${(aiDone ?? '').slice(0, 60)}"`);
  console.log('\n===== 这一轮 agnes 的真实产出（供老板判「说得对不对」，探针不替人做质量验收）=====');
  console.log('  ·', (aiDone ?? '').slice(0, 500));
  // 软核验（只印不判）：`COACH_PERSONA` 要求「数据只来自快照」⇒ 回复该点名 top 词条与剩余条数。
  // 模型措辞多变，硬断言会变成假红灯，故只做**可见性**核验，判定权留老板。
  const stNow = (JSON.parse((await apiSnap()) ?? '{}').snapshot ?? {});
  const topTerms = (stNow.top ?? []).map((t) => t.term);
  const cited = topTerms.filter((t) => (aiDone ?? '').includes(t));
  console.log('  · 快照 top 词条 =', JSON.stringify(topTerms));
  console.log('  · 回复点名了其中', cited.length, '条 =', JSON.stringify(cited));
  console.log('  · 回复提到剩余条数（应约为 ' + Math.max(0, (stNow.total ?? 0) - topTerms.length) + '）：', /\d+\s*条/.test(aiDone ?? '') ? '是' : '否');
  console.log('===== 以上为 agnes 真实产出 =====\n');
  await shot('07-llm-reply');
}

// ── 8. ③档：打卡闭环（写库） ────────────────────────────────────────────────
if (REVIEW) {
  console.log('—— 打卡档：首张队列卡点「记住了」 ——');
  const dueBefore = (JSON.parse((await apiSnap()) ?? '{}').snapshot ?? {}).due;
  const firstTerm = await evalJs(`document.querySelector('.coach-qcard .coach-qterm')?.textContent?.trim() ?? null`);
  await evalJs(`(() => { document.querySelector('.coach-qcard .coach-qbtn.ok')?.click(); return 'ok'; })()`);
  const left = await waitFor(`(() => {
    const terms = [...document.querySelectorAll('.coach-qcard .coach-qterm')].map(x => x.textContent.trim());
    return !terms.includes(${JSON.stringify(firstTerm)}) ? 'left' : '';
  })()`, 20000);
  check('打卡后该词条离开今日队列', left === 'left', `term=${firstTerm}`);
  const rvCard = await waitFor(`(() => {
    const c = [...document.querySelectorAll('.coach-card-review')];
    const hit = c.find(x => (x.querySelector('.coach-rv-term')?.textContent ?? '').trim() === ${JSON.stringify(firstTerm)});
    return hit ? JSON.stringify({ mark: hit.querySelector('.coach-rv-mark')?.textContent?.trim(), sub: hit.querySelector('.coach-rv-sub')?.textContent?.trim() }) : '';
  })()`, 20000);
  const rv = JSON.parse(rvCard || '{}');
  check('流水里长出复习卡且标记为「记住」', rv.mark === '记住', `mark=${rv.mark} sub="${rv.sub}"`);
  check('复习卡写明下一档间隔', /间隔|天|明天/.test(rv.sub ?? ''), `sub="${rv.sub}"`);
  const dueAfter = (JSON.parse((await apiSnap()) ?? '{}').snapshot ?? {}).due;
  check('★ 打卡后 /coach/state 的 due 真的减一', dueAfter === dueBefore - 1, `${dueBefore} → ${dueAfter}`);
  const capNow = await evalJs(`document.querySelector('.coach-cap-text')?.textContent?.trim() ?? null`);
  check('胶囊数字跟着变（快照被刷新）', capNow === `欠 ${dueAfter} 条 · 连续 ${(JSON.parse((await apiSnap()) ?? '{}').snapshot ?? {}).streak} 天`, `cap="${capNow}"`);
  await shot('08-reviewed');
}

// ── 结算 ────────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => c.pass === false);
const skipped = checks.filter((c) => c.skip);
console.log(`\nDONE  ${checks.length - skipped.length} 条断言：PASS ${checks.length - skipped.length - failed.length} / FAIL ${failed.length} / SKIP ${skipped.length}`);
for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail ?? ''}`);
ws.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 上可能仍被占用，忽略 */ }
process.exit(failed.length ? 1 : 0);
