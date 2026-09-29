/**
 * media/image-download — 「URL → 校验过的图片字节」唯一实现（`fetch_image` 与 `search_images` / 出题配图共用）。
 *
 * 2026-09-29 自 `chat/tools/fetch-image.ts` 抽出（逻辑逐字不变）：找图流程要对多张候选图做同样的
 * SSRF 逐跳复检、体积预闸、限量流式读、魔数判型——两份实现迟早漂移（本仓 `publicReason` 双写就是前车）。
 */
import { fetchSafe } from '../search/ssrf-guard.js';
import { combineSignals } from '../search/index.js';
import { MAX_IMAGE_BYTES, sniffImage } from '../storage/image-cache.js';

/** 真实浏览器 UA：不少图床对无 UA 的请求直接 403（与 `fetch_page` / Bing 通道同款理由）。 */
export const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * 失败原因外泄口径：安全策略类原因**不逐字透传**（同 `fetch_page.publicReason`）。
 * 把「解析到内网/回环地址」原样回灌，等于把本机的网络拓扑当成模型的探测面。
 * ★ 这是本仓的第二份实现：`fetch_page` 那份是模块私有的，为一个 5 行函数去改刚验证过的
 *   实现不划算。**建议后续把两份收进 `search/ssrf-guard.ts`**（登记在契约待办）。
 */
export function publicReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('SSRF') || msg.includes('非法 URL') || msg.includes('仅允许 http')) {
    return '该地址不被允许访问';
  }
  return msg;
}

/**
 * 限量读响应体：**流式累积，超限当场掐断**。
 *
 * 为什么不用 `res.arrayBuffer()`（`fetch_page` 用的是它）：那边的正文上限是「读完再截断」、
 * 截的是字符；这边 4MB 是**硬上限**，而服务器不给 `content-length`（或谎报成小值）时，
 * 一次 arrayBuffer 会把整个响应读进内存 —— 一个 2GB 的「图片」足以把服务打死。
 * 这里的上限**边读边判**，超了立刻 `cancel()`。
 */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const body = res.body;
  if (!body) {
    // 无流（少数运行时 / 测试桩）：整读后判长。走到这里的超大响应已被 content-length 预闸挡下。
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.byteLength > max ? null : whole;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export type DownloadResult =
  | { ok: true; bytes: Uint8Array; ext: string; mime: string }
  | { ok: false; kind: 'error'; reason: string }
  | { ok: false; kind: 'too_large'; declared: number | null }
  | { ok: false; kind: 'not_image'; contentType: string };

export async function downloadImage(url: string, opts: { signal?: AbortSignal; timeoutMs: number; maxBytes?: number }): Promise<DownloadResult> {
  const max = opts.maxBytes ?? MAX_IMAGE_BYTES;
  let ct = '';
  let declared: number | null = null;
  let bytes: Uint8Array | null;
  try {
    const res = await fetchSafe(url, {
      headers: { 'User-Agent': FETCH_UA, Accept: 'image/*,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: combineSignals(opts.signal, opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ct = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    // 体积预闸：服务端自报超大就当场拒，省掉把整个响应读进内存（不报也得靠下面的限量读兜）
    const raw = Number(res.headers.get('content-length') ?? '');
    declared = Number.isFinite(raw) && raw > 0 ? raw : null;
    if (declared !== null && declared > max) return { ok: false, kind: 'too_large', declared };
    bytes = await readCapped(res, max);
  } catch (err) {
    return { ok: false, kind: 'error', reason: publicReason(err) };
  }
  if (!bytes) return { ok: false, kind: 'too_large', declared };
  // ★ 判在**原始字节**上（不看 ct）：content-type 会谎报、会缺失、会写成 octet-stream。
  const type = sniffImage(bytes);
  if (!type) return { ok: false, kind: 'not_image', contentType: ct };
  return { ok: true, bytes, ext: type.ext, mime: type.mime };
}
