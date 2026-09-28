#!/usr/bin/env tsx
/**
 * model-bench/harvest —— 现场从网络上搜真题，冻成一份带出处的快照（`npm run eval:harvest`）。
 *
 * ══ 为什么是 .mts 而不是跟本目录其他文件一样的 .mjs ══
 *
 * 因为它要走**产品自己的 `searchWeb`**。
 * 本可以在 .mjs 里照着 `search/index.ts` 重写一遍 exa/tavily/zhipu/bing 四条通道——那就又是一处双写，
 * 而且会让「有 key / 无 key 两次采集的对比」变成「我重写的那版 vs 产品那版」的对比，毫无意义。
 * ⇒ 采集面**允许依赖产品**（口径同源优先），评分面继续保持零依赖（`run.mjs` 只读冻结快照，可复算）。
 * 这条分界与评测台「真调走产品链、打分走纯函数」是同一个取舍。
 *
 * ══ 两次采集，对比稳定性 ══
 *
 *   npm run eval:harvest -- --channel free            # 免 key：产品的 Bing 兜底通道
 *   npm run eval:harvest -- --channel keyed           # 带 key：exa / tavily / zhipu（读环境变量）
 *   npm run eval:compare -- --harvest <a.json> <b.json>   # 两份快照的产出率 / 重合度 / 来源分布
 *
 * `--channel free` 会在本进程内**临时抹掉**三个 key 环境变量，逼 `searchWeb` 走免 key 兜底
 * （它的选路规则就是「三家全无 key → Bing」）。抹的是本进程的副本，不碰你的 shell。
 *
 * ══ 凭据与安全 ══
 *
 * - 搜索 key 只从环境变量读，不落盘、不进快照、不打印（快照里只记 provider **名字**）。
 * - 抓取任意 URL 走产品的 `fetchSafe`（SSRF 防护 + 重定向逐跳复检）——搜索结果是外部输入，
 *   直接 `fetch` 就等于把内网探测能力送给搜索引擎排序算法。
 * - 临时库独立目录、退出即删（同 `tools/eval/lib/env.mts`）：本工具对你的真实库**零写入**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, openIsolated } from '../../../packages/server/src/storage/db.js';
import { htmlToText, searchWeb } from '../../../packages/server/src/search/index.js';
import { fetchSafe } from '../../../packages/server/src/search/ssrf-guard.js';
import { buildExtractPrompt, dedupe, parseExtracted, snapshotStats, validateItem } from './lib/harvest-lib.mjs';
import { chat } from './lib/client.mjs';

const HERE = import.meta.dirname;
const KEY_ENVS = ['EXA_API_KEY', 'TAVILY_API_KEY', 'ZHIPU_API_KEY'] as const;

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1] : dflt;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const channel = arg('channel', 'free')!;
  if (channel !== 'free' && channel !== 'keyed') {
    console.error(`--channel 只能是 free 或 keyed（给的是 ${channel}）`);
    process.exit(2);
  }

  const apiKey = process.env.EVAL_API_KEY ?? '';
  // 抽题器**可以与被测模型不同**（建议不同：同一只模型既抽题又复刻 = 自产自销，见 harvest-lib 头注）
  const model = process.env.EVAL_EXTRACT_MODEL || process.env.EVAL_MODEL || '';
  const apiBase = process.env.EVAL_API_BASE || 'https://api.openai.com/v1';
  if (!apiKey || !model) {
    console.error('采集需要抽题模型：EVAL_API_KEY 与 EVAL_MODEL（或 EVAL_EXTRACT_MODEL）。');
    process.exit(2);
  }

  const queriesFile = path.resolve(HERE, arg('queries', 'datasets/harvest-queries.json')!);
  const queries: string[] = JSON.parse(fs.readFileSync(queriesFile, 'utf8')).queries;
  const perQuery = Number(arg('pages', '3'));
  const limit = Number(arg('limit', '30'));

  // ★ free 档：抹掉本进程的 key 副本，逼 searchWeb 走免 key 兜底
  const stash: Record<string, string | undefined> = {};
  if (channel === 'free') for (const k of KEY_ENVS) { stash[k] = process.env[k]; delete process.env[k]; }
  const keysPresent = KEY_ENVS.filter((k) => (channel === 'free' ? stash[k] : process.env[k]));
  if (channel === 'keyed' && keysPresent.length === 0) {
    console.error(`--channel keyed 需要至少一个搜索 key（${KEY_ENVS.join(' / ')}），一个都没读到。`);
    process.exit(2);
  }

  // 临时库：searchWeb 要读 key 设置与写搜索缓存（每次采集一个全新空库 ⇒ 不会端出上次的旧结果）
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-harvest-'));
  openIsolated(dataDir);

  const started = new Date();
  const dropped: Record<string, number> = {};
  const providersSeen = new Set<string>();
  const searchFailures: string[] = [];
  const rawItems: Array<Record<string, unknown>> = [];
  let pagesFetched = 0;
  let pagesUsable = 0;
  let extractCalls = 0;
  let extractUnparsed = 0;
  let costUsd = 0;
  let costed = 0;

  try {
    for (const query of queries) {
      if (rawItems.length >= limit) break;
      let results: Array<{ title: string; url: string; snippet: string }> = [];
      try {
        const r = await searchWeb(query, null, { skipCache: true });
        results = r.results;
        for (const p of r.providers) providersSeen.add(p);
        if (r.failed.length > 0) searchFailures.push(`${query} → ${r.failed.join('; ')}`);
      } catch (e) {
        searchFailures.push(`${query} → ${e instanceof Error ? e.message : String(e)}`);
      }
      console.log(`🔎 [${channel}] ${query} → ${results.length} 条结果`);

      for (const hit of results.slice(0, perQuery)) {
        if (rawItems.length >= limit) break;
        let text = '';
        try {
          const res = await fetchSafe(hit.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; studentbuddy-eval-harvest/1.0)' },
            signal: AbortSignal.timeout(15_000),
          });
          pagesFetched += 1;
          if (!res.ok) { dropped[`http-${res.status}`] = (dropped[`http-${res.status}`] ?? 0) + 1; continue; }
          text = htmlToText(await res.text());
        } catch (e) {
          pagesFetched += 1;
          dropped['fetch-failed'] = (dropped['fetch-failed'] ?? 0) + 1;
          console.log(`   ✗ ${hit.url.slice(0, 70)} 抓取失败：${e instanceof Error ? e.message.slice(0, 60) : e}`);
          continue;
        }
        if (text.length < 200) {
          // 不静默：正文过薄多半是反爬页/同意页，与「这页没有题」不是一回事，现场看得见才好改查询词
          dropped['page-too-thin'] = (dropped['page-too-thin'] ?? 0) + 1;
          console.log(`   · ${hit.url.slice(0, 70)} 正文仅 ${text.length} 字符，跳过`);
          continue;
        }

        let raw = '';
        try {
          const out = await chat({ apiBase, apiKey, model, retries: 2, stream: false }, buildExtractPrompt(text, { title: hit.title }));
          raw = out.text;
          extractCalls += 1;
          if (Number.isFinite(out.sample.costUsd)) { costUsd += out.sample.costUsd!; costed += 1; }
        } catch (e) {
          dropped['extract-call-failed'] = (dropped['extract-call-failed'] ?? 0) + 1;
          console.log(`   ✗ 抽题调用失败：${e instanceof Error ? e.message.slice(0, 80) : e}`);
          continue;
        }

        const cands = parseExtracted(raw);
        if (cands == null) { extractUnparsed += 1; dropped['extract-unparsed'] = (dropped['extract-unparsed'] ?? 0) + 1; continue; }
        let kept = 0;
        for (const c of cands) {
          if (rawItems.length >= limit) break;
          const v = validateItem(c);
          if (!v.ok) { dropped[v.reason] = (dropped[v.reason] ?? 0) + 1; continue; }
          rawItems.push({
            ...v.item,
            sourceUrl: hit.url,
            sourceTitle: hit.title,
            query,
            channel,
            extractor: model,
            fetchedAt: new Date().toISOString(),
          });
          kept += 1;
        }
        if (kept > 0) pagesUsable += 1;
        console.log(`   ${kept > 0 ? '✓' : '·'} ${hit.url.slice(0, 70)} → 候选 ${cands.length} / 合格 ${kept}`);
      }
    }
  } finally {
    closeDb();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 删不掉就留着，不静默炸掉整轮 */ }
    if (channel === 'free') for (const k of KEY_ENVS) if (stash[k] !== undefined) process.env[k] = stash[k];
  }

  const { kept, removed } = dedupe(rawItems as Array<{ question: string }>);
  const items = kept.map((it, i) => ({ id: `live-${channel}-${String(i + 1).padStart(3, '0')}`, ...it }));

  const snapshot = {
    kind: 'harvest-snapshot',
    version: 1,
    channel,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    queries,
    // 只记 provider 名字，绝不记 key
    providers: [...providersSeen],
    keysPresent: keysPresent.map(String),
    extractor: model,
    extractCalls,
    extractUnparsed,
    extractCostUsd: costed > 0 ? costUsd : null,
    extractCostedCalls: costed,
    pagesFetched,
    pagesUsable,
    duplicatesRemoved: removed,
    dropped,
    searchFailures,
    items,
  };

  const outDir = path.join(HERE, 'harvests');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = arg('out') ? path.resolve(process.cwd(), arg('out')!) : path.join(outDir, `${stamp}-${channel}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');

  const s = snapshotStats(snapshot);
  console.log('\n═══════════ 采集结果 ═══════════');
  console.log(`通道 ${channel}（实际出结果的来源：${snapshot.providers.join('、') || '无'}）`);
  console.log(`查询 ${s.queries} 条 → 抓页 ${s.pagesFetched}（其中 ${s.pagesUsable} 页产出了题）→ 合格题 ${s.items} 道（去重掉 ${s.duplicatesRemoved} 道）`);
  console.log(`抽题调用 ${extractCalls} 次${snapshot.extractCostUsd != null ? `，成本 $${snapshot.extractCostUsd.toFixed(4)}` : '（无 usage，成本未知）'}`);
  const dropRows = Object.entries(s.dropped).sort((a, b) => b[1] - a[1]);
  if (dropRows.length > 0) console.log(`丢弃原因：${dropRows.map(([k, v]) => `${k}×${v}`).join('　')}`);
  if (s.hosts.length > 0) console.log(`来源站点：${s.hosts.slice(0, 6).map(([h, n]) => `${h}×${n}`).join('　')}`);
  if (snapshot.searchFailures.length > 0) console.log(`搜索失败 ${snapshot.searchFailures.length} 条（前 3）：\n  ${snapshot.searchFailures.slice(0, 3).join('\n  ')}`);
  console.log(`\n快照：${path.relative(path.join(HERE, '..', '..', '..'), file)}`);
  console.log(`跑复刻：EVAL_API_KEY=… EVAL_MODEL=… npm run eval:models -- --suite live-replicate --live ${path.relative(process.cwd(), file)}`);

  if (items.length === 0) {
    console.error('\n⚠️ 一道合格题都没采到 —— 先看上面的丢弃原因分布：');
    console.error('   全是 fetch-failed / http-4xx ⇒ 网络或站点反爬；全是 extract-unparsed ⇒ 抽题模型不服从协议；');
    console.error('   全是 needs-media / few-options ⇒ 查询词搜到的页面本身不是题库页，改 datasets/harvest-queries.json。');
    process.exit(1);
  }
}

await main();
