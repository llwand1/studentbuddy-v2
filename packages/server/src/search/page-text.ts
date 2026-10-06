/**
 * search/page-text —— 「一个网址 → 干净正文」的**唯一实现**（2026-10-02 抽出）。
 *
 * 为什么要抽：`chat/tools/fetch-page.ts` 里那三道闸（内容类型白名单 / 二进制嗅探 / 编码层）
 * 是 2026-09-20 真机实测一条条打出来的（PDF 冒充正文、GBK 页满屏替换符、低控制占比的
 * 假 html）。网页资料（`learning/doc-url.ts`，DOC-RAG-SPEC §10）要做的事与它**逐字同形**：
 * 取一个网址、拿回能进模型上下文的文本。
 *
 * 复制一份过去就会有**两套真相源**——下次再实测出第四道闸，补了这边漏那边，而漏的那边
 * 恰恰是用户亲手指定的网址（比模型自己搜来的更该严）。所以抽成共用件：
 * 闸门与失败口径在这里**只写一遍**，调用方只负责把结果翻译成自己那套文案。
 *
 * 本件只管「取到文本」，不管回灌措辞——给模型看的话术留在工具侧，给人看的话术留在路由侧。
 */
import { fetchSafe } from './ssrf-guard.js';
import { combineSignals } from './combine.js';
import { htmlToText } from './bing-channel.js';
import { decodeText } from './decode-text.js';

/** 单页抓取超时：与 `fetch_page` 原值一致（抓单页 15s 足够，失败也要失败得快） */
export const PAGE_FETCH_TIMEOUT_MS = 15_000;

/** 真实浏览器 UA：不少站点对无 UA 的请求直接 403（与 Bing 通道同款理由） */
const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * 闸①：可读内容类型白名单（前缀匹配）。不在列内一律视为「不是网页」。
 * `text/*` 全收；`application/*` 只收文本型 XML/JSON 族——`application/pdf`、`image/png`、
 * `application/octet-stream` 必须挡在门外。
 */
const TEXTUAL_CT = /^(?:text\/|application\/(?:xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml|x-ndjson))/i;

/**
 * 闸②：二进制嗅探（兜底层）。在**原始字节**上判，与编码无关。
 *
 * ★ 为什么必须在字节上判、且必须在解码之前（2026-09-20 实测，三条）：
 *   ① **编码层会洗掉字节级特征**：GB18030 下 `89 50` 被吃成一个汉字 ⇒ 字符串层的 PNG 魔数
 *      整个消失；JPEG 的 `FF D8 FF E0` 同样被吃成两个汉字。
 *   ② 旧实现的 PNG 魔数分支**从未命中过**（正则写成 `\uFFFD PNG` 带一个空格，而真 PNG 按
 *      UTF-8 解出来无空格），一直靠控制字符占比兜着。
 *   ③ 存在字符串层**完全漏放**的形态（PNG 签名 + 高字节：UTF-8 控制占比 0.78%、GB18030 1.47%，
 *      两者都 ≤ 2% 且魔数不命中 ⇒ 漏放；字节层魔数命中 ⇒ 拦下）。
 *   ⇒ 判断标准是关于字节的，就该在字节上判。
 */
function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1000);
  if (head.length === 0) return false;
  const has = (...sig: number[]): boolean => sig.every((b, i) => head[i] === b);
  if (has(0x25, 0x50, 0x44, 0x46, 0x2d)) return true; // %PDF-
  if (has(0x89, 0x50, 0x4e, 0x47)) return true; // PNG
  if (has(0x47, 0x49, 0x46, 0x38)) return true; // GIF8
  if (has(0xff, 0xd8, 0xff)) return true; // JPEG
  if (has(0x50, 0x4b, 0x03, 0x04)) return true; // ZIP（docx/xlsx 同族）
  if (has(0x1f, 0x8b)) return true; // GZIP
  let ctrl = 0;
  for (const b of head) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) ctrl++;
  return ctrl / head.length > 0.02;
}

/**
 * 失败原因外泄口径：安全策略类原因**不逐字透传**。
 * 把「解析到内网/回环地址」原样交给上层（再由上层写进模型上下文或接口响应），
 * 等于把本机的网络拓扑变成探测面。
 */
export function publicReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('SSRF') || msg.includes('非法 URL') || msg.includes('仅允许 http')) {
    return '该地址不被允许访问';
  }
  return msg;
}

export interface PageText {
  ok: true;
  /** 原始 HTML（调用方可据此 prime 阅读页缓存，避免二次取页） */
  html: string;
  /** 剥完标签的正文纯文本（未截断——截多少是调用方的策略） */
  text: string;
  /** `<title>` 剥标签后的前 120 字；取不到为空串 */
  title: string;
}

/**
 * 失败三态，**刻意分开**（三条独立根因，合并了就没法分别给话术）：
 * · `fetch`    —— 没取回来（HTTP 非 2xx、超时、SSRF 拦截）。`reason` 已过 `publicReason`。
 * · `not_page` —— 取回来了但不是网页（类型不对 / 疑似二进制）。`what` 给人与模型看，`detail` 给日志。
 * · `empty`    —— 是网页但剥不出正文（纯脚本渲染页 / 空白页）。标题照常带出来：
 *                 资料溯源要用它补架上那条的名字，「打开了但没正文」也是读过。
 */
export type PageTextFail =
  | { ok: false; kind: 'fetch'; reason: string }
  | { ok: false; kind: 'not_page'; what: string; detail: string }
  | { ok: false; kind: 'empty'; title: string };

/** `<title>` 抽取：剥标签 + 压空白，取前 120 字（与资料溯源的 `SOURCE_TITLE_MAX` 同口径） */
export function pageTitleOf(html: string): string {
  return htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').slice(0, 120);
}

/**
 * 取一个网址的正文。**一切失败都以返回值表达，不抛出**（ADR-4）。
 *
 * 三道闸的顺序即防线，别调换：① content-type 白名单（主，省掉把整个 PDF 读进内存）；
 * ② 二进制嗅探（兜底，判在原始字节上、解码之前）；③ 编码层 `decodeText`（按声明或嗅探的
 * 编码解码，**不用 `res.text()`**——它恒按 UTF-8 解、忽略 charset，GBK 页会满屏替换符）。
 * ①② 管「这不是文本」、③ 管「文本用错编码解」——两条独立根因，别合并。
 */
export async function fetchPageText(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; allowHosts?: readonly string[] } = {},
): Promise<PageText | PageTextFail> {
  let bytes: Uint8Array;
  let ct = '';
  try {
    const res = await fetchSafe(url, {
      headers: { 'User-Agent': FETCH_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: combineSignals(opts.signal, opts.timeoutMs ?? PAGE_FETCH_TIMEOUT_MS),
    }, 4, opts.allowHosts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ct = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (ct && !TEXTUAL_CT.test(ct)) {
      return { ok: false, kind: 'not_page', what: `内容类型 ${ct}`, detail: ct };
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    return { ok: false, kind: 'fetch', reason: publicReason(err) };
  }

  if (looksBinary(bytes)) {
    return { ok: false, kind: 'not_page', what: '疑似二进制文件', detail: '疑似二进制' };
  }

  const html = decodeText(bytes, ct);
  const text = htmlToText(html);
  const title = pageTitleOf(html);
  if (!text) return { ok: false, kind: 'empty', title };
  return { ok: true, html, text, title };
}
