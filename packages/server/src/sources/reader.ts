/**
 * sources/reader —— 把一张外站网页变成右侧面板可安全展示的「阅读页」（契约 docs/SOURCE-TRACE-SPEC.md §5）。
 *
 * 为什么不直接 iframe 原站：绝大多数站点带 `X-Frame-Options` / `frame-ancestors`，嵌进来就是一片空白
 * （既有演示面板刻意不做地址栏，就是这个原因）。所以服务端把页面**取回、抽正文、白名单清洗**，
 * 再以**零脚本**文档交给面板里的沙箱 iframe。
 *
 * 安全边界（每一条都有理由，别为「显示效果」放松）：
 *  - 取页走 `fetchSafe`（SSRF 守卫逐跳复检）、15s 超时、2MB 上限。
 *  - 清洗是**白名单**：只保留正文语义标签，属性只留 `href/src/alt/colspan/rowspan`，链接与图片只放 http(s)，
 *    其余标签整体剥掉（保留其中文字）；`script/style/iframe/form/svg…` **连内容一起**删。
 *  - 输出文档自带 `<meta name="referrer" content="no-referrer">`，路由再加 CSP `sandbox` + `default-src 'none'`
 *    ——就算清洗漏了什么，沙箱里也没有脚本能跑、没有能发出去的请求（图片除外）。
 *  - 端点只服务**架上有的网址**（路由层用 `liveShelfKnows` / 库表校验），本模块不管许可。
 *
 * 缓存：同一网址 30 分钟内只取一次（学习者在几条资料间来回切）；`primeReaderHtml` 让 fetch_page
 * 已经拿到的 HTML 直接复用——AI 读过的页面，面板打开时不再去拉第二遍。
 */
import { detectSourceKind, siteOf, type SourceKind } from '@sb/shared';
import { fetchSafe } from '../search/ssrf-guard.js';
import { combineSignals } from '../search/combine.js';
import { decodeText } from '../search/decode-text.js';
import { FETCH_UA } from '../media/image-download.js';

export const READER_TIMEOUT_MS = 15_000;
export const READER_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;
const CACHE_MAX = 80;
const HTML_PRIME_MAX = 40;

export interface ReaderDoc {
  title: string;
  site: string;
  /** 清洗后的正文 HTML（不含外壳） */
  body: string;
  /** 正文纯文字长度：太短说明是脚本渲染页，外壳上提示「看原网页」 */
  textLen: number;
  /** 实际内容类型判出来的种类（URL 判 page、实为 pdf 时以此为准） */
  kind: SourceKind;
  byline?: string;
  lead?: string;
}

/** 正文允许的标签（`a`/`img` 的属性另行处理） */
const ALLOWED = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small', 'mark', 'kbd', 'span', 'div',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'figure', 'figcaption', 'a', 'img',
  'dl', 'dt', 'dd', 'section', 'article', 'cite', 'q', 'abbr', 'time',
]);
/** 连内容一起删的标签 */
const DROP_WITH_CONTENT = [
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'frame', 'object', 'embed', 'applet',
  'form', 'button', 'select', 'textarea', 'input', 'canvas', 'video', 'audio', 'picture', 'source', 'nav',
  'header', 'footer', 'aside', 'dialog', 'menu',
];

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const decodeAttr = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function attrOf(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return decodeAttr(m[1] ?? m[2] ?? m[3] ?? '');
}

/** 相对地址按页面地址补全，只放行 http(s)；解析失败 / 其它协议 ⇒ null */
export function absoluteHttpUrl(raw: string | null, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function stripBlocks(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP_WITH_CONTENT) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
    // 自闭合 / 没写闭合标签的（`<input …>`、`<source …>`）：单独剥标签
    out = out.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
  }
  return out;
}

/**
 * 白名单清洗（纯函数、可单测）：先整块剥掉 script/style/iframe/form 等（连内容），
 * 再逐标签过白名单——输出只含 ALLOWED 标签与受控属性，文本里的散 `<` 转义。
 */
export function sanitizeReaderHtml(html: string, base: string): string {
  // 标签正则对引号内的 `>` 免疫（`<img src="data:…,<svg onload=…>">` 这类在属性里藏标签的写法不能把分词带偏）
  const tokens = stripBlocks(html).match(/<\/?[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*>|<![^>]*>|<\?[^>]*>|[^<]+|</g) ?? [];
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok === '<') {
      out.push('&lt;');
      continue;
    }
    if (tok.startsWith('<!') || tok.startsWith('<?')) continue;
    if (!tok.startsWith('<')) {
      out.push(tok);
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)([\s\S]*?)\/?>$/.exec(tok);
    if (!m) continue;
    const closing = m[1] === '/';
    const name = (m[2] ?? '').toLowerCase();
    const attrs = m[3] ?? '';
    if (!ALLOWED.has(name)) continue;
    if (closing) {
      if (name !== 'br' && name !== 'hr' && name !== 'img') out.push(`</${name}>`);
      continue;
    }
    if (name === 'a') {
      const href = absoluteHttpUrl(attrOf(attrs, 'href'), base);
      out.push(href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">` : '<a>');
      continue;
    }
    if (name === 'img') {
      const src = absoluteHttpUrl(attrOf(attrs, 'src') ?? attrOf(attrs, 'data-src') ?? attrOf(attrs, 'data-original'), base);
      if (!src) continue;
      const alt = attrOf(attrs, 'alt') ?? '';
      out.push(`<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer">`);
      continue;
    }
    if (name === 'td' || name === 'th') {
      const span = ['colspan', 'rowspan']
        .map((k) => {
          const v = attrOf(attrs, k);
          return v && /^\d{1,2}$/.test(v) ? ` ${k}="${v}"` : '';
        })
        .join('');
      out.push(`<${name}${span}>`);
      continue;
    }
    out.push(name === 'br' || name === 'hr' ? `<${name}>` : `<${name}>`);
  }
  return out.join('');
}

function metaOf(html: string, key: string): string | null {
  const re = new RegExp(`<meta\\s+[^>]*(?:property|name)\\s*=\\s*["']${key}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  if (!tag) return null;
  const v = attrOf(tag.slice(5, -1), 'content');
  return v ? v.trim() : null;
}

/** 正文区域：`<article>` 够长就用它，其次 `<main>`，再次 `<body>`，最后整页 */
function pickRegion(html: string): string {
  const grab = (tag: string): string | null => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)<\\/${tag}\\s*>`, 'i').exec(html);
    return m?.[1] ?? null;
  };
  const article = grab('article');
  if (article && article.replace(/<[^>]+>/g, '').trim().length > 500) return article;
  return grab('main') ?? grab('body') ?? html;
}

const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** 网页 HTML → 阅读页数据（纯函数，可单测） */
export function extractReader(html: string, url: string): ReaderDoc {
  const clean = stripBlocks(html);
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const title = textOf(metaOf(html, 'og:title') ?? rawTitle).slice(0, 200) || siteOf(url);
  const lead = metaOf(html, 'og:image');
  const author = metaOf(html, 'author') ?? metaOf(html, 'article:author');
  const time = metaOf(html, 'article:published_time') ?? metaOf(html, 'datePublished');
  const byline = [author, time?.slice(0, 10)].filter(Boolean).join(' · ');
  const body = sanitizeReaderHtml(pickRegion(clean), url);
  const leadUrl = absoluteHttpUrl(lead, url);
  return {
    title,
    site: siteOf(url),
    body,
    textLen: textOf(body).length,
    kind: 'page',
    ...(byline ? { byline } : {}),
    ...(leadUrl && !body.includes(`src="${esc(leadUrl)}"`) ? { lead: leadUrl } : {}),
  };
}

/** 阅读页外壳样式：与主界面同一套「夜行」色板（沙箱里拿不到 --sb-* 变量，只能内联一份；色值同 tokens.css） */
const SHELL_CSS = `
:root{color-scheme:dark}
body{margin:0;background:#140d12;color:#ecdfcc;font:15px/1.75 "Segoe UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif}
.src-head{position:sticky;top:0;padding:8px 16px;background:#2a1116;border-bottom:2px solid #4a3240;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.src-head h1{font-size:14px;margin:0;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src-site{font-size:11px;color:#bdafa2;background:#0a070b;padding:2px 8px;border:1px solid #33232c;white-space:nowrap}
.src-open{font-size:12px;color:#ffd27a;text-decoration:none;border:1px solid #8a6a2a;padding:2px 8px;white-space:nowrap}
.src-open:hover{background:#33240f}
.src-note{margin:0;padding:8px 16px;background:#33240f;color:#ffd27a;font-size:13px;border-bottom:1px solid #8a6a2a}
article{max-width:760px;margin:0 auto;padding:18px 20px 60px;overflow-wrap:anywhere}
article img{max-width:100%;max-height:50vh;width:auto;height:auto;object-fit:contain;display:block;margin:12px auto;border:1px solid #33232c}
article pre{background:#0a070b;padding:12px;overflow:auto;border:1px solid #33232c;font-size:13px}
article code{background:#0a070b;padding:1px 4px}
article a{color:#ffd27a}
article blockquote{margin:12px 0;padding:6px 14px;border-left:3px solid #d9434f;color:#bdafa2}
article table{border-collapse:collapse;max-width:100%}
article td,article th{border:1px solid #33232c;padding:4px 8px;font-size:14px}
article h1,article h2,article h3{line-height:1.35;color:#fff3e0}
.src-byline{color:#938379;font-size:13px;margin-bottom:12px}
.src-image{text-align:center;padding:24px}
`;

/** 阅读页完整 HTML 文档（路由层加 CSP；文档本身零脚本） */
export function renderReaderDoc(doc: ReaderDoc, url: string): string {
  const note =
    doc.kind === 'pdf'
      ? '<p class="src-note">这是一份 PDF，阅读模式不展示；请点右上角「原网页」在新标签页打开。</p>'
      : doc.textLen < 200
        ? '<p class="src-note">这页正文主要靠脚本渲染，阅读模式只拿到了这些；完整内容请点「原网页」。</p>'
        : '';
  const lead = doc.lead ? `<img src="${esc(doc.lead)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
  const byline = doc.byline ? `<p class="src-byline">${esc(doc.byline)}</p>` : '';
  return (
    `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(doc.title)}</title>` +
    `<style>${SHELL_CSS}</style></head><body>` +
    `<header class="src-head"><span class="src-site">${esc(doc.site)}</span><h1>${esc(doc.title)}</h1>` +
    `<a class="src-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer">原网页 ↗</a></header>` +
    `${note}<article>${byline}${lead}${doc.body}</article></body></html>`
  );
}

/** 图片类资料：不取页，直接出一张「原图 + 标题」的阅读页 */
export function renderImageDoc(url: string, title: string): string {
  return renderReaderDoc(
    {
      title: title || siteOf(url),
      site: siteOf(url),
      body: `<div class="src-image"><img src="${esc(url)}" alt="${esc(title)}" referrerpolicy="no-referrer"></div>`,
      textLen: 999,
      kind: 'image',
    },
    url,
  );
}

const docCache = new Map<string, { html: string; thin: boolean; at: number }>();
/** 同一网址正在取的那次：面板会同时发「探测」与 iframe 两个请求，不能各拉一遍上游（2026-09-30 截图保底） */
const inflight = new Map<string, Promise<ReaderLoad>>();
const primed = new Map<string, string>();

function cachePut<V>(map: Map<string, V>, key: string, v: V, max: number): void {
  map.delete(key);
  map.set(key, v);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** fetch_page 已经取到的 HTML 交给阅读页复用（AI 读过的页面面板打开时零等待） */
export function primeReaderHtml(url: string, html: string): void {
  cachePut(primed, url, html.slice(0, READER_MAX_BYTES), HTML_PRIME_MAX);
}

/** 测试用：清空缓存 */
export function resetReaderCache(): void {
  structCache.clear();
  docCache.clear();
  primed.clear();
  inflight.clear();
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer()).subarray(0, max);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.length;
    if (total >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, n), off);
    off += n;
    if (off >= out.length) break;
  }
  return out;
}

/** `thin`：正文太短（脚本渲染页），面板据此提供「服务器截图看全」的出口（契约 §13.1） */
export type ReaderLoad = { ok: true; html: string; thin: boolean } | { ok: false; status: number; reason: string };

/** 块模型（§14.1）要的是结构而不是 HTML 字符串；与 `/view` **同一次取页、同一份 TTL**，不多拉上游 */
export type ReaderStruct = { ok: true; doc: ReaderDoc; thin: boolean } | { ok: false; status: number; reason: string };
const structCache = new Map<string, { doc: ReaderDoc; thin: boolean; at: number }>();

export function loadReaderStruct(url: string, title: string, signal?: AbortSignal): Promise<ReaderStruct> {
  const hit = structCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve({ ok: true, doc: hit.doc, thin: hit.thin });
  return loadReaderDoc(url, title, signal).then((r) => {
    if (!r.ok) return r;
    const s = structCache.get(url);
    // 走到这里 html 已经产出，结构必然同时入过缓存；真缺了就如实报，不猜
    return s ? ({ ok: true, doc: s.doc, thin: s.thin } as ReaderStruct) : ({ ok: false, status: 500, reason: '结构缓存缺失' } as ReaderStruct);
  });
}

/**
 * 取一条资料的阅读页 HTML（带缓存 + 同网址并发合流）；失败原因给面板显示，不泄内部细节。
 * 合流时沿用**第一个**调用方的 signal：两个请求来自同一块面板，一起来一起走。
 */
export function loadReaderDoc(url: string, title: string, signal?: AbortSignal): Promise<ReaderLoad> {
  const hit = docCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve({ ok: true, html: hit.html, thin: hit.thin });
  const pending = inflight.get(url);
  if (pending) return pending;
  const p = fetchReaderDoc(url, title, signal).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

async function fetchReaderDoc(url: string, title: string, signal?: AbortSignal): Promise<ReaderLoad> {
  if (detectSourceKind(url) === 'image') {
    const html = renderImageDoc(url, title);
    cachePut(docCache, url, { html, thin: false, at: Date.now() }, CACHE_MAX);
    const imgDoc: ReaderDoc = { title: title || siteOf(url), site: siteOf(url), body: `<img src="${esc(url)}" alt="${esc(title)}">`, textLen: 0, kind: 'page' };
    cachePut(structCache, url, { doc: imgDoc, thin: false, at: Date.now() }, CACHE_MAX);
    return { ok: true, html, thin: false };
  }
  let source = primed.get(url);
  let kind: SourceKind = 'page';
  if (source === undefined) {
    try {
      const res = await fetchSafe(url, {
        headers: { 'User-Agent': FETCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
        signal: combineSignals(signal, READER_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, status: 502, reason: `对方返回 HTTP ${res.status}` };
      const ct = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (ct === 'application/pdf') kind = 'pdf';
      else if (ct && !/^text\/|^application\/(?:xhtml\+xml|xml)/.test(ct)) {
        return { ok: false, status: 415, reason: `不是网页（${ct}）` };
      }
      const bytes = await readCapped(res, READER_MAX_BYTES);
      source = kind === 'pdf' ? '' : decodeText(bytes, ct);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = /abort|timeout/i.test(msg) ? '读取超时' : /SSRF|不允许|blocked|private/i.test(msg) ? '该地址不允许访问' : '网络错误';
      return { ok: false, status: 502, reason };
    }
  }
  const doc = kind === 'pdf' ? { title, site: siteOf(url), body: '', textLen: 999, kind } : extractReader(source, url);
  if (!doc.title || doc.title === doc.site) doc.title = title || doc.title;
  const html = renderReaderDoc(doc, url);
  const thin = doc.kind === 'page' && doc.textLen < 200;
  cachePut(docCache, url, { html, thin, at: Date.now() }, CACHE_MAX);
  cachePut(structCache, url, { doc, thin, at: Date.now() }, CACHE_MAX);
  return { ok: true, html, thin };
}
