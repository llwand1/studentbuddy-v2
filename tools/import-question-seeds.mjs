#!/usr/bin/env node
/** 零依赖导入整理好的预产物；凭证仅取环境变量，重试复用内容批次。 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
const args = process.argv.slice(2);
const arg = flag => args[args.indexOf(flag) + 1];
if (args.includes('--help') || !args.includes('--file')) {
  console.log('node tools/import-question-seeds.mjs --file seeds.json [--base https://11wand.com] [--dry-run]\n支持数组或 {seeds:[...]}。凭证：STUDENTBUDDY_SEEDS_TOKEN，须显式授权出题预产物。');
  process.exit(0);
}
try {
  const input = JSON.parse(fs.readFileSync(arg('--file'), 'utf8'));
  const seeds = Array.isArray(input) ? input : input?.seeds;
  if (!Array.isArray(seeds) || !seeds.length) throw new Error('需要非空预产物数组或 {seeds:[...]}。');
  const batches = []; let chunk = [];
  for (const seed of seeds) {
    if (!seed || typeof seed !== 'object' || Array.isArray(seed) || ['question', 'options', 'answer', 'ownerId', 'code'].some(k => k in seed)) throw new Error('只能上传考点依据/蓝图/参数空间，不能上传成品题、归属或代码。');
    if (chunk.length && (chunk.length >= 50 || Buffer.byteLength(JSON.stringify([...chunk, seed])) > 512 * 1024 - 256)) { batches.push(chunk); chunk = []; }
    chunk.push(seed);
    if (Buffer.byteLength(JSON.stringify(chunk)) > 512 * 1024 - 256) throw new Error('单个预产物超过请求体限制，请先整理字段。');
  }
  if (chunk.length) batches.push(chunk);
  if (args.includes('--dry-run')) { console.log(JSON.stringify({ dryRun: true, validatedByServer: false, seeds: seeds.length, batches: batches.length })); process.exit(0); }
  const token = process.env.STUDENTBUDDY_SEEDS_TOKEN;
  if (!token) throw new Error('请在私有环境变量 STUDENTBUDDY_SEEDS_TOKEN 中提供授权密钥。');
  const base = new URL(args.includes('--base') ? arg('--base') : 'https://11wand.com');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('base 必须是无凭证和查询参数的站点根地址。');
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('远程接口请使用 HTTPS。');
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  const context = await fetch(base.origin + '/api/open/v1/context', { headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!context.ok) throw new Error(`读取授权范围失败：HTTP ${context.status}`);
  const ctx = await context.json();
  if (!ctx.permissions?.includes('question-seeds:write')) throw new Error('此密钥未授权出题预产物，请在设置页勾选后创建新密钥。');
  let added = 0, skipped = 0, replayed = 0, ineligible = 0;
  for (const batch of batches) {
    const batchId = 'seeds-' + createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    const body = JSON.stringify({ batchId, seeds: batch }); let receipt;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(base.origin + '/api/open/v1/question-seeds/import', { method: 'POST', headers, body, signal: AbortSignal.timeout(20000), redirect: 'error' });
        const data = await r.json();
        if (!r.ok) {
          if ((r.status >= 500 || r.status === 429) && attempt < 2) { await pause(1000 * (attempt + 1)); continue; }
          throw new Error(`HTTP ${r.status}：${data.error ?? '导入失败'}${data.index === undefined ? '' : `，批内下标 ${data.index}`}`);
        }
        receipt = data; break;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('HTTP ')) throw error;
        if (attempt === 2) throw new Error('网络未完成导入，请保留原文件重试，批次 ID 会保持不变。');
      }
    }
    if (!receipt) throw new Error('接口未返回回执，请保留原文件重试。');
    added += receipt.added; skipped += receipt.skipped; replayed += Number(receipt.replayed);
    ineligible += receipt.results.filter(r => !r.eligible).length;
  }
  console.log(JSON.stringify({ seeds: seeds.length, added, skipped, replayedBatches: replayed, ineligible, currentScope: ctx.exam.signature, note: '导入不是出题；不可用条目请按接口回执调整范围、来源或期限。' }));
} catch (error) { console.error(error instanceof Error ? error.message : '导入未完成'); process.exitCode = 1; }
