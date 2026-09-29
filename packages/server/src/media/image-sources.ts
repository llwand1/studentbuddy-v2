/**
 * media/image-sources — 按关键词找**候选**图片（只找地址与出处，不下载；下载与核验见 find-image.ts）。
 *
 * 两个来源，按可靠度排：
 * ① **Wikimedia Commons**（主）：官方 API、免 key、稳定；图的许可证/作者/来源页随结果给出（`extmetadata`），
 *    教学图（示意图、标本照、地图、历史照片）覆盖好。SVG 也能用：请求 `iiurlwidth` 拿到服务端栅格化的 PNG 缩略图，
 *    既避开 SVG 内嵌脚本的风险（`storage/image-cache.ts` 不收 SVG），也省流量。
 * ② **Bing 图片**（兜底）：免 key 的 `images/async` 片段接口，覆盖面最广（中文检索词、时事、产品图）；
 *    ★ 许可证未知 ⇒ `license: null`，前端如实显示「来源：某站，版权归原作者」，不假装可自由使用。
 *    ★ 接口形状是非公开的 HTML 片段（每个结果一个 `m="{json}"` 属性），可能哪天就变；解析失败只返回空数组，
 *      不抛错——兜底通道坏了，主通道照常工作。
 * ★ 全部经 `fetchSafe`（SSRF 逐跳复检），超时独立；返回的 URL 之后还要过 `downloadImage` 的同一套闸门。
 */
import { fetchSafe } from '../search/ssrf-guard.js';
import { combineSignals } from '../search/index.js';
import { FETCH_UA } from './image-download.js';

export interface ImageCandidate {
  /** 可直接下载的图片地址（Commons 为缩略图） */
  url: string;
  /** 图片所在页面（给学习者点开看出处） */
  pageUrl: string;
  title: string;
  source: 'commons' | 'bing';
  /** 许可证短名（CC BY-SA 4.0 / Public domain…）；未知 ⇒ null */
  license: string | null;
  author: string | null;
}

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
/** Wikimedia API 规范要求带可识别的 UA（带联系方式），否则可能被限流 */
const COMMONS_UA = 'StudentBuddy/2.0 (https://github.com/llwand1/studentbuddy-v2) image-search';
const SEARCH_TIMEOUT_MS = 10_000;
const THUMB_WIDTH = 800;

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

interface CommonsPage {
  title?: string;
  index?: number;
  imageinfo?: Array<{
    url?: string;
    thumburl?: string;
    descriptionurl?: string;
    mime?: string;
    extmetadata?: Record<string, { value?: string } | undefined>;
  }>;
}

/** 解析 Commons API 响应（导出给测试：不必联网就能锁住字段映射） */
export function parseCommons(json: unknown): ImageCandidate[] {
  const pages = (json as { query?: { pages?: Record<string, CommonsPage> } })?.query?.pages;
  if (!pages) return [];
  return Object.values(pages)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((p): ImageCandidate[] => {
      const ii = p.imageinfo?.[0];
      const url = ii?.thumburl || ii?.url;
      if (!ii || !url || !/^image\//.test(ii.mime ?? '')) return [];
      const meta = ii.extmetadata ?? {};
      const author = meta.Artist?.value ? stripTags(meta.Artist.value).slice(0, 80) : null;
      return [
        {
          url,
          pageUrl: ii.descriptionurl ?? '',
          title: (p.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
          source: 'commons',
          license: meta.LicenseShortName?.value ? stripTags(meta.LicenseShortName.value) : null,
          author: author || null,
        },
      ];
    });
}

export async function searchCommons(query: string, limit = 6, signal?: AbortSignal): Promise<ImageCandidate[]> {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrnamespace: '6', // File: 命名空间
    gsrsearch: `${query} filetype:bitmap|drawing`,
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata',
    iiurlwidth: String(THUMB_WIDTH),
    iiextmetadatafilter: 'LicenseShortName|Artist',
  });
  try {
    const res = await fetchSafe(`${COMMONS_API}?${params}`, {
      headers: { 'User-Agent': COMMONS_UA, Accept: 'application/json' },
      signal: combineSignals(signal, SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return parseCommons(await res.json());
  } catch {
    return [];
  }
}

const decodeEntities = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");

/** 解析 Bing `images/async` 片段（导出给测试） */
export function parseBingImages(html: string, limit = 6): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  for (const m of html.matchAll(/\bm="(\{[^"]+\})"/g)) {
    try {
      const o = JSON.parse(decodeEntities(m[1] ?? '')) as { murl?: string; purl?: string; t?: string };
      if (!o.murl || !/^https?:\/\//.test(o.murl)) continue;
      out.push({ url: o.murl, pageUrl: o.purl ?? '', title: stripTags(o.t ?? '').slice(0, 120), source: 'bing', license: null, author: null });
    } catch {
      /* 单条坏掉跳过 */
    }
    if (out.length >= limit) break;
  }
  return out;
}

export async function searchBingImages(query: string, limit = 6, signal?: AbortSignal): Promise<ImageCandidate[]> {
  // adlt=strict：安全搜索强制开（学习产品，面向学生）
  const url = `https://www.bing.com/images/async?q=${encodeURIComponent(query)}&first=0&count=${limit * 2}&mmasync=1&adlt=strict`;
  try {
    const res = await fetchSafe(url, {
      headers: { 'User-Agent': FETCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' },
      signal: combineSignals(signal, SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    return parseBingImages(await res.text(), limit);
  } catch {
    return [];
  }
}
