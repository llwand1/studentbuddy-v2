/**
 * tools/probes/bing-channel-live.mjs —— 免 key 搜索兜底通道的**真网络**体检（issue #11 / B-019）
 *
 * 立探针的理由：`search.test.ts` 全程 mock `fetch`，**整条真链路没有自动化测**（test-plan §6 老挂账）。
 * 2026-09-24 上游一次改版就撞上了这个洞：`cn.bing.com/search` 的 301 开始丢掉 `/search` 路径，
 * 跟随后拿到首页 ⇒ RSS/HTML 两通道同时 0 条，免 key 部署的联网搜索整条哑掉**且没有任何报错露出**，
 * 全靠人肉翻 `event_log` 才发现。这类失效唯一的发现方式就是定期打一次真请求。
 *
 * ★ 探针分两层，互不替对方作证：
 *   ① 逐跳跟随重定向的**裸 fetch**（经真 `fetchSafe`，与线上同一份实现）——分别打 www 与 cn 两个
 *      主机名，把「上游现在到底是什么形状」原样打出来；
 *   ② 经 esbuild 现场转译加载的**真实 `searchWeb`**（0 key ⇒ 必走 Bing）——钉的是线上判据：
 *      `providers` 含 `bing` 且结果数 ≥ 1。复现一份实现的探针必然与线上漂开。
 *
 * 只读声明：`SB_DATA_DIR` 指向 `mkdtempSync` 的临时目录，**不打开、不触碰任何真实数据目录**
 *   （缓存表 `search_cache` 落在这个临时库里）；对 Bing 只发 GET，不写任何远端状态。
 *   bundle 产物落在项目根、跑完即删（try/finally）。
 * ★ 这台机器上跑通 ≠ 那台机器上跑得通：本探针的结论**只在执行机上成立**。
 *   生产机（出口 IP 与国内网络策略都不同）要各跑一次，见文末提示。
 *
 * 用法：node tools/probes/bing-channel-live.mjs ["查询词"]      默认查询词＝"今天新闻"
 * 输出：逐项 ✓/✗ + 末行 `RESULT: PASS|FAIL`；退出码 0=PASS、1=FAIL（可直接给 cron/CI 判）。
 * 会真连外网，约 10–30 秒。
 *
 * 2026-09-25 首跑读数（本机＝国内出口）：www 的 RSS/HTML 两路正常；**cn.bing.com 在本机仍能拿到
 * 9 条 <item>**——同一个主机名在生产机（境外出口）上却 301 丢掉 /search。⇒ 「Bing 哪个主机名能用」
 * **取决于出口 IP，不是代码里的常量**，这也是为什么第 3 段只观测不判红、以及为什么必须两侧各跑一次。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-bing-probe-'));
// ★ 必须在任何 import 之前设好：bundle 后的模块在 import 时就会读 env 并惰性开库
process.env.SB_DATA_DIR = tmp;
for (const k of ['EXA_API_KEY', 'TAVILY_API_KEY', 'ZHIPU_API_KEY']) delete process.env[k];

const QUERY = process.argv[2] || '今天新闻';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`);
  return cond;
};

console.log('=== 0. 环境 ===');
console.log(`  node ${process.version} | 查询词 "${QUERY}" | 出口：真连外网`);
console.log(`  临时数据目录 ${tmp}（跑完即删，不碰真库）`);

const bundlePath = path.join(root, `.probe-bing-channel-${process.pid}.mjs`);

/**
 * 逐跳跟随重定向（与 `search/ssrf-guard.ts` 同一份实现，不是复现一份），
 * 回报最终落点与形状读数。`fetchSafe` 由调用方从 bundle 里取来传入。
 */
async function probeUrl(fetchSafe, rawUrl) {
  const init = { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } };
  const res = await fetchSafe(rawUrl, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await res.text();
  return {
    status: res.status,
    finalUrl: typeof res.url === 'string' ? res.url : '',
    chars: body.length,
    items: (body.match(/<item>/gi) || []).length,
    bAlgo: (body.match(/b_algo/g) || []).length,
    isRss: /<rss[\s>]/i.test(body),
  };
}

let searchWeb;
let fetchSafe;
let getDb;

try {
  console.log('\n=== 0.5 现场转译 TS 源（esbuild）取真实实现 ===');
  const t0 = Date.now();
  // 探针入口临时件：TS 源不能被 Node 直接 import，统一经 bundle 取出真实符号。
  const entryPath = path.join(root, `.probe-bing-entry-${process.pid}.ts`);
  fs.writeFileSync(
    entryPath,
    "export { searchWeb } from './packages/server/src/search/index.js';\n" +
      "export { fetchSafe } from './packages/server/src/search/ssrf-guard.js';\n" +
      "export { getDb } from './packages/server/src/storage/db.js';\n",
  );
  await build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundlePath,
    external: ['better-sqlite3'],
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(bundlePath).href);
  searchWeb = mod.searchWeb;
  fetchSafe = mod.fetchSafe;
  getDb = mod.getDb;
  fs.rmSync(entryPath, { force: true });
  check(
    'bundle + import 真实实现',
    typeof searchWeb === 'function' && typeof fetchSafe === 'function',
    `${Date.now() - t0}ms`,
  );

  console.log('\n=== 1. 现役端点 www.bing.com（RSS 主通道该拿到 ≥1 条 <item>）===');
  const rssUrl = `https://www.bing.com/search?q=${encodeURIComponent(QUERY)}&format=rss`;
  const rss = await probeUrl(fetchSafe, rssUrl);
  console.log(`  HTTP ${rss.status} → ${rss.finalUrl} | ${rss.chars} 字符 | <item>=${rss.items} | 像 RSS=${rss.isRss}`);
  check('RSS 通道真出结果（items ≥ 1）', rss.items >= 1, `items=${rss.items}`);

  console.log('\n=== 2. 现役端点 www.bing.com（HTML 兜底通道该有 b_algo）===');
  const htmlUrl = `https://www.bing.com/search?q=${encodeURIComponent(QUERY)}`;
  const html = await probeUrl(fetchSafe, htmlUrl);
  console.log(`  HTTP ${html.status} → ${html.finalUrl} | ${html.chars} 字符 | b_algo=${html.bAlgo}`);
  check('HTML 通道真出结果（b_algo ≥ 1）', html.bAlgo >= 1, `b_algo=${html.bAlgo}`);

  console.log('\n=== 3. 旧端点 cn.bing.com 的形状（只观测，不参与判定）===');
  // 这一项**故意不作判**：cn 主机名 09-24 起 301 到首页，那是 B-019 的病灶；
  // 但上游随时可能改回去——它变好或变坏都不该让本探针转红，只把形状打出来留证。
  const cn = await probeUrl(fetchSafe, `https://cn.bing.com/search?q=${encodeURIComponent(QUERY)}&format=rss`);
  const cnKeepsSearchPath = /\/search\/?$/.test(new URL(cn.finalUrl).pathname);
  console.log(`  HTTP ${cn.status} → ${cn.finalUrl} | <item>=${cn.items}`);
  console.log(
    `  ${cnKeepsSearchPath ? '上游已修回：/search 路径保住了' : `仍是 B-019 的形状：跟随后落到 ${cn.chars} 字符的页面、0 条 <item>`}`,
  );

  console.log('\n=== 4. 真实 `searchWeb`（0 key ⇒ 必走免 key 兜底，线上判据）===');
  const r = await searchWeb(QUERY, null, { skipCache: true }); // skipCache：自检不许吃缓存
  console.log(`  providers=${JSON.stringify(r.providers)} | results=${r.results.length} | failed=${JSON.stringify(r.failed)}`);
  for (const item of r.results.slice(0, 3)) console.log(`    · ${item.title} [${item.source}] ${item.url.slice(0, 70)}`);
  check('providers 含 bing', r.providers.includes('bing'), r.providers.join(','));
  check('结果数 ≥ 1', r.results.length >= 1, `${r.results.length} 条`);
  check('failed 为空（两路都没抛形状异常）', r.failed.length === 0, r.failed.join(' ; ') || '无');
  check(
    '每条结果都有真实 URL 与非空摘要',
    r.results.length > 0 && r.results.every((x) => /^https?:\/\//.test(x.url) && x.snippet.length > 0),
  );
} catch (err) {
  failures += 1;
  console.error('  ✗ 探针异常：', err instanceof Error ? err.stack : String(err));
} finally {
  // 先关库句柄，否则临时目录里的 sqlite 文件在 Windows 上锁着删不掉（EBUSY）。
  // best-effort：关不掉只影响临时目录留存，不影响结论。
  try {
    getDb?.().close();
  } catch {
    /* 没开过库（异常发生在第 0.5 步之前）*/
  }
  fs.rmSync(bundlePath, { force: true });
  fs.rmSync(path.join(root, `.probe-bing-entry-${process.pid}.ts`), { force: true });
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    console.log(`  · 临时目录未清干净（不影响结论）：${tmp} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\nRESULT: ${failures === 0 ? 'PASS' : `FAIL（${failures} 项不通过）`}`);
console.log('★ 结论只在**执行机**上成立。生产机要各自跑一次：');
console.log('  scp 本文件与仓库同源目录后 `node tools/probes/bing-channel-live.mjs`，或整仓在服务器上跑。');
process.exit(failures === 0 ? 0 : 1);
