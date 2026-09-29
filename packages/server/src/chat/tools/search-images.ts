/**
 * chat/tools/search-images —— `search_images`：按主题从网上**找**图、看图核验后搬进对话（2026-09-29）。
 *
 * 与 `fetch_image` 的分工：那边是「学习者/模型已经有图片地址 → 搬过来」；这边补的是**找**——
 * 模型手里没有真实图片地址时，过去只能编（裂图）或放弃。流程与口径见 `media/find-image.ts`：
 * Commons 为主、Bing 兜底，视觉模型逐张看图，只收真正对得上主题的，落本地缓存、带署名。
 *
 * ★ 回灌里把 Markdown **整段写好**（图 + 署名行）：模型只需原样放进正文。让它自己拼署名，
 *   它会漏掉许可或把 Bing 的图写成「CC 许可」。
 * ★ 同档：network / 只读语义 / 幂等（同检索词命中缓存 ⇒ 同一文件），与 `fetch_image` 一致。
 */
import { creditLine, findImages } from '../../media/find-image.js';
import { registerTool } from './registry.js';

/** 一次找图最长等多久：候选搜索 10s + 最多两批（下载 15s + 看图 45s）——给足但仍在 network 档内 */
const SEARCH_TIMEOUT_MS = 55_000;

registerTool('search_images', {
  definition: {
    type: 'function',
    function: {
      name: 'search_images',
      description:
        '从网上找真实的图片（照片、示意图、地图、名画、标本……）放进回答，让学习者直接看到。你**具备**这个能力。' +
        '适用：讲到具体的事物、结构、地点、历史文物、艺术作品，一张图胜过一段描述时；学习者说「给我看看/有图吗/长什么样」时。' +
        '每张图都会先经过看图核验，确认真的是这个东西才会返回。' +
        'query 写**具体的名词**（英文检索词命中率更高，例如 "animal mitochondrion diagram"、"Terracotta Army"）；' +
        'subject 用中文写这张图应当展示什么（例如「线粒体的结构」）。' +
        '返回的 Markdown 要**原样**放进正文（图片那行和署名那行都要）。找不到就如实说，不要编造图片地址或图里的内容。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '图片检索词：具体名词，英文优先' },
          subject: { type: 'string', description: '这张图应当展示什么（中文，一句话）' },
          count: { type: 'integer', description: '要几张（1–3，默认 1）' },
        },
        required: ['query'],
      },
    },
  },
  kind: 'network',
  idempotent: true,
  async run(args, ctx) {
    const query = String(args.query ?? '').trim().slice(0, 120);
    const subject = String(args.subject ?? '').trim().slice(0, 120) || query;
    const count = Number.isInteger(args.count) ? Number(args.count) : 1;
    if (!query) {
      ctx.onStep('search_images', 'error', '检索词为空');
      return { content: '检索词为空，请带 query 重新调用 search_images。' };
    }
    ctx.onStep('search_images', 'running', subject);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), SEARCH_TIMEOUT_MS);
    const onAbort = () => ac.abort();
    ctx.signal?.addEventListener('abort', onAbort);
    try {
      const r = await findImages({ query, subject, count, ownerId: ctx.ownerId, signal: ac.signal });
      if (r.images.length === 0) {
        ctx.onStep('search_images', 'error', '没找到对得上的图');
        return {
          content:
            `这次没找到确实是「${subject}」的图（看了 ${r.tried} 张候选，都没通过看图核验${r.rejected.length ? `：${r.rejected.join('；')}` : ''}）。` +
            '可以换一个更具体的检索词（英文名、学名、「… diagram」）再试一次；不要编造图片地址，也不要描述一张你没看到的图。',
        };
      }
      ctx.onStep('search_images', 'done', `${r.images.length} 张${r.cached ? '（缓存）' : ''}`);
      const blocks = r.images.map((img) => `![${img.alt.replace(/[[\]]/g, '')}](${img.src})\n${creditLine(img)}`);
      const unverified = r.images.some((x) => !x.verified);
      return {
        content:
          `找到了 ${r.images.length} 张图。把下面的 Markdown **原样**放进正文合适的位置（图片行 + 署名行都要保留）：\n\n` +
          blocks.join('\n\n') +
          (unverified ? '\n\n★ 这些图**没有经过看图核验**（当前没有可用的视觉模型），正文里要提醒学习者图可能不完全准确。' : '') +
          `\n\n图下面的文字说明要基于图的真实内容：${r.images.map((x) => x.alt).join('；')}。`,
      };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
    }
  },
});
