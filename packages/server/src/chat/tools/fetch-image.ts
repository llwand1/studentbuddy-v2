/**
 * chat/tools/fetch-image —— `fetch_image`（把网页上的图片搬进对话，2026-09-20 新增）。
 *
 * 为什么需要它：正文侧的图片渲染 2026-09-20 已落地（`![alt](url)` → `<img>`，见
 * `packages/web/src/lib/markdown-inline.ts`），但**上游取图的口一直没有**：
 * `fetch_page` 读的是纯文本，它的内容闸门**有意**把 `image/*` 与 PNG/JPEG/GIF 魔数挡在门外
 * （那两道闸是有意为之、不该拆），`search_web` 只回文字片段。
 * ⇒ 模型想在正文里放图，只能自己编地址，编出来就是裂图。本工具补上中间那一环：
 * 「URL → 本地缓存 → 回灌一个能直接渲染的站内地址」。
 *
 * 与 `fetch_page` 的关系：同档（network / 免确认 / 只读语义）、同安全底座（SSRF 逐跳复检），
 * 区别只在**产出物**——那边回文本，这边回图片地址；两者不替代，各自补各自的缺口。
 *
 * ★ 本工具**落盘**，但不是「AI 写盘」：路径由服务端按内容 hash 生成
 *   （`storage/image-cache.ts` 的文件头有完整论证），模型只能给 URL、给不了路径。
 *   故不走申请式确认卡——挂上确认门只会让它变成「用户以为这功能不存在」（这是刻意的取舍）。
 */
import { MAX_IMAGE_BYTES, imageUrlOf, saveImage } from '../../storage/image-cache.js';
import { downloadImage } from '../../media/image-download.js';
import { registerTool } from './registry.js';

/**
 * 单次取图超时（毫秒）。比 `fetch_page` 的 15s 略宽：图的传输量通常大于一页 HTML。
 * 仍远短于 `network` 档基线 60s —— 失败要失败得快，档位基线不因此上调。
 */
const FETCH_TIMEOUT_MS = 20_000;

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
      // description 是**写给模型的提示词**（同 `search_web` / `fetch_page` 的口径）：
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

    const r = await downloadImage(url, { signal: ctx.signal, timeoutMs: FETCH_TIMEOUT_MS });
    if (!r.ok && r.kind === 'error') {
      ctx.onStep('fetch_image', 'error', r.reason);
      // 回灌口径：① 不甩内部配置；② 明确「你有这能力，只是这次没取到」；
      // ③ **不给「那就算了」的台阶**，也不许它把"取不到"说成"这张图不存在"。
      return {
        content:
          `这个图片地址本次没取到（${r.reason}）。你**具备**取图的能力，只是这一次没成功——` +
          `可以换一个地址再试；但不要因此说这张图不存在，也不要凭地址编造它画的是什么。`,
      };
    }
    if (!r.ok && r.kind === 'too_large') {
      ctx.onStep('fetch_image', 'error', '图片过大');
      return { content: tooLargeText(r.declared) };
    }
    if (!r.ok) {
      const ct = r.contentType;
      ctx.onStep('fetch_image', 'error', ct.startsWith('image/') ? `不支持的格式：${ct}` : '非图片');
      return { content: notImageText(ct) };
    }
    const bytes = r.bytes;
    const type = { ext: r.ext, mime: r.mime };
    const { name } = saveImage(bytes, type.ext);
    const src = imageUrlOf(name);
    ctx.onStep('fetch_image', 'done', `${type.ext.toUpperCase()} ${Math.max(1, Math.round(bytes.length / 1024))}KB`);
    return { content: okText(type.mime, bytes.length, src) };
  },
});
