/**
 * sources — 「资料溯源」的共享契约（docs/SOURCE-TRACE-SPEC.md §3）。
 *
 * AI 联网回答时，它搜到 / 读过 / 精选的资料在右侧「资料架」实时上屏，学习者等回复的时候就能
 * 顺便看 AI 在看什么；回答里的 `[n]` 引用可点，直接在右侧打开第 n 条。
 *
 * 三条口径（服务端 shelf、前端面板、引用芯片三处共用，别各写一份）：
 *  - **编号是全轮唯一的**：第一次搜索占 [1..k]，第二次接着 [k+1..]，读到架上没有的网址补下一号。
 *    模型看到的搜索结果编号 = 架上编号 = 正文引用编号，三者一致引用才能点得回去。
 *  - **来源分三档**（`origin`）：`search` 搜到、`read` AI 真读过（fetch_page）、`pick` AI 精选（pick_sources 带一句为什么）。
 *    上架顺序不改编号，但面板**排序**按精选 → 读过 → 搜到，各档内按编号。
 *  - **类型按网址判**（`detectSourceKind`）：视频站 / PDF / 图片 / 网页——面板据此决定用阅读页、官方播放器、
 *    PDF 转发还是原图展示。判不准只影响展示方式，不影响能不能打开。
 */

export type SourceKind = 'page' | 'video' | 'pdf' | 'image';
export type SourceOrigin = 'search' | 'read' | 'pick';

export interface SourceItem {
  /** 全轮唯一编号，从 1 起；也是正文 `[n]` 引用的 n */
  n: number;
  url: string;
  title: string;
  /** 站点名（host 去 www.），面板标签用 */
  site: string;
  kind: SourceKind;
  origin: SourceOrigin;
  /** 搜索摘要（`search` 档来自结果 snippet；可空） */
  snippet?: string;
  /** AI 精选的理由（只有 `pick` 档有） */
  why?: string;
  /** 这条是哪次搜索带来的（搜索词），面板悬浮提示用 */
  query?: string;
}

/** 一个资料架最多挂几条（再多学习者也翻不过来；超出的搜索结果不上架但编号照占） */
export const SOURCE_SHELF_MAX = 12;
/** 一次 pick_sources 最多精选几条 */
export const SOURCE_PICK_MAX = 3;
/** 单次搜索上架前几条（Bing 一页 10 条全上太吵） */
export const SOURCE_PER_SEARCH = 5;
/** 标题 / 理由 / 摘要的长度上限（面板一行放得下；也是落库列的软上限） */
export const SOURCE_TITLE_MAX = 120;
export const SOURCE_WHY_MAX = 140;
export const SOURCE_SNIPPET_MAX = 200;

/** 视频站识别（官方播放器嵌入用）：YouTube / B 站。其余视频站按网页处理。 */
const YT_ID = /^[\w-]{6,20}$/;
const BV_ID = /^BV[\w]{8,12}$/i;

/** 官方播放器地址；不是可嵌视频 ⇒ null。只认这两家（各自明文允许被嵌，且不带 cookie 变体）。 */
export function videoEmbedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const id = u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : (u.searchParams.get('v') ?? u.pathname.match(/^\/shorts\/([\w-]+)/)?.[1] ?? '');
    return YT_ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1);
    return YT_ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === 'bilibili.com' || host === 'b23.tv') {
    const bv = u.pathname.match(/\/video\/(BV[\w]+)/i)?.[1] ?? '';
    return BV_ID.test(bv) ? `https://player.bilibili.com/player.html?bvid=${bv}&autoplay=0&high_quality=1` : null;
  }
  return null;
}

/** 按网址判类型（只看 URL，不发请求；服务端出阅读页时会再按 content-type 校正） */
export function detectSourceKind(url: string): SourceKind {
  if (videoEmbedUrl(url)) return 'video';
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 'page';
  }
  if (path.endsWith('.pdf')) return 'pdf';
  if (/\.(?:png|jpe?g|gif|webp|svg|avif)$/.test(path)) return 'image';
  return 'page';
}

/** 站点名：host 去 `www.`；解析不了就原样截短 */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

/** 只放行 http(s)；其余（javascript:/data:/file:）一律不上架 */
export function isShelvableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 面板排序：精选 → 读过 → 搜到；同档按编号（纯函数，不改入参） */
export function orderSources(items: readonly SourceItem[]): SourceItem[] {
  const rank: Record<SourceOrigin, number> = { pick: 0, read: 1, search: 2 };
  return [...items].sort((a, b) => rank[a.origin] - rank[b.origin] || a.n - b.n);
}

/** 正文 `[n]` 引用能点回去的前提：架上确有第 n 条 */
export function sourceByN(items: readonly SourceItem[], n: number): SourceItem | undefined {
  return items.find((s) => s.n === n);
}

/** 资料架 SSE 载荷（走 `block` 帧，`payload.kind === 'sources'`；整表下发、前端整表替换） */
export interface SourcesBlockPayload {
  kind: 'sources';
  sessionId: string;
  items: SourceItem[];
  /** AI 此刻正在读哪一条（fetch_page 进行中），面板给它打「在读」标 */
  readingN?: number;
}

/** 历史读取：某会话里每条回答挂的资料（`GET /api/sources/session/:id`） */
export interface SessionSourcesResult {
  byMessage: Record<string, SourceItem[]>;
}
