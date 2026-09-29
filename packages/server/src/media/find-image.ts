/**
 * media/find-image — 「给我一张 X 的图」的完整流程（对话工具 `search_images` 与出题配图共用）。
 *
 *   缓存 → 候选（Commons 为主，不足 2 张再补 Bing）→ 逐张下载（同 `fetch_image` 的闸门）→ 视觉模型看图
 *   → 通过的落本地缓存 + 记出处 → 返回站内地址与署名。
 *
 * ★ 看图结论只收 `yes`：`partial`（主题只是背景、是更大的场景）对学习者是误导，宁可少一张图。
 *   离线评测（`docs/eval/vision.md`）证明这一步值得：真实搜索里「富士山」会搜出以飞机为主体的照片。
 * ★ 没配视觉模型时：对话（`requireVerified=false`）用第一张能下载的图，但标 `verified:false`，
 *   由工具回灌让模型说明「未经看图核验」；出题（`requireVerified=true`）不配图——题上的错图比没图更糟。
 * ★ 时延：每张候选约 4s（下载 + 一次视觉调用，评测 p50）。按 2 张一批并行，最多看 `MAX_TRIES` 张，
 *   绝大多数情况第一批就够。命中缓存 0 次视觉调用。
 */
import { getDb } from '../storage/db.js';
import { imageUrlOf, imagePath, saveImage } from '../storage/image-cache.js';
import fs from 'node:fs';
import { downloadImage } from './image-download.js';
import { searchBingImages, searchCommons, type ImageCandidate } from './image-sources.js';
import { verifyImage } from './image-verify.js';

export interface FoundImage {
  /** 站内地址（`/api/images/<hash>.<ext>`） */
  src: string;
  /** 替代文本：看图得到的一句话描述，没看过图就用标题 */
  alt: string;
  source: 'commons' | 'bing';
  pageUrl: string;
  license: string | null;
  author: string | null;
  verified: boolean;
}

export interface FindImageOptions {
  /** 检索词（模型给的，可中可英） */
  query: string;
  /** 图要展示的主题（给看图用；缺省＝检索词） */
  subject?: string;
  count?: number;
  /** 出题配图：要求看过图，并检查不泄露答案 */
  quiz?: { question: string; answers: string[] };
  requireVerified?: boolean;
  ownerId: string | null;
  signal?: AbortSignal;
  /** 注入点（测试） */
  deps?: Partial<FindImageDeps>;
}

export interface FindImageDeps {
  commons: typeof searchCommons;
  bing: typeof searchBingImages;
  download: typeof downloadImage;
  verify: typeof verifyImage;
}

const MAX_TRIES = 4;
const BATCH = 2;
const CACHE_DAYS = 30;
const DOWNLOAD_TIMEOUT_MS = 15_000;

const cacheKey = (query: string, subject: string) => `${query.trim().toLowerCase()}|${subject.trim().toLowerCase()}`.slice(0, 300);

function readAttribution(name: string): FoundImage | null {
  const row = getDb()
    .prepare('SELECT source, page_url, license, author, title, depicts, verified FROM media_attribution WHERE name = ?')
    .get(name) as { source: 'commons' | 'bing'; page_url: string; license: string | null; author: string | null; title: string; depicts: string; verified: number } | undefined;
  if (!row || !imagePath(name) || !fs.existsSync(imagePath(name)!)) return null;
  return {
    src: imageUrlOf(name), alt: row.depicts || row.title, source: row.source, pageUrl: row.page_url,
    license: row.license, author: row.author, verified: row.verified === 1,
  };
}

function fromCache(key: string): FoundImage[] | null {
  const row = getDb()
    .prepare(`SELECT names FROM image_query_cache WHERE key = ? AND created_at >= datetime('now', ?)`)
    .get(key, `-${CACHE_DAYS} days`) as { names: string } | undefined;
  if (!row) return null;
  const imgs = (JSON.parse(row.names) as string[]).map(readAttribution).filter((x): x is FoundImage => x !== null);
  return imgs.length > 0 ? imgs : null;
}

function remember(name: string, c: ImageCandidate, depicts: string, verified: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO media_attribution (name, source, page_url, license, author, title, depicts, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET depicts = CASE WHEN excluded.verified = 1 THEN excluded.depicts ELSE media_attribution.depicts END,
         verified = MAX(media_attribution.verified, excluded.verified)`,
    )
    .run(name, c.source, c.pageUrl, c.license, c.author, c.title, depicts, verified ? 1 : 0);
}

type Tried = { ok: true; image: FoundImage } | { ok: false; why: string };

async function tryOne(c: ImageCandidate, subject: string, opts: FindImageOptions, d: FindImageDeps): Promise<Tried> {
  const dl = await d.download(c.url, { timeoutMs: DOWNLOAD_TIMEOUT_MS, ...(opts.signal ? { signal: opts.signal } : {}) });
  if (!dl.ok) return { ok: false, why: dl.kind };
  const v = await d.verify({ bytes: dl.bytes, mime: dl.mime, subject, ownerId: opts.ownerId, ...(opts.quiz ? { quiz: opts.quiz } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
  let verified = false;
  let depicts = '';
  if (v.verdict === 'checked') {
    if (v.result.match !== 'yes') return { ok: false, why: `看图：${v.result.match}（${v.result.depicts.slice(0, 40)}）` };
    if (v.leak) return { ok: false, why: '看图：会泄露答案' };
    verified = true;
    depicts = v.result.depicts;
  } else if (opts.requireVerified) {
    return { ok: false, why: `未核验：${v.reason}` };
  }
  const { name } = saveImage(dl.bytes, dl.ext);
  remember(name, c, depicts, verified);
  return { ok: true, image: readAttribution(name) ?? { src: imageUrlOf(name), alt: depicts || c.title, source: c.source, pageUrl: c.pageUrl, license: c.license, author: c.author, verified } };
}

export interface FindImageResult {
  images: FoundImage[];
  /** 看了几张候选（缓存命中为 0） */
  tried: number;
  cached: boolean;
  /** 被拒的原因（调试/回灌用，最多 4 条） */
  rejected: string[];
}

export async function findImages(opts: FindImageOptions): Promise<FindImageResult> {
  const d: FindImageDeps = { commons: searchCommons, bing: searchBingImages, download: downloadImage, verify: verifyImage, ...opts.deps };
  const subject = (opts.subject || opts.query).trim();
  const count = Math.min(Math.max(opts.count ?? 1, 1), 3);
  // 出题配图不走缓存：泄露检查依赖具体题目，同一张图对这道题安全不代表对下一道题安全
  const key = opts.quiz ? null : cacheKey(opts.query, subject);
  const hit = key ? fromCache(key) : null;
  if (hit) return { images: hit.slice(0, count), tried: 0, cached: true, rejected: [] };

  let cands = await d.commons(opts.query, 6, opts.signal);
  if (cands.length < 2) cands = [...cands, ...(await d.bing(opts.query, 6, opts.signal))];
  const seen = new Set<string>();
  cands = cands.filter((c) => !seen.has(c.url) && seen.add(c.url));

  const images: FoundImage[] = [];
  const rejected: string[] = [];
  let tried = 0;
  for (let i = 0; i < cands.length && tried < MAX_TRIES && images.length < count; i += BATCH) {
    const batch = cands.slice(i, i + Math.min(BATCH, MAX_TRIES - tried));
    tried += batch.length;
    const outs = await Promise.all(batch.map((c) => tryOne(c, subject, opts, d).catch((e: unknown) => ({ ok: false as const, why: String(e) }))));
    for (const o of outs) {
      if (o.ok && images.length < count && !images.some((x) => x.src === o.image.src)) images.push(o.image);
      else if (!o.ok && rejected.length < 4) rejected.push(o.why);
    }
  }
  if (key && images.length > 0 && images.every((x) => x.verified)) {
    getDb()
      .prepare(`INSERT OR REPLACE INTO image_query_cache (key, names, created_at) VALUES (?, ?, datetime('now'))`)
      .run(key, JSON.stringify(images.map((x) => x.src.split('/').pop())));
  }
  return { images, tried, cached: false, rejected };
}

/** 署名一行（Markdown）：来源、作者、许可、出处链接；Bing 来源许可未知就照实说 */
export function creditLine(img: FoundImage): string {
  const src = img.source === 'commons' ? 'Wikimedia Commons' : (() => {
    try {
      return new URL(img.pageUrl).hostname.replace(/^www\./, '');
    } catch {
      return '网络';
    }
  })();
  const parts = [`图源：${src}`];
  if (img.author) parts.push(img.author);
  parts.push(img.license ?? '版权归原作者');
  const link = img.pageUrl ? ` · [出处](${img.pageUrl})` : '';
  const flag = img.verified ? '' : ' · 未经看图核验';
  return `*${parts.join(' · ')}${link}${flag}*`;
}

