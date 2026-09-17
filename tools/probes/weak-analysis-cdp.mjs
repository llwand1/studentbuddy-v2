/**
 * weak-analysis-cdp — 「薄弱点分析」真机渲染验证探针（零依赖：Node 22 内置 fetch + WebSocket 直驱 CDP）。
 *
 * 为什么需要它：本仓 web 侧**没有渲染测试基建**（只有纯函数 vitest，无 jsdom／testing-library，
 * 见 test-plan §1）。`weak-report.test.ts` 能证明「给定 WeakAnalysis 该产出什么文案」，
 * 但**证明不了那些文案真的被挂到了屏幕上**——`.tsx` 里少写一个 `{view.points.map(...)}`、
 * 少判一次 `view.headNote`，11 个单测全绿、屏幕上却什么都没有。
 * 本探针用无头 Chrome 真点真看，是当前唯一能自动核验渲染层的手段。
 *
 * 它验的正是那类只有真机能抓的问题：
 *   ① 三态是否真的存在（点下去按钮是否转「分析中…」且 disabled，ADR-5 不许静默）；
 *   ② 多主题卡片是否**全部**渲染出来（旧版只取 weak[0]，模型聚出的其余主题全白算）；
 *   ③ `headNote` 的 N 与 `analyzed` 是否对得上；
 *   ④ 降级提示 `.quiz-weak-fallback` 在非降级时**必须不存在**（否则等于把 AI 结果谎称本地规则版）。
 *
 * ★ 本探针**只读**：只调 `GET /api/quiz/analyze/:id`（服务端不做写库），
 *   所以对着真实数据目录跑也是安全的——这点与 `quiz-e2e-cdp.mjs` 不同（那个会真的出题落库）。
 *   但它**会真的花模型额度**（每次跑约几秒、一次 LLM 调用），别放进 CI 循环里跑。
 *
 * ★ 三个分支都验（由「数据 + `SB_PROBE_DEGRADE`」决定走哪个）：
 *   ① **AI 主路径**（该套题有错题记录）→ 17 条断言；
 *   ② **空态分支**（该套题没做过题，`analyzed:0`，服务端**不调模型**直接返回）→ 15 条断言。
 *      空态必须同时验「文案是『先做题』」+「**不挂口径行**（『基于 0 道错题』是谎）」+
 *      「**不挂降级提示**」（空态与降级混起来，用户会去刷题而问题不在那，契约 §2.1）；
 *   ③ **降级分支**（`SB_PROBE_DEGRADE=no-model|call-failed|parse`）→ 用 CDP Fetch 域
 *      **拦下 analyze 请求并伪造该真因的降级响应**，验「提示真的上屏」「点明『本地规则版』」
 *      「**文案与真因相符**」（三个真因三句不同的话——把「未配模型」显示成「模型调用失败」
 *      会误导用户去重试，而问题在设置页）「降级时无 AI 口径行（不冒充）」「本地规则卡片仍在」。
 *      ★ 这是**唯一零副作用**的降级验法：真去解绑模型会污染用户配置。
 *
 * ★ 不变量要判「空真」而非「失败」：不变量是「**在途期间**按钮必须显示进行中且禁用」——
 *   操作若在首次采样前就已结束，该不变量**空真**（vacuously true），记 SKIP 不记 FAIL。
 *   零延迟分支（空态不调模型）实测就是这种情况：在途窗口可能比 80ms 采样还短，
 *   **同一套代码两次跑一次采到、一次采不到**。判红就是**假红灯**，会逼人去改本来正确的代码。
 *
 * 用法（**必须先把服务起起来**，见下）：
 *   node tools/probes/weak-analysis-cdp.mjs [套题标题]
 *   # 例：node tools/probes/weak-analysis-cdp.mjs "2026年经济走势练习题"
 *   # 降级分支（零副作用：拦请求伪造响应，不碰设置页/不碰库/不花额度）：
 *   #   SB_PROBE_DEGRADE=no-model   node tools/probes/weak-analysis-cdp.mjs
 *   #   SB_PROBE_DEGRADE=call-failed node tools/probes/weak-analysis-cdp.mjs
 *   #   SB_PROBE_DEGRADE=parse       node tools/probes/weak-analysis-cdp.mjs
 *
 * 前置：
 *   ① 后端起着（`npm run dev`，缺省 18791），且**该套题已有错题记录**——
 *      没有错题时服务端返回 `analyzed: 0` 空态，探针会判 `empty` 而非失败（属预期分支）；
 *   ② 前端 vite 起在 5174（本探针把 5174 写死在 APP 常量），代理指向同一个后端；
 *   ③ 设置页已给「薄弱点分析」绑过模型，否则走 `no-model` 降级分支，探针会如实报 fallback。
 * 截图落在 `SB_SHOT_DIR`（缺省＝系统临时目录），**不入仓**。
 *
 * ★ 踩过的坑（别重犯）：
 *   ① 「分析中…」是个**很短的窗口**（模型几秒内就回来）。点完必须**每 80ms 轮询**，
 *      间隔 1s 会直接跳过、误判成「三态没实现」。
 *   ② 按钮定位**不能写死 `:first-child`**：`.quiz-practice-actions` 里有两个按钮
 *      （薄弱点分析 / 本套笔记），按文案匹配才稳。
 *   ③ 探针跑之前别改仓里的文件——`tsx watch` 会热重载，请求撞在重载窗口上会 `ECONNRESET`，
 *      看着像接口不稳，实际是自己把自己重启了（见 CHANGELOG 2026-09-15）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
/**
 * ★ 端口**随机**（9300~9499，可用 `SB_CDP_PORT` 固定），**别用固定端口**：
 *   连续跑多次时，上一次的 Chrome 未必已释放端口，固定端口会让新实例**绑不上**，
 *   而 `/json/version` 反而连到**残留的旧浏览器** —— 探针就跑到「别人家的实例」上去了。
 *   实测症状（本批 `parse` 分支首跑踩到，单独复跑即 17/17 全绿）：analyze 请求被 Fetch 暂停后
 *   永不 fulfil、按钮永远停在「分析中…」、`结果块已落屏` 吃满 180s 超时，整片断言红。
 *   **看着像产品挂了，实为探针连错了浏览器。**
 */
const PORT = Number(process.env.SB_CDP_PORT ?? 9300 + Math.floor(Math.random() * 200));
const APP = 'http://localhost:5174/';
const OUT = process.env.SB_SHOT_DIR ?? join(process.env.TEMP ?? '/tmp', 'sb-cdp-shots');
const title = process.argv[2] ?? '2026年经济走势练习题';
/**
 * `SB_PROBE_DEGRADE=no-model|call-failed|parse` ⇒ 走**降级分支验证**：
 * 拦下 analyze 请求、伪造一个该真因的降级响应，验「降级提示真的上屏、文案与真因相符、
 * 且**不冒充 AI 分析**」。不设则为正常两分支（AI 主路径 / 空态）。
 */
const DEGRADE = process.env.SB_PROBE_DEGRADE ?? null;
const DEGRADE_BODY = DEGRADE
  ? {
      // 形状照服务端 `localWeakPoints` 的降级产出（本地规则 + 恒 fallback:true）
      weak: [
        {
          topic: '正确率低于 60% 的题目',
          questionIndexes: [0, 1],
          reason: '正确率低于 60% 的题目',
          suggestion: '针对这些题重新练习，并阅读解析',
        },
      ],
      fallback: true,
      failure: DEGRADE,
      analyzed: 4,
    }
  : null;
const scene = DEGRADE ? `weak-degrade-${DEGRADE}` : 'weak';
const profile = join(process.env.TEMP ?? '/tmp', `sb-cdp-weak-${Date.now()}`);

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ★ 起 Chrome 之前先确认端口没人占：否则下面的 /json/version 会连到**残留实例**，
//   探针就跑到别人的浏览器里去了（症状见上面 PORT 的注释）。宁可拒绝跑，也不要给出假结论。
const stale = await (async () => {
  try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch { return false; }
})();
if (stale) {
  console.error(`端口 ${PORT} 上已有 CDP 实例在跑（残留 Chrome？）——拒绝继续，否则会连到别人的浏览器实例。`);
  console.error('换个端口：SB_CDP_PORT=9xxx node tools/probes/weak-analysis-cdp.mjs');
  process.exit(2);
}

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
/**
 * 降级分支验证用的伪造响应体（`SB_PROBE_DEGRADE` 设置时非 null）。
 *
 * ★ 用 CDP 的 **Fetch 域拦下** `/api/quiz/analyze/*` 并直接 fulfil 一个降级体 ——
 *   这样验降级**零副作用**：不去设置页解绑模型、不碰真实库、不花模型额度。
 *   「要验降级就得先把 analyzer 模型解绑，而解绑会污染用户配置」正是当初放弃验这条分支的
 *   唯一原因 —— 请求拦截把这道坎直接拆了。
 */
let interceptBody = DEGRADE_BODY;
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Fetch.requestPaused') {
    const p = msg.params;
    if (interceptBody) {
      void send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(JSON.stringify(interceptBody), 'utf8').toString('base64'),
      });
    } else {
      void send('Fetch.continueRequest', { requestId: p.requestId });
    }
  }
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

/** 轮询直到 expr 求值为真；返回最后一次的值。间隔缺省 200ms。 */
const waitFor = async (expr, timeoutMs, intervalMs = 200) => {
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
// 降级分支：在**点按钮之前**就开拦截，否则请求已经出去了
if (DEGRADE_BODY) {
  await send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/quiz/analyze/*', requestStage: 'Request' }],
  });
  console.log(`降级分支验证模式：拦截 analyze 请求，伪造 failure = ${DEGRADE}`);
}
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
/**
 * 「不变量无从观测」≠「不变量被违反」。零延迟分支（如空态不调模型）里，
 * 在途窗口可能比首次采样还短 —— 判 FAIL 就是**假红灯**，会逼人去改本来正确的代码。
 */
const skip = (name, why) => {
  checks.push({ name, skip: true });
  console.log(`SKIP  ${name}  ${why}`);
};

// ── 1. 进题库页 ─────────────────────────────────────────────────────────────
const nav = await evalJs(`(() => {
  const b = [...document.querySelectorAll('.sb-nav-item')].find(x => x.textContent.includes('题库'));
  if (!b) return 'no-nav';
  b.click(); return 'ok';
})()`);
check('进题库页', nav === 'ok', `nav=${nav}`);
await sleep(1800);

// ── 2. 点开目标套题 ─────────────────────────────────────────────────────────
const opened = await evalJs(`(() => {
  const items = [...document.querySelectorAll('.quiz-bank-item')];
  const hit = items.find(el => (el.querySelector('.t')?.textContent ?? '').trim() === ${JSON.stringify(title)});
  if (!hit) return JSON.stringify({ ok: false, titles: items.map(el => (el.querySelector('.t')?.textContent ?? '').trim()).slice(0, 30) });
  hit.click();
  return JSON.stringify({ ok: true, total: items.length });
})()`);
const openedObj = JSON.parse(opened ?? '{}');
check('点开目标套题', openedObj.ok, openedObj.ok ? `题库共 ${openedObj.total} 套` : `没找到「${title}」，在列的有：${JSON.stringify(openedObj.titles)}`);
if (!openedObj.ok) { await shot('99-no-bank-item'); }
await sleep(2000);

// ── 3. 练习视图 + 按钮在位 ──────────────────────────────────────────────────
// ★ 按文案定位，不写死 :first-child（同容器里还有「本套笔记」）
const BTN = `[...document.querySelectorAll('button')].find(b => /薄弱点分析|分析中/.test(b.textContent))`;
const pre = await evalJs(`(() => {
  const b = ${BTN};
  return JSON.stringify({
    hasCard: !!document.querySelector('[class*="quiz-card"]'),
    btnText: b ? b.textContent.trim() : null,
    hasWeakBlock: !!document.querySelector('.quiz-weak'),
  });
})()`);
const preObj = JSON.parse(pre ?? '{}');
check('练习视图已渲染', preObj.hasCard, `hasCard=${preObj.hasCard}`);
check('「薄弱点分析」按钮在位', preObj.btnText === '薄弱点分析', `btnText=${preObj.btnText}`);
check('点击前无残留结果块', !preObj.hasWeakBlock, `hasWeakBlock=${preObj.hasWeakBlock}`);
await shot('01-practice-before');

// ★ 先把按钮滚进视口再点——否则「分析中…」的在途截图里根本看不到那个按钮（白截一张）
await evalJs(`(() => { const a = document.querySelector('.quiz-practice-actions'); if (a) a.scrollIntoView({ block: 'center' }); return 'ok'; })()`);
await sleep(400);
await shot('01b-practice-actions');

// ── 4. 点击 + 抓「分析中…」在途态（★ 80ms 密轮询，见文件头坑 ①） ──────────
const clicked = await evalJs(`(() => { const b = ${BTN}; if (!b) return 'no-btn'; b.click(); return 'ok'; })()`);
check('按钮可点', clicked === 'ok', `click=${clicked}`);

let busyText = null;
let busyDisabled = null;
/** 操作在首次采样前就已结束（零延迟分支）⇒ 在途态无从观测，不算失败 */
let doneBeforeSample = false;
for (let i = 0; i < 60; i += 1) {
  const s = await evalJs(`(() => {
    const b = ${BTN};
    return JSON.stringify({
      t: b ? b.textContent.trim() : null,
      d: b ? !!b.disabled : null,
      done: !!document.querySelector('.quiz-weak'),
    });
  })()`);
  const o = JSON.parse(s ?? '{}');
  if (o.t && o.t.includes('分析中')) { busyText = o.t; busyDisabled = o.d; break; }
  if (o.done) { doneBeforeSample = true; break; } // 已经出结果了，在途窗口比采样还短
  await sleep(80);
}
// ★ 不变量是「**在途期间**按钮必须显示进行中且禁用」；操作已结束则该不变量**空真**（vacuously true），
//   不是失败。零延迟分支（空态 `analyzed:0` 不调模型）实测就是这种情况。
if (doneBeforeSample) {
  skip('在途态：按钮转「分析中…」', '操作在首次采样前已完成（零延迟分支），在途态无从观测');
  skip('在途态：按钮被禁用', '同上');
} else {
  check('在途态：按钮转「分析中…」', busyText === '分析中…', `busyText=${busyText}`);
  check('在途态：按钮被禁用', busyDisabled === true, `disabled=${busyDisabled}`);
}
if (busyText) await shot('02-analyzing');

// ── 5. 等结果落屏（AI 实时生成，给足 180s） ─────────────────────────────────
const appeared = await waitFor(`!!document.querySelector('.quiz-weak')`, 180000, 500);
check('结果块已落屏', !!appeared, `waited=${!!appeared}`);

// ★ 第三态：结果落屏后按钮必须**复位**（回到「薄弱点分析」且可再点）。
//   不复位＝用户只能分析一次，第二次得刷新页面——三态里最容易漏的就是这一头。
const after = await evalJs(`(() => { const b = ${BTN}; return b ? JSON.stringify({ t: b.textContent.trim(), d: !!b.disabled }) : null; })()`);
const afterObj = JSON.parse(after ?? 'null');
check('第三态：按钮已复位为「薄弱点分析」', afterObj?.t === '薄弱点分析', `btnText=${afterObj?.t}`);
check('第三态：按钮已解禁（可重复分析）', afterObj?.d === false, `disabled=${afterObj?.d}`);

const raw = await evalJs(`(() => {
  const block = document.querySelector('.quiz-weak');
  if (!block) return null;
  const items = [...block.querySelectorAll('.quiz-weak-item')].map(el => ({
    topic: (el.querySelector('.quiz-weak-topic')?.childNodes[0]?.textContent ?? '').trim(),
    indexes: (el.querySelector('.quiz-weak-topic .m')?.textContent ?? '').trim(),
    reason: (el.querySelector('.quiz-weak-reason')?.textContent ?? '').trim(),
    suggestion: (el.querySelector('.quiz-weak-sug')?.textContent ?? '').trim(),
  }));
  const errNode = [...document.querySelectorAll('.quiz-explain')].map(e => e.textContent.trim()).find(t => t.startsWith('分析失败'));
  return JSON.stringify({
    head: (block.querySelector('.quiz-weak-head')?.textContent ?? '').trim() || null,
    empty: (block.querySelector('.quiz-explain')?.textContent ?? '').trim() || null,
    fallback: (block.querySelector('.quiz-weak-fallback')?.textContent ?? '').trim() || null,
    items,
    err: errNode ?? null,
  });
})()`);
const R = JSON.parse(raw ?? 'null');
if (!R) { check('结果块结构可读', false, 'block 为 null'); }

// ── 6. 断言 ────────────────────────────────────────────────────────────────
check('无前端错误位', !R?.err, `err=${R?.err}`);

const isEmptyState = !!R?.empty;
// 降级真因 → 文案里**必须**出现的那句特征串。★ 三个真因是三句不同的话：
//   把「未配模型」显示成「模型调用失败」会误导用户去重试，而问题其实在设置页没绑模型（ADR-5）。
const DEGRADE_MARK = {
  'no-model': /未配置「薄弱点分析」模型/,
  'call-failed': /模型调用失败/,
  parse: /模型输出没能解析成结构/,
};
if (DEGRADE) {
  // ★ 降级分支：提示必须上屏、文案必须与真因相符、且**不得冒充 AI 分析**（ADR-5）
  check('降级提示已上屏', !!R?.fallback, `fallback=${R?.fallback}`);
  check('降级提示点明「本地规则版」', /本地规则版/.test(R?.fallback ?? ''), `fallback=${R?.fallback}`);
  check('降级时无 AI 口径行（不冒充）', !R?.head, `head=${R?.head}`);
  check(`降级文案与真因相符（${DEGRADE}）`, (DEGRADE_MARK[DEGRADE] ?? /./).test(R?.fallback ?? ''), `fallback=${R?.fallback}`);
  check('降级时本地规则卡片仍渲染', (R?.items?.length ?? 0) >= 1, `items=${R?.items?.length}`);
} else if (isEmptyState) {
  // 没做题 ⇒ analyzed:0 空态。这是**预期分支**，不是失败，但要如实说清是哪种空态。
  check('空态文案正确', /先做题/.test(R.empty), `empty=${R.empty}`);
  // ★ 空态与降级必须分得开（契约 §2.1）：空态既不许挂口径行（「基于 0 道错题」是谎），
  //   也不许挂降级提示（「模型没接上」是另一回事，混起来用户会去刷题而问题不在那）。
  check('空态不谎称 AI 分析（无口径行）', !R.head, `head=${R.head}`);
  check('空态不冒充降级（无 fallback 提示）', !R.fallback, `fallback=${R.fallback}`);
  console.log('NOTE  该套题没有错题记录，走的是空态分支——要验 AI 主路径请先做几道题做错。');
} else {
  check('顶部口径行 = 「AI 分析（基于 N 道错题）」', /^AI 分析（基于 \d+ 道错题）$/.test(R?.head ?? ''), `head=${R?.head}`);
  check('多主题卡片已渲染（≥1 条）', (R?.items?.length ?? 0) >= 1, `items=${R?.items?.length}`);
  check('非降级时无 fallback 提示', !R?.fallback, `fallback=${R?.fallback}`);

  let allShape = true;
  const bad = [];
  for (const [i, it] of (R?.items ?? []).entries()) {
    const okTopic = it.topic.length > 0;
    const okIdx = /^第 \d+(、\d+)* 题$/.test(it.indexes);
    const okReason = it.reason.length > 0;
    const okSug = it.suggestion.startsWith('建议：') && it.suggestion.length > 3;
    if (!(okTopic && okIdx && okReason && okSug)) { allShape = false; bad.push({ i, ...it, okTopic, okIdx, okReason, okSug }); }
  }
  check('每条卡片四要素齐全（主题/题号/理由/建议）', allShape, allShape ? `${R?.items?.length} 条全过` : JSON.stringify(bad));

  // 题号必须 1 基（用户看到的是第 1 题，不是第 0 题）
  const idxOk = (R?.items ?? []).every(it => !/第 0 题/.test(it.indexes));
  check('题号是 1 基（无「第 0 题」）', idxOk, idxOk ? 'ok' : '出现了第 0 题');
}

// 滚动到结果块再截一张（截图留档给人看观感）
await evalJs(`(() => { const b = document.querySelector('.quiz-weak'); if (b) b.scrollIntoView({ block: 'center' }); return 'ok'; })()`);
await sleep(500);
await shot('03-weak-result');

// ── 7. 汇总 ────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.pass && !c.skip);
const skipped = checks.filter((c) => c.skip);
console.log('\n===== 汇总 =====');
console.log(JSON.stringify({ title, degrade: DEGRADE, total: checks.length, failed: failed.length, skipped: skipped.length, isEmptyState, items: R?.items?.length ?? 0, head: R?.head ?? null, fallback: R?.fallback ?? null }, null, 2));
if (failed.length) console.log('未通过：', JSON.stringify(failed, null, 2));

ws.close();
chrome.kill();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows 占用残留可忽略 */ }
const ran = checks.length - skipped.length;
console.log(failed.length ? `FAILED  ${failed.length}/${checks.length}` : `DONE  ${ran}/${checks.length} 全过${skipped.length ? `（另 ${skipped.length} 项 SKIP）` : ''}`);
process.exit(failed.length ? 1 : 0);
