/**
 * learning/collect-figures — 现场搜集的**原题配图 + 材料**搬运（契约 QUIZ-COMPLETE-SPEC §5）。
 *
 * 搜集管道原本的盲区：`htmlToText` 把 `<img>` 连同标签一起删了，模型只见到文字——
 * 「如图所示」的题图、「材料一」旁边的统计图，全在抓页这一步丢了；而题干仍然通过 verbatim 锁
 * （锁只校题干前 20 字在不在页面里），于是**带着悬空引用的题被当成合格真题放行**。
 *
 * 做法（对齐「服务端填、模型只给编号」）：
 *  ① `markImages`：抓页时把正文里的 `<img>` 换成编号标记 `[图N]`，服务端记 N → {url, alt}；
 *     模型在摘题时只写 `figures:[N]`，**网址不经过模型**；
 *  ② `resolveCandidate`：对每道摘出的题——校验 `material` 逐字出自同一页 → 搬 N 号图
 *     （下载闸门 + 可选看图取替代文字 → 落本站缓存）→ 再用 `assessQuestion` 复审，
 *     仍然悬空的题标 `ok:false` 并说明原因（**不静默放行，也不静默丢**：预览里用户看得到理由）。
 * 版权口径与既有搜集一致：只在用户本地预览/确认后入库，图片只存本机缓存，署名指回原页面。
 */
import type { CollectCompletenessReport, CollectCandidate, QuizQuestion } from '@sb/shared';
import { MAX_QUIZ_MATERIAL_CHARS } from '@sb/shared';
import { downloadImage } from '../media/image-download.js';
import { verifyImage } from '../media/image-verify.js';
import { routeRole } from '../llm/router.js';
import { imageUrlOf, saveImage } from '../storage/image-cache.js';
import { assessQuestion, describeMissing, MATERIAL_MIN_CHARS } from './quiz-completeness.js';

export interface PageFigure {
  /** 全局编号（跨页递增，模型看到的 `[图N]`） */
  n: number;
  url: string;
  alt: string;
}

/** 每页最多标几张：一页题集的有效题图通常个位数，再多多半是装饰图 */
export const MAX_FIGURES_PER_PAGE = 10;
/** 太小的图不是题图（图标、表情、间隔条） */
const MIN_SIDE_PX = 60;
const IMG_TIMEOUT_MS = 10_000;
const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'real_src', 'original'];
/** class / id / alt / 文件名里出现这些词的多半不是题图 */
const DECOR = /(logo|icon|avatar|qrcode|qr[-_]|banner|sprite|loading|placeholder|blank|emoji|button|\bads?\b|advert|footer|header|nav[-_]|weixin|wechat|share)/i;

/** 标记文本：`[图3]` 或 `[图3:alt]`。normText 计算前必须剥掉它（见 `stripMarkers`），否则会破坏 verbatim 锚点 */
const MARKER = /\[图\d+(?::[^\]\n]{0,60})?\]/g;
export const stripMarkers = (text: string): string => text.replace(MARKER, '');

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

/** 相对地址按页面 URL 解析；只认 http(s)（data:/javascript: 等一律丢） */
export function resolveImageUrl(src: string, pageUrl: string): string | null {
  if (!src || /^data:/i.test(src)) return null;
  try {
    const u = new URL(src, pageUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 把 `<img>` 换成 `[图N]` 文本标记。返回替换后的 html（交给 `htmlToText` 照常剥标签）与本页登记的图。
 * 跳过：nav/header/footer/aside 里的图、data URI、svg/gif、过小的图、装饰类命名。
 */
export function markImages(html: string, pageUrl: string, startN: number): { html: string; figures: PageFigure[] } {
  const figures: PageFigure[] = [];
  let n = startN;
  const cleaned = html.replace(/<(nav|footer|aside|header)\b[\s\S]*?<\/\1>/gi, (block) => block.replace(/<img\b[^>]*>/gi, ''));
  const out = cleaned.replace(/<img\b[^>]*>/gi, (tag) => {
    if (figures.length >= MAX_FIGURES_PER_PAGE) return '';
    // 懒加载站点（新浪博客 real_src、各类 data-*）的真图在这些属性里，src 只是占位 gif
    const raw = LAZY_ATTRS.map((a) => attr(tag, a)).find((v) => !!v) || attr(tag, 'src');
    const url = resolveImageUrl(raw, pageUrl);
    if (!url) return '';
    const path = new URL(url).pathname;
    if (/\.(svg|gif)$/i.test(path)) return '';
    const w = Number(attr(tag, 'width').replace(/px$/i, ''));
    const h = Number(attr(tag, 'height').replace(/px$/i, ''));
    if ((w > 0 && w < MIN_SIDE_PX) || (h > 0 && h < MIN_SIDE_PX)) return '';
    const alt = attr(tag, 'alt').replace(/[<>[\]\n]/g, ' ').trim().slice(0, 60);
    if (DECOR.test(`${attr(tag, 'class')} ${attr(tag, 'id')} ${attr(tag, 'name')} ${alt} ${path.split('/').pop() ?? ''}`)) return '';
    n += 1;
    figures.push({ n, url, alt });
    return ` [图${n}${alt ? `:${alt}` : ''}] `;
  });
  return { html: out, figures };
}

/** 逐字覆盖率：material 归一化后按 12 字切块，多少比例的块原样出现在该页正文里 */
export function materialCoverage(material: string, normPage: string, norm: (s: string) => string): number {
  const m = norm(material);
  if (m.length < 8) return 0;
  const chunks: string[] = [];
  for (let i = 0; i < m.length; i += 12) chunks.push(m.slice(i, i + 12));
  const hit = chunks.filter((c) => c.length < 6 || normPage.includes(c)).length;
  return hit / chunks.length;
}
/** 覆盖率门槛：允许少量排版/省略号差异，不允许「概述式改写」——改写过的材料等于编造 */
export const MATERIAL_COVERAGE_MIN = 0.85;

/** 模型写 figures 的样子五花八门：`[1]`、`["1"]`、`["[图1]"]`、`["图1"]`——只认其中的整数 */
export function parseFigureNumbers(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const x of raw) {
    const m = typeof x === 'number' ? [String(x)] : typeof x === 'string' ? x.match(/\d+/) : null;
    const n = m ? Number(m[0]) : NaN;
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** 紧贴题干前面的图标记最多隔多少个字（去空白后）。再远就不猜——配错图比没有图更糟 */
export const ADJACENT_MAX_CHARS = 80;

/**
 * 模型没写 figures、但页面上图紧挨在题干**前面**（题库站常见排版：`[图1] 如图所示的电路…`）时，
 * 取这张图。规则很窄：在去掉空白的页面文本里定位题干前 12 个字，往前看 ADJACENT_MAX_CHARS 个字，
 * 里面**最后一个**图标记且其后不夹别的图标记；定位不到/隔得远/没有 ⇒ null。
 */
export function adjacentFigureBefore(markedText: string, stem: string): number | null {
  const squash = (t: string): string => t.replace(/\s+/g, '');
  const head = squash(stem).replace(/^[\d一二三四五六七八九十]+[.、．)）]/, '').slice(0, 12);
  if (head.length < 6) return null;
  const text = squash(markedText);
  const at = text.indexOf(head);
  if (at < 0) return null;
  const before = text.slice(Math.max(0, at - ADJACENT_MAX_CHARS - 12), at);
  const marks = [...before.matchAll(/\[图(\d+)(?::[^\]]{0,60})?\]/g)];
  const last = marks[marks.length - 1];
  if (!last) return null;
  const gap = before.length - ((last.index ?? 0) + last[0].length);
  return gap <= ADJACENT_MAX_CHARS ? Number(last[1]) : null;
}

export interface FigureDeps {
  download: typeof downloadImage;
  verify: typeof verifyImage;
  save: typeof saveImage;
  visionReady: (ownerId: string | null) => boolean;
}
const defaultDeps: FigureDeps = {
  download: downloadImage,
  verify: verifyImage,
  save: saveImage,
  visionReady: (o) => !!routeRole('vision', undefined, o)?.model,
};

export interface ResolveCtx {
  /** 摘题所在页（服务端重算的命中页）：材料与图都必须来自这一页 */
  page: { url: string; title: string; normText: string; figures: PageFigure[]; /** 带 [图N] 标记的页面文本（可选；给「紧邻题干的图」兜底用） */ text?: string };
  norm: (s: string) => string;
  ownerId: string | null;
  signal?: AbortSignal;
  report: CollectCompletenessReport;
  deps?: Partial<FigureDeps>;
}

/** 搬一张原图：下载 → （有视觉模型时）看图取替代文字 → 落本站缓存。失败返回 null，由调用方记数 */
async function carryFigure(fig: PageFigure, q: QuizQuestion, ctx: ResolveCtx): Promise<QuizQuestion['photo'] | null> {
  const d: FigureDeps = { ...defaultDeps, ...ctx.deps };
  const dl = await d.download(fig.url, { timeoutMs: IMG_TIMEOUT_MS, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  if (!dl.ok) return null;
  // gif 不是题图：题库站的「图片加载失败」占位图、加载动画都是 gif（评测里真抓到过一张 360×360 的占位图被当成食物网图）
  if (dl.ext === 'gif') return null;
  // 看图只为取替代文字：题图与「题干」的关系不是「图展示主题」，不拿 match 卡它（人在预览里确认）
  let alt = fig.alt || '原题配图';
  if (d.visionReady(ctx.ownerId)) {
    const v = await d
      .verify({ bytes: dl.bytes, mime: dl.mime, subject: q.question.slice(0, 60), ownerId: ctx.ownerId, ...(ctx.signal ? { signal: ctx.signal } : {}) })
      .catch(() => null);
    if (v?.verdict === 'checked' && v.result.depicts) alt = v.result.depicts.slice(0, 120);
  }
  const { name } = d.save(dl.bytes, dl.ext);
  let host = '原页面';
  try {
    host = new URL(ctx.page.url).host;
  } catch {
    /* 保持默认 */
  }
  return { src: imageUrlOf(name), alt, credit: `图源：${host}（原题页面配图）`, pageUrl: ctx.page.url, essential: true };
}

/**
 * 对一道已过 verbatim 锁的摘录题做自包含处置。返回带 material/photo 的题 + 可能的拒因。
 * ★ material 必须与页面原文逐字对得上（覆盖率门槛）；对不上就**去掉 material**（不带编造内容入库），
 *   之后若题仍依赖它 ⇒ `ok:false`。
 */
export async function resolveCandidate(
  raw: QuizQuestion & { figures?: unknown },
  ctx: ResolveCtx,
): Promise<CollectCandidate> {
  const { figures: rawFigs, material: rawMaterial, ...base } = raw;
  let q: QuizQuestion = base;
  const notes: string[] = [];

  // ① 材料：模型给的 material 必须逐字出自同一页
  const mat = typeof rawMaterial === 'string' ? rawMaterial.trim().slice(0, MAX_QUIZ_MATERIAL_CHARS) : '';
  if (mat.length >= MATERIAL_MIN_CHARS) {
    if (materialCoverage(mat, ctx.page.normText, ctx.norm) >= MATERIAL_COVERAGE_MIN) {
      q = { ...q, material: mat };
      ctx.report.withMaterial += 1;
    } else notes.push('所给材料未在页面原文逐字命中，已丢弃');
  }

  // ② 原图：只认同一页登记过的编号；一题一图（取第一张）
  let nums = parseFigureNumbers(rawFigs);
  // 兜底：模型漏写 figures，但这题确实依赖图、且页面上图紧挨在题干前面 ⇒ 用那张
  if (nums.length === 0 && ctx.page.text && assessQuestion(q).missing.some((m) => m.kind === 'figure')) {
    const adj = adjacentFigureBefore(ctx.page.text, q.question);
    if (adj !== null) nums = [adj];
  }
  const fig = nums.map((n) => ctx.page.figures.find((f) => f.n === n)).find((f) => !!f);
  if (nums.length > 0 && !fig) notes.push('所给图编号不属于该页');
  if (fig) {
    const photo = await carryFigure(fig, q, ctx).catch(() => null);
    if (photo) {
      q = { ...q, photo };
      ctx.report.figuresAttached += 1;
    } else {
      ctx.report.figuresFailed += 1;
      notes.push('原图下载失败');
    }
  }

  // ③ 复审：仍然悬空的，明说拒因（用户在预览里能看到）
  const a = assessQuestion(q);
  if (!a.complete) {
    ctx.report.rejectedIncomplete += 1;
    const why = `题干依赖${describeMissing(a.missing)}，但没能从页面取到${notes.length ? `（${notes.join('；')}）` : ''}`;
    return { question: q, ok: false, reason: why };
  }
  return { question: q, ok: true };
}
