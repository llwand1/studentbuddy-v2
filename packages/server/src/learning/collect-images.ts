/**
 * learning/collect-images — 真题**题源配图搬运**（契约 `docs/QUIZ-TIER-SPEC.md` §5）。
 *
 * 真题页上带图的题（几何图、电路图、函数图像、材料题的图表）以前一律丢图：抓页时 `htmlToText` 把
 * `<img>` 全剥了，摘录模型看不到图，用户拿到的是「如图所示……」却没有图。这一层做三件事：
 *   ① 抓页时从**原始 HTML** 里把 `<img>` 列成编号清单（绝对 URL、alt、去掉图标/头像/追踪像素），随正文一起喂模型；
 *   ② 摘录协议多一个 `image` 字段：模型只填**编号**（同 `refs` 纪律：网址只由服务端按编号翻译，模型写网址一律作废）；
 *   ③ 服务端按编号取真实 URL → 走既有 `downloadImage`（SSRF 逐跳复检 / 体积上限 / 魔数判型）→ `saveImage` 落站内缓存
 *      → 填 `question.photo`，署名写明「题源页配图 · 页面标题」并带回原页链接。
 *
 * 三条纪律：
 *   · **失败只是没图**：抓不到 / 太大 / 不是图 / 超时，都只记 reason，题照收——图是附加物，判分不读它。
 *   · **不做看图核验**：题源页的图就是这道题自己的图，不存在「搜错图」；答案泄露风险由 ③ 的取图范围控制——
 *     只收模型标为**题干配图**的那一张，解析区的图不进清单（`image` 字段语义写明「题干里的图」）。
 *   · **限量**：每页最多 12 张进清单，每题最多 1 张，每次搜集最多下载 4 张——真题页常带几十个装饰图，不为它们花请求。
 */
import type { QuizQuestion } from '@sb/shared';
import { downloadImage } from '../media/image-download.js';
import { imageUrlOf, saveImage } from '../storage/image-cache.js';

export interface PageImage {
  /** 1 基编号（页内） */
  n: number;
  url: string;
  alt: string;
}

const MAX_IMAGES_PER_PAGE = 12;
const MAX_DOWNLOADS_PER_COLLECT = 4;
const DOWNLOAD_TIMEOUT_MS = 12_000;
/** 一眼就是装饰/追踪/头像的图：按 URL 与尺寸属性过滤，不下载就能排除 */
const JUNK_URL_RE = /(logo|icon|avatar|banner|sprite|pixel|tracker|beacon|\.gif(\?|$)|qrcode|wx_|weixin|share|(?:^|[/_.-])ads?[_/.-])/i;

/**
 * 从原始 HTML 抽 `<img>`：解析 `src` / `data-src`（懒加载页把真图放 data-src）、`alt`、`width`/`height`，
 * 相对路径按页面 URL 补全，data: 与非 http(s) 丢弃，≤ 48px 的丢弃（图标）。
 */
export function extractPageImages(html: string, pageUrl: string): PageImage[] {
  const out: PageImage[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    const attr = (name: string): string => {
      const r = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
      return (r?.[2] ?? r?.[3] ?? r?.[4] ?? '').trim();
    };
    const raw = attr('data-original') || attr('data-src') || attr('src');
    if (!raw || raw.startsWith('data:')) continue;
    let abs = '';
    try {
      abs = new URL(raw, pageUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs) || seen.has(abs) || JUNK_URL_RE.test(abs)) continue;
    const w = Number(attr('width')), h = Number(attr('height'));
    if ((Number.isFinite(w) && w > 0 && w <= 48) || (Number.isFinite(h) && h > 0 && h <= 48)) continue;
    seen.add(abs);
    out.push({ n: out.length + 1, url: abs, alt: attr('alt').replace(/\s+/g, ' ').slice(0, 80) });
    if (out.length >= MAX_IMAGES_PER_PAGE) break;
  }
  return out;
}

/** 进提示词的配图清单段（挂在该页正文之后）；没图返回空串 */
export function buildImagesBlock(images: PageImage[]): string {
  if (images.length === 0) return '';
  const lines = images.map((im) => `  [图${im.n}] ${im.alt || '(无说明)'} ${im.url}`);
  return `\n本页题干配图清单（题干里「如图」指的图若在其中，把编号填进该题的 image 字段；不确定就填 0）：\n${lines.join('\n')}`;
}

/** 摘录协议里 `image` 字段的说明行（并进 COLLECT_PROTOCOL 的规则区） */
export const IMAGE_FIELD_RULE =
  '- image 填该题**题干**所引用配图在「本页题干配图清单」里的编号（整数，从 1 起）；题干没有配图、或图属于答案/解析区、或拿不准，填 0。**只填编号，不要填网址**（系统按编号取图，网址一律作废）。';

/**
 * 模型给的编号 → 真实图 URL（越界 / 非整数 / 0 ⇒ null）。**只认清单里的 URL**，模型写网址一律作废。
 */
export function resolveImageRef(ref: unknown, images: PageImage[]): PageImage | null {
  const n = typeof ref === 'number' ? ref : Number(ref);
  if (!Number.isInteger(n) || n < 1 || n > images.length) return null;
  return images[n - 1] ?? null;
}

export interface AttachSourceImagesResult {
  attached: number;
  /** 逐张失败原因（进 CollectReport.failed，不静默） */
  failed: string[];
}

/**
 * 为一批已通过 verbatim 锁的候选题下载并挂上题源配图。`pending[i].image` 是已解析的清单项。
 * 顺序执行、总量封顶（同一题源页上并发打 4 个请求容易触发反爬），任何失败只记原因。
 */
export async function attachSourceImages(
  pending: Array<{ question: QuizQuestion; image: PageImage; pageTitle: string; pageUrl: string }>,
  opts: { signal?: AbortSignal; download?: typeof downloadImage } = {},
): Promise<AttachSourceImagesResult> {
  const dl = opts.download ?? downloadImage;
  const out: AttachSourceImagesResult = { attached: 0, failed: [] };
  for (const p of pending.slice(0, MAX_DOWNLOADS_PER_COLLECT)) {
    const r = await dl(p.image.url, { timeoutMs: DOWNLOAD_TIMEOUT_MS, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!r.ok) {
      out.failed.push(`题源配图 ${p.image.url.slice(0, 80)}: ${r.kind === 'error' ? r.reason : r.kind}`);
      continue;
    }
    const { name } = saveImage(r.bytes, r.ext);
    p.question.photo = {
      src: imageUrlOf(name),
      alt: p.image.alt || '题源页配图',
      credit: `题源页配图 · ${p.pageTitle}（版权归原作者）`,
      pageUrl: p.pageUrl,
    };
    out.attached += 1;
  }
  return out;
}
