/**
 * tools/eval/runners/vision — 看图核验（`image.verify`）套件的运行侧（口径见 `media/vision-eval-metrics.ts`，文档 `docs/eval/vision.md`）。
 *
 * 走产品自己的 `verifyImage`；图从数据集里的 Commons 地址下载一次后缓存到 `reports/vision-cache/`，
 * 重跑不重复下载（Commons 有限流，也让多次评测看的是同一批像素）。录制件落盘后 `--replay` 零额度重算。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadImage } from '../../../packages/server/src/media/image-download.js';
import { verifyImage, type ImageMatch } from '../../../packages/server/src/media/image-verify.js';
import { summarizeVision, type VisionEvalRecord, type VisionEvalSummary } from '../../../packages/server/src/media/vision-eval-metrics.js';
import { sniffImage } from '../../../packages/server/src/storage/image-cache.js';
import { bootEvalEnv } from '../lib/env.mts';

interface VisionCase {
  id: string;
  image: { url: string; pageUrl: string; license: string | null };
  subject: string;
  expect: ImageMatch[];
  quiz?: { question: string; answers: string[] };
  expectLeak?: boolean;
}

export interface VisionRun {
  dataset: string;
  model: string;
  file: string;
  records: (VisionEvalRecord & { depicts?: string; error?: string })[];
  summary: VisionEvalSummary;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadImage(url: string, cacheDir: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const f = path.join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 24));
  if (fs.existsSync(f)) {
    const bytes = new Uint8Array(fs.readFileSync(f));
    const t = sniffImage(bytes);
    return t ? { bytes, mime: t.mime } : null;
  }
  const d = await downloadImage(url, { timeoutMs: 20_000 });
  if (!d.ok) return null;
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(f, d.bytes);
  return { bytes: d.bytes, mime: d.mime };
}

export async function runVisionSuite(opts: { dataset: string; limit: number; throttleMs: number; retry: number; reportsDir: string }): Promise<VisionRun> {
  const ds = JSON.parse(fs.readFileSync(opts.dataset, 'utf8')) as { version: string; cases: VisionCase[] };
  const cases = opts.limit > 0 ? ds.cases.slice(0, opts.limit) : ds.cases;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const env = await bootEvalEnv({ rawDir: path.join(opts.reportsDir, 'raw', stamp), role: 'vision' });
  const records: VisionRun['records'] = [];
  try {
    for (const [i, c] of cases.entries()) {
      const rec: VisionRun['records'][number] = { id: c.id, expect: c.expect, got: null, latencyMs: 0, ...(c.expectLeak !== undefined ? { expectLeak: c.expectLeak, gotLeak: null } : {}) };
      const img = await loadImage(c.image.url, path.join(opts.reportsDir, 'vision-cache'));
      if (!img) rec.error = '图片下载失败';
      for (let attempt = 0; img && attempt <= opts.retry; attempt += 1) {
        const t0 = Date.now();
        const out = await verifyImage({ bytes: img.bytes, mime: img.mime, subject: c.subject, ...(c.quiz ? { quiz: c.quiz } : {}), ownerId: 'sb-eval' });
        if (out.verdict === 'checked') {
          rec.got = out.result.match;
          rec.latencyMs = Date.now() - t0;
          rec.depicts = out.result.depicts;
          if (c.expectLeak !== undefined) rec.gotLeak = out.leak;
          delete rec.error;
          break;
        }
        rec.error = out.reason;
        if (attempt < opts.retry) await sleep(/\b429\b/.test(out.reason) ? 15_000 * (attempt + 1) : 2_000);
      }
      records.push(rec);
      const bad = rec.got === null ? '  ✗失败' : !c.expect.includes(rec.got) ? '  ←不一致' : '';
      const leak = c.expectLeak !== undefined ? ` 泄露 期望=${c.expectLeak} 判=${rec.gotLeak}` : '';
      console.log(`[${i + 1}/${cases.length}] ${c.id}「${c.subject}」期望=${c.expect.join('/')} 判=${rec.got ?? '—'} ${(rec.latencyMs / 1000).toFixed(1)}s${leak}${bad}`);
      if (i < cases.length - 1) await sleep(opts.throttleMs);
    }
  } finally {
    await env.close();
  }
  fs.mkdirSync(opts.reportsDir, { recursive: true });
  const file = path.join(opts.reportsDir, `vision-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ dataset: ds.version, model: env.model, records }, null, 2), 'utf8');
  return { dataset: ds.version, model: env.model, file, records, summary: summarizeVision(records) };
}

export function replayVision(file: string): VisionRun {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { dataset: string; model: string; records: VisionRun['records'] };
  return { ...raw, file, summary: summarizeVision(raw.records) };
}
