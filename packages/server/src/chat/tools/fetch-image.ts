/**
 * chat/tools/fetch-image —— `fetch_image`（把网页上的图片搬进对话，2026-09-20 新增）。
 *
 * 为什么需要它：正文侧的图片渲染 2026-09-20 已落地（`![alt](url)` → `<img>`，见
 * `packages/web/src/lib/markdown-inline.ts`），但**上游取图的口一直没有**：
 * `fetch_page` 读的是纯文本，它的内容闸门**有意**把 `image/*` 与 PNG/JPEG/GIF 魔数挡在门外
 * （bug-ledger B-011/B-012 那两道闸，是有意为之、不该拆），`search_web` 只回文字片段。
 * ⇒ 模型想在正文里放图，只能自己编地址，编出来就是裂图。本工具补上中间那一环：
 * 「URL → 本地缓存 → 回灌一个能直接渲染的站内地址」。
 *
 * 与 `fetch_page` 的关系：同档（network / 免确认 / 只读语义）、同安全底座（SSRF 逐跳复检），
 * 区别只在**产出物**——那边回文本，这边回图片地址；两者不替代，各自补各自的缺口。
 *
 * ★ 本工具**落盘**，但不是「AI 写盘」：路径由服务端按内容 hash 生成
 *   （`storage/image-cache.ts` 的文件头有完整论证），模型只能给 URL、给不了路径。
 *   故不走申请式确认卡——挂上确认门只会让它变成「用户以为这功能不存在」（老板已定的取舍）。
 */
import { fetchSafe } from '../../search/ssrf-guard.js';
import { combineSignals } from '../../search/index.js';
import { MAX_IMAGE_BYTES, imageUrlOf, saveImage, sniffImage } from '../../storage/image-cache.js';
import { registerTool } from './registry.js';

/**
 * 单次取图超时（毫秒）。比 `fetch_page` 的 15s 略宽：图的传输量通常大于一页 HTML。
 * 仍远短于 `network` 档基线 60s —— 失败要失败得快，档位基线不因此上调（契约 v1.3 拍板⑪）。
 */
const FETCH_TIMEOUT_MS = 20_000;

/** 真实浏览器 UA：不少图床对无 UA 的请求直接 403（与 `fetch_page` / Bing 通道同款理由）。 */
const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * 失败原因外泄口径：安全策略类原因**不逐字透传**（同 `fetch_page.publicReason`）。
 * 把「解析到内网/回环地址」原样回灌，等于把本机的网络拓扑当成模型的探测面。
 * ★ 这是本仓的第二份实现：`fetch_page` 那份是模块私有的，为一个 5 行函数去改刚验收过的
 *   B-011/B-012 批不划算。**建议后续把两份收进 `search/ssrf-guard.ts`**（登记在契约待办）。
 */
function publicReason(err: unknown): string {
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

/**
 * 成功回灌：**必须把用法说死**。
 * 只说「取到了」，模型多半会把地址当普通文本念出来 —— 学习者看到的是一串字符而不是图，
 * 功能等于没做（§N15 的同款教训：能力做完了但要配「怎么用」才算存在）。
 */
function okText(mime: string, size: number, src: string): string {
  const kb = Math.max(1, Math.round(size / 1024));
  return (
    `图片已取到并缓存在本机（${mime}，约 ${kb} KB）：${src}\n\n` +
    '在回答里**用 Markdown 图片语法引用它**，学习者就能直接看到图：\n\n' +
    `![一句话说明这张图](${src})\n\n` +
    '★ 必须写成完整的 `![说明](地址)`（方括号里写一句人话说明）；不要把地址裸写在正文里' +
    '——那样只会显示成一串字符，学习者看不到图。'
  );
}

/** 「不是可搬运的图片」口径：如实说 + 指一条出路 + 不许编造（SVG 单列，见下）。 */
function notImageText(ct: string): string {
  // ★ SVG 单列一句：它是最容易被当成「图片」的格式，不说清楚，用户只会觉得工具坏了。
  //   不搬它的理由见 storage/image-cache.ts（同源直接打开会执行源站脚本）。
  if (ct.includes('svg')) {
    return (
      '这个地址是一张 SVG 矢量图，本工具**刻意不搬运**它（SVG 能内嵌脚本，与本应用同源打开会有风险）。' +
      '可以把原链接直接给学习者，让他在新标签页里自己看。'
    );
  }
  return (
    `这个地址不是本工具能搬运的图片（服务端声明类型：${ct || '未声明'}）。` +
    '常见格式（PNG / JPEG / GIF / WebP / BMP / AVIF）都可以搬，可以换一个图片地址再试；' +
    '但不要因此说这个地址不存在，也不要凭地址编造图里的内容。'
  );
}

/** 超上限口径：给出实际大小与出路，不静默丢弃。 */
function tooLargeText(declaredBytes: number | null): string {
  const mb = MAX_IMAGE_BYTES / 1024 / 1024;
  const size = declaredBytes === null ? '' : `（这张约 ${(declaredBytes / 1024 / 1024).toFixed(1)} MB）`;
  return (
    `这张图超过了 ${mb} MB 的上限${size}，没有搬过来——对话里放这么大的图既没必要，也拖慢回放。` +
    '可以换一张更小的图，或把原链接给学习者让他自己打开看。'
  );
}

registerTool('fetch_image', {
  definition: {
    type: 'function',
    function: {
      name: 'fetch_image',
      // description 是**写给模型的提示词**（同 `search_web` / `fetch_page` 的 B-006 口径）：
      // 正面陈述能力 + 触发场景 + 示例，不写"我无法…"、不甩内部配置、不给放弃台阶。
      description:
        '把网页上的图片搬到回答里，让学习者直接看到图。你**具备**这个能力，可随时调用。' +
        '适用：学习者给了图片的网址、说"看看这张图/把这张图发我/这链接里的图是什么"、' +
        '或你想让他**直接看到**某张图而不是只听文字描述时。' +
        '调用后返回一个图片地址，**你要把它用 Markdown 图片语法写进正文**（`![说明](地址)`）。' +
        '示例：学习者发来图片链接 → 直接调 fetch_image({url:"https://…/x.png"})，' +
        '然后正文里写 ![示意图](/api/images/…png)。' +
        '取不到、不是图片或图太大时如实说明原因，**不要编造图里画的是什么**。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片的完整网址（http/https）' },
        },
        required: ['url'],
      },
    },
  },
  // §4.2 元数据：network 档（60s）+ 同 URL 重放落到**同一内容 hash**、同文件 ⇒ idempotent 成立，
  // 够 §4.3-5「network + idempotent 才重试 1 次」的资格。
  kind: 'network',
  idempotent: true,
  async run(args, ctx) {
    const url = String(args.url ?? '').trim().slice(0, 2000);
    if (!url) {
      ctx.onStep('fetch_image', 'error', '网址为空');
      return { content: '网址为空，请带 url 重新调用 fetch_image。' };
    }
    ctx.onStep('fetch_image', 'running', url);

    let ct = '';
    let declared: number | null = null;
    let bytes: Uint8Array | null;
    try {
      const res = await fetchSafe(url, {
        headers: { 'User-Agent': FETCH_UA, Accept: 'image/*,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: combineSignals(ctx.signal, FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ct = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      // 体积预闸：服务端自报超大就当场拒，省掉把整个响应读进内存（不报也得靠下面的限量读兜）
      const raw = Number(res.headers.get('content-length') ?? '');
      declared = Number.isFinite(raw) && raw > 0 ? raw : null;
      if (declared !== null && declared > MAX_IMAGE_BYTES) {
        ctx.onStep('fetch_image', 'error', '图片过大');
        return { content: tooLargeText(declared) };
      }
      bytes = await readCapped(res, MAX_IMAGE_BYTES);
    } catch (err) {
      const reason = publicReason(err);
      ctx.onStep('fetch_image', 'error', reason);
      // 回灌口径（B-006）：① 不甩内部配置；② 明确「你有这能力，只是这次没取到」；
      // ③ **不给「那就算了」的台阶**，也不许它把"取不到"说成"这张图不存在"。
      return {
        content:
          `这个图片地址本次没取到（${reason}）。你**具备**取图的能力，只是这一次没成功——` +
          `可以换一个地址再试；但不要因此说这张图不存在，也不要凭地址编造它画的是什么。`,
      };
    }

    if (!bytes) {
      ctx.onStep('fetch_image', 'error', '图片过大');
      return { content: tooLargeText(declared) };
    }

    // ★ 判在**原始字节**上（不看 ct）：content-type 会谎报、会缺失、会写成 octet-stream。
    //   同 `fetch_page.looksBinary` 的教训——判据是关于字节的，就该在字节上判。
    const type = sniffImage(bytes);
    if (!type) {
      ctx.onStep('fetch_image', 'error', ct.startsWith('image/') ? `不支持的格式：${ct}` : '非图片');
      return { content: notImageText(ct) };
    }

    const { name } = saveImage(bytes, type.ext);
    const src = imageUrlOf(name);
    ctx.onStep('fetch_image', 'done', `${type.ext.toUpperCase()} ${Math.max(1, Math.round(bytes.length / 1024))}KB`);
    return { content: okText(type.mime, bytes.length, src) };
  },
});
