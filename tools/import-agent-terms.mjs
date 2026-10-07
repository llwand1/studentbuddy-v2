#!/usr/bin/env node
/** 零依赖：导入已整理的词条 JSON。密钥只从环境变量读取，重试保持 batchId。 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (!args.includes('--file') || args.includes('--help')) {
  console.log('node tools/import-agent-terms.mjs --file terms.json [--base https://11wand.com] [--dry-run] [--no-review]\n密钥环境变量：STUDENTBUDDY_TERMS_TOKEN\n支持评审台导出的词条数组、{terms:[...]}、手选 t/d/g 数组；不自动导入 termsp 原始候选报告。');
  process.exit(args.includes('--help') ? 0 : 1);
}
try {
  const raw = JSON.parse(fs.readFileSync(value('--file'), 'utf8').replace(/^\uFEFF/, ''));
  const input = Array.isArray(raw) ? raw : raw.terms;
  if (!Array.isArray(input) || !input.length) throw new Error('需要非空词条数组或 {terms:[...]}；原始采集候选请整理后导出。');
  const terms = input.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`第 ${i + 1} 条不是词条对象。`);
    if ('t' in x && !('term' in x)) {
      if (typeof x.t !== 'string' || typeof x.d !== 'string') throw new Error(`第 ${i + 1} 条缺少 t/d。`);
      return { term: x.t, definition: x.d, domain: x.g ?? 'general', sourceNote: '学习者手选；未提供网页来源' };
    }
    return x;
  });
  const review = !args.includes('--no-review');
  const batches = [];
  let chunk = [];
  for (const t of terms) {
    const candidate = [...chunk, t];
    if (chunk.length && (candidate.length > 100 || Buffer.byteLength(JSON.stringify({ review, terms: candidate })) > 512 * 1024 - 256)) {
      batches.push(chunk); chunk = [];
    }
    chunk.push(t);
    if (Buffer.byteLength(JSON.stringify({ review, terms: chunk })) > 512 * 1024 - 256) throw new Error('单条数据已超过请求体限制，请先整理字段。');
  }
  if (chunk.length) batches.push(chunk);
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify({ dryRun: true, validatedByServer: false, terms: terms.length, batches: batches.length, review, examples: terms.slice(0, 3).map(t => t.term) }));
    process.exit(0);
  }
  const token = process.env.STUDENTBUDDY_TERMS_TOKEN;
  if (!token) throw new Error('请在私有环境变量 STUDENTBUDDY_TERMS_TOKEN 中提供专用密钥。');
  const base = new URL(args.includes('--base') ? value('--base') : 'https://11wand.com');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('base 必须为无账号密码的 http(s) 地址。');
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('远程接口请使用 HTTPS。');
  const apiBase = base.href.replace(/\/$/, '') + '/api/open/v1';
  let added = 0, skipped = 0, replayedBatches = 0;
  let at = 0;
  for (const chunk of batches) {
    const batch = { review, terms: chunk };
    const batchId = 'file-' + createHash('sha256').update(JSON.stringify(batch)).digest('hex');
    const body = JSON.stringify({ batchId, ...batch });
    let receipt;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const r = await fetch(apiBase + '/terms/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body, signal: AbortSignal.timeout(15000) });
        const data = await r.json();
        if (!r.ok) {
          if (r.status >= 500 && attempt < 2) continue;
          throw new Error(`HTTP ${r.status}：${data.error ?? '导入失败'}${data.index === undefined ? '' : `，条目下标 ${at + data.index}`}`);
        }
        receipt = data; break;
      } catch (e) { if (e instanceof Error && (e.message.startsWith('HTTP ') || attempt === 2)) throw e; }
    }
    if (!receipt) throw new Error('没有收到导入回执，重跑同一文件会使用相同批次 ID。');
    if (receipt.replayed) replayedBatches += 1;
    else { added += receipt.added; skipped += receipt.skipped; }
    console.log(JSON.stringify(receipt));
    at += chunk.length;
  }
  console.log(JSON.stringify({ completed: true, added, skipped, replayedBatches, note: 'added/skipped 为本次实际处理数，回放批次不会再次写入。' }));
} catch (e) { console.error(e instanceof Error ? e.message : '导入失败'); process.exitCode = 1; }
