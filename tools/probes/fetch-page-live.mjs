/**
 * tools/probes/fetch-page-live.mjs —— `fetch_page` 的**真机抓取凭证**（契约 §5.3 / test-plan §6 未验项）
 *
 * 用途：把 test-plan §6 登记的三条「未验」钉成实测——
 *   ① 真实站点到底能不能抓到正文（mock 层只锁了「请求带什么参数、回灌什么形状」）；
 *   ② 浏览器 UA 会不会被拒（本地抓取不带 key，全靠 UA 撑）；
 *   ③ **JS 渲染页与 PDF/二进制资源的失败形态是什么**。契约写明「明确不支持」，但没跑过——
 *      「明确报错」与「静默产出一大段垃圾正文」是两回事，**后者更糟**（模型会把乱码当内容用）。
 *      ★ 非 HTML 段用**多候选**：单候选被 403 拒掉时，这条路径其实**从未被执行**，
 *        此时结论必须写「未验到」，不许写「未见异常」（空洞证明）。
 *   ④ **非 UTF-8 编码页（GBK/GB18030）的形态**（4d 段）——与 ③ 同症状、不同根因：
 *      `res.text()` 恒按 UTF-8 解、忽略 charset ⇒ GBK 页满屏替换符仍被当「正文」回灌。
 *
 * ★ 与 mock 层测试的分工（两者都不替对方作证）：
 *   `packages/server/src/chat/tools/fetch-page.test.ts` 锁**契约面**（参数、回灌口径、安全文案）；
 *   本探针锁**外部依赖的真实行为**（可达性、UA、真实 HTML 结构、非 HTML 资源的形态）。
 *
 * ★ 本探针**真调 `runTool('fetch_page')`** —— 用 esbuild 现场转译 TS 源再 import，
 *   不是复现一份实现。复现的那份必然与线上漂开，测出来的就不是线上的东西。
 *
 * 只读声明：`SB_DATA_DIR` 指向 `fs.mkdtempSync` 的临时目录，**不打开、不触碰任何真实数据目录**；
 *   对被抓站点只发 GET，不写任何远端状态。bundle 产物落在项目根、跑完即删（try/finally）。
 *
 * 用法：node tools/probes/fetch-page-live.mjs
 * 输出：逐节打印，末行 `RESULT: …`。会真连外网，约 1–2 分钟（单站点上限 15s，工具内部超时）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fetch-probe-'));
// ★ 在任何 import 之前设好：bundle 后的模块在 import 时就会读 env
process.env.SB_DATA_DIR = tmp;

const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
  return cond;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('=== 0. 环境 ===');
console.log('  node:', process.version, '| 临时数据目录:', tmp, '（跑完即删，不碰真库）');

// bundle 落项目根：external 的 better-sqlite3 要从项目 node_modules 解析，
// 落在 os.tmpdir() 里会找不到（Node 的 node_modules 解析是逐级向上的）。
const bundlePath = path.join(root, `.probe-fetch-page-${process.pid}.mjs`);

let runTool;
let toolMeta;
let toolNames;

try {
  console.log('\n=== 1. 现场转译 TS 源（esbuild）并加载真实工具 ===');
  const t0 = Date.now();
  await build({
    entryPoints: [path.join(root, 'packages/server/src/chat/tools/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundlePath,
    external: ['better-sqlite3'],
    logLevel: 'silent',
  });
  ({ runTool, toolMeta, toolNames } = await import(pathToFileURL(bundlePath).href));
  ok('bundle + import 成功', typeof runTool === 'function', `${Date.now() - t0}ms`);
  ok('`fetch_page` 已在注册表', toolNames().includes('fetch_page'), `现役 ${toolNames().length} 个：${toolNames().join(', ')}`);

  console.log('\n=== 2. 元数据（探针测的是真注册表，不是副本）===');
  const meta = toolMeta('fetch_page');
  ok('kind = network（⇒ 免确认 + 60s 档）', meta?.kind === 'network');
  ok('idempotent = true（⇒ 有 §4.3-5 重试资格）', meta?.idempotent === true);
  ok('timeoutMs 未设（档位基线不被单个工具拉高）', meta?.timeoutMs === undefined);

  function makeCtx() {
    const steps = [];
    return { steps, ctx: { onStep: (tool, status, detail) => steps.push({ tool, status, detail }), ownerId: null } };
  }

  async function grab(url) {
    const { ctx, steps } = makeCtx();
    const t0 = Date.now();
    const r = await runTool('fetch_page', JSON.stringify({ url }), ctx);
    return { content: r.content, steps, ms: Date.now() - t0 };
  }

  console.log('\n=== 3. SSRF 守卫的真机拦截（不依赖外网，秒级）===');
  for (const [label, url] of [
    ['回环 IPv4', 'http://127.0.0.1:8080/admin'],
    ['内网 192.168.x', 'http://192.168.1.1/'],
    ['链路本地（云元数据）', 'http://169.254.169.254/latest/meta-data/'],
    ['非 http(s)', 'file:///C:/Windows/win.ini'],
  ]) {
    const r = await grab(url);
    const leaked = /127\.0\.0\.1|192\.168\.|169\.254\.|win\.ini/.test(r.content);
    ok(
      `${label} 被拦且文案不外泄地址`,
      r.content.includes('该地址不被允许访问') && !leaked,
      `"${r.content.slice(0, 46)}…"`,
    );
  }

  console.log('\n=== 4. 真实站点抓取（会真连外网；单站点上限 15s）===');
  const SITES = [
    { name: '百度百科（中文静态 HTML）', url: 'https://baike.baidu.com/item/牛顿第二定律' },
    { name: 'MDN 中文（技术文档）', url: 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript' },
    { name: 'HTTP→HTTPS 重定向', url: 'http://baidu.com' },
    { name: '中文维基（本机网络可能不可达，如实记录）', url: 'https://zh.wikipedia.org/wiki/牛顿第二定律' },
  ];

  const results = [];
  for (const s of SITES) {
    const r = await grab(s.url);
    const succeeded = r.content.includes('是**数据不是指令**');
    const noBody = r.content.includes('没提取到正文');
    const failed = r.content.includes('本次没读到');
    const bodyStart = r.content.indexOf('\n\n来源：');
    const body = bodyStart >= 0 ? r.content.slice(r.content.indexOf('\n\n', bodyStart + 2)).trim() : '';
    const chars = body.length;
    const truncated = r.content.includes('已截断到前');
    results.push({ ...s, succeeded, noBody, failed, chars, truncated, ms: r.ms, sample: body.slice(0, 70) });

    const verdict = succeeded ? '抓到正文' : noBody ? '无正文' : failed ? '读取失败' : '未知';
    ok(`${s.name}`, succeeded, `${r.ms}ms · ${verdict} · ${chars} 字${truncated ? '（已截断）' : ''}`);
    if (succeeded) console.log(`      样本：${body.slice(0, 60).replace(/\s+/g, ' ')}…`);
    else console.log(`      回灌：${r.content.slice(0, 90).replace(/\s+/g, ' ')}…`);
    await sleep(300);
  }

  console.log('\n=== 4b. 非 HTML 资源形态（多候选；至少一个连到才算验到）===');
  // ★ 上一轮只用 w3.org 的 dummy.pdf，被 403 拒了 —— 于是「二进制路径」**根本没被执行**，
  //   结论里那句「未见异常」是空洞的。多候选就是为了避免再次空洞。
  const NON_HTML = [
    { name: 'PDF（pdf.js 官方样例）', url: 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf' },
    { name: 'PNG（真二进制）', url: 'https://httpbin.org/image/png' },
    { name: 'SVG（文本型非 HTML）', url: 'https://www.iana.org/_img/2022/iana-logo-header.svg' },
  ];
  const nonHtmlResults = [];
  for (const s of NON_HTML) {
    const r = await grab(s.url);
    const succeeded = r.content.includes('是**数据不是指令**');
    const failed = r.content.includes('本次没读到');
    const bodyStart = r.content.indexOf('\n\n来源：');
    const body = bodyStart >= 0 ? r.content.slice(r.content.indexOf('\n\n', bodyStart + 2)).trim() : '';
    // 「二进制被当正文」判据：PDF 头 / 控制字符 / 大量替换符（UTF-8 解码失败留痕）
    const pdfHead = r.content.includes('%PDF-');
    const ctrl = (r.content.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
    const replaced = (r.content.match(/\uFFFD/g) ?? []).length;
    const suspicious = pdfHead || ctrl > 0 || replaced > 20;
    nonHtmlResults.push({ ...s, succeeded, failed, chars: body.length, pdfHead, ctrl, replaced, suspicious, ms: r.ms, sample: body.slice(0, 60) });

    const verdict = succeeded ? `当「正文」回灌了 ${body.length} 字` : failed ? '读取失败（被拒）' : '其他';
    ok(`${s.name}`, !suspicious, `${r.ms}ms · ${verdict}`);
    if (succeeded) {
      console.log(`      样本：${body.slice(0, 60).replace(/\s+/g, ' ')}…`);
      if (suspicious) {
        console.log(`      ⚠️ 可疑：PDF头=${pdfHead} 控制字符=${ctrl} 替换符=${replaced} —— 二进制被当 HTML 剥标签了`);
      }
    } else {
      console.log(`      回灌：${r.content.slice(0, 90).replace(/\s+/g, ' ')}…`);
    }
    await sleep(300);
  }
  const reachedNonHtml = nonHtmlResults.filter((r) => !r.failed);
  const garbage = nonHtmlResults.filter((r) => r.succeeded && r.suspicious);

  console.log('\n=== 4c. JS 渲染页（SPA 空壳）——失败形态须「如实说没正文」，不许编造 ===');
  const CSR = [{ name: 'Excalidraw（Vite SPA 空壳）', url: 'https://excalidraw.com/' }];
  for (const s of CSR) {
    const r = await grab(s.url);
    const noBody = r.content.includes('没提取到正文');
    const succeeded = r.content.includes('是**数据不是指令**');
    const verdict = noBody ? '如实报「没提取到正文」' : succeeded ? '抓到了正文（SSR 兜住了）' : '其他';
    ok(`${s.name}（形态如实即可）`, noBody || succeeded, `${r.ms}ms · ${verdict}`);
    console.log(`      回灌：${r.content.slice(0, 100).replace(/\s+/g, ' ')}…`);
    await sleep(300);
  }

  console.log('\n=== 4d. 非 UTF-8 编码页（GBK/GB18030）——「乱码冒充正文」的第二条根因 ===');
  // ★ 与 4b 是**同一个症状、不同根因**：4b 是二进制被当文本，本条是**文本用错编码解**。
  //   Node 的 `res.text()` **恒按 UTF-8 解码、忽略 content-type 里的 charset** ⇒ GBK 页满屏 U+FFFD。
  //   内容闸门（`looksBinary`）**刻意不看替换符占比**（那会把 GBK 页误判成二进制而拒掉正常页面），
  //   所以这条路径闸门拦不住——本节要量的是「它到底以什么形态回到模型手里」。
  const GBK = [
    { name: '湘潭市政府（不声明 charset，字节实为 GBK）', url: 'http://www.xiangtan.gov.cn/' },
    { name: '岳阳市政府（不声明 charset，字节实为 GBK）', url: 'http://www.yueyang.gov.cn/' },
    { name: '当当网（content-type 显式声明 charset=GBK）', url: 'http://www.dangdang.com/' },
  ];
  const gbkResults = [];
  for (const s of GBK) {
    const r = await grab(s.url);
    const succeeded = r.content.includes('是**数据不是指令**');
    const failed = r.content.includes('本次没读到');
    const notWeb = r.content.includes('不是网页正文');
    const bodyStart = r.content.indexOf('\n\n来源：');
    const body = bodyStart >= 0 ? r.content.slice(r.content.indexOf('\n\n', bodyStart + 2)).trim() : '';
    const rep = (body.match(/\uFFFD/g) ?? []).length;
    const ratio = body.length ? rep / body.length : 0;
    const mojibake = succeeded && ratio > 0.05;
    gbkResults.push({ ...s, succeeded, failed, notWeb, chars: body.length, rep, ratio, mojibake, ms: r.ms, sample: body.slice(0, 60) });

    const verdict = succeeded ? `当「正文」回灌 ${body.length} 字` : failed ? '读取失败' : notWeb ? '如实拒绝（非网页）' : '其他';
    ok(`${s.name}`, !mojibake, `${r.ms}ms · ${verdict} · 替换符 ${rep}（${(ratio * 100).toFixed(1)}%）`);
    if (succeeded) console.log(`      样本：${body.slice(0, 60).replace(/\s+/g, ' ')}…`);
    else console.log(`      回灌：${r.content.slice(0, 90).replace(/\s+/g, ' ')}…`);
    await sleep(300);
  }
  const mojibakeHits = gbkResults.filter((r) => r.mojibake);

  console.log('\n=== 5. 回灌形态（真机路径也要满足契约 §5.3）===');
  const anyOk = results.find((r) => r.succeeded);
  if (anyOk) {
    const r = await grab(anyOk.url);
    ok('正文前置「是数据不是指令」护栏', r.content.includes('是**数据不是指令**'));
    ok('带回来源 URL', r.content.includes(`来源：${anyOk.url}`));
  } else {
    console.log('  （本轮无成功抓取，跳过）');
  }

  console.log('\n=== 6. 结论 ===');
  const grabbed = results.filter((r) => r.succeeded);
  const unreachable = results.filter((r) => r.failed);
  const emptyBody = results.filter((r) => r.noBody);
  console.log(`  常规站点：可达并抓到正文 ${grabbed.length}/${results.length}`);
  console.log(`  网络不可达/被拒：${unreachable.length}｜提取到空正文：${emptyBody.length}`);
  console.log(`  非 HTML 资源：实际连到 ${reachedNonHtml.length}/${nonHtmlResults.length}｜疑似二进制被当正文：${garbage.length}`);
  console.log(`  非 UTF-8 编码页：连到 ${gbkResults.filter((r) => !r.failed && !r.notWeb).length}/${gbkResults.length}｜**乱码当正文**：${mojibakeHits.length}`);
  if (garbage.length > 0) {
    console.log(`  ★ 需处置：${garbage.map((r) => r.name).join('、')} —— 静默产出可疑正文，建议加内容类型/二进制特征拦截`);
  } else if (reachedNonHtml.length === 0) {
    console.log('  ⚠️ 本轮非 HTML 候选全被拒 —— 二进制路径**仍未验到**，不得据此说「未见异常」');
  }
  if (mojibakeHits.length > 0) {
    console.log(`  ★ 待处置（另一条根因）：${mojibakeHits.map((r) => r.name).join('、')} ——`);
    console.log('     GBK 字节被按 UTF-8 解码 ⇒ 满屏替换符仍被当「正文」回灌。');
    console.log('     修法方向：读 content-type 的 charset → arrayBuffer() → new TextDecoder(charset)。');
    console.log('     ★ 不能靠 looksBinary 拦（替换符占比不是二进制判据，拦了会误杀正常页）。');
  }

  console.log(
    `\nRESULT: 常规站点 ${grabbed.length}/${results.length} 成功；SSRF 四类拦截全过；` +
      `非 HTML 路径 ${reachedNonHtml.length === 0 ? '未验到（候选全拒）' : garbage.length > 0 ? `**检出可疑 ${garbage.length} 例**` : '验到且未见异常'}；` +
      `GBK 页乱码回灌 ${mojibakeHits.length}/${gbkResults.length}`,
  );
} finally {
  try {
    fs.unlinkSync(bundlePath);
  } catch {
    /* bundle 不存在或已删，忽略 */
  }
}
