/**
 * chat/tools/pick-sources —— `pick_sources`（AI 精选资料，2026-09-30 资料溯源，契约 docs/SOURCE-TRACE-SPEC.md §4.3）。
 *
 * 搜索结果一出来右侧就有东西看了（自动上架），但十来条里哪几条**值得学习者自己点开**只有模型知道
 * ——它读过正文、知道哪条是官方文档、哪条是讲得最清楚的视频。本工具让它挑 1–3 条并写一句为什么，
 * 面板给这几条打星、排最前。
 *
 * 只能挑**本轮架上有的**网址（搜到的或读过的）：不在架上的原样退回，让模型别凭记忆编地址。
 * 本地即时、无副作用（改的是内存里的架子）⇒ `read` 档、免确认。没有架子（非学习助手路径）时如实说明。
 */
import { SOURCE_PICK_MAX } from '@sb/shared';
import { registerTool } from './registry.js';

registerTool('pick_sources', {
  definition: {
    type: 'function',
    function: {
      name: 'pick_sources',
      description:
        '把本轮联网找到的资料里**最值得学习者亲自看的 1–3 条**标为精选，显示在右侧资料架最前面（带你写的一句理由）。' +
        '调用时机：search_web / fetch_page 之后、写正文之前——学习者在等你写答案的时候就能先看这几条。' +
        '挑选标准：官方文档 / 权威百科 / 讲得清楚的图文或视频优先；只能挑本轮搜索结果或读过的网址，不要凭记忆写地址。' +
        '正文引用资料时用与搜索结果一致的方括号编号，如 [1]、[3]（学习者点编号就能在右侧打开那条）。',
      parameters: {
        type: 'object',
        properties: {
          picks: {
            type: 'array',
            description: `精选清单，1–${SOURCE_PICK_MAX} 条`,
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', description: '本轮搜索结果或读过的网址（原样复制）' },
                why: { type: 'string', description: '一句话：为什么值得看（20 字内，讲人话）' },
              },
              required: ['url', 'why'],
            },
          },
        },
        required: ['picks'],
      },
    },
  },
  kind: 'read',
  idempotent: true,
  async run(args, ctx) {
    const raw = Array.isArray(args.picks) ? (args.picks as unknown[]) : [];
    const picks = raw
      .map((p) => (p && typeof p === 'object' ? (p as { url?: unknown; why?: unknown }) : {}))
      .filter((p) => typeof p.url === 'string' && p.url.trim())
      .map((p) => ({ url: String(p.url).trim().slice(0, 2000), why: typeof p.why === 'string' ? p.why.trim() : '' }));
    if (picks.length === 0) {
      ctx.onStep('pick_sources', 'error', '没有可精选的网址');
      return { content: 'picks 为空或格式不对：请传 [{url, why}]，url 必须是本轮搜索结果或读过的网址。' };
    }
    if (!ctx.sources) {
      ctx.onStep('pick_sources', 'error', '本轮没有资料架');
      return { content: '本轮没有资料架（不是联网学习对话），精选未生效；直接在正文里给出链接即可。' };
    }
    const { picked, unknown } = ctx.sources.pick(picks);
    const listed = picked.map((s) => `[${s.n}] ${s.title}（${s.site}）`).join('；');
    ctx.onStep('pick_sources', picked.length > 0 ? 'done' : 'error', picked.length > 0 ? `精选 ${picked.length} 条` : '都不在架上');
    return {
      content:
        (picked.length > 0 ? `已在右侧资料架标出精选：${listed}。正文里引用请用这些编号。` : '没有一条生效。') +
        (unknown.length > 0 ? `\n以下网址不在本轮资料架上（没搜到也没读过），已忽略：${unknown.join('、')}` : ''),
    };
  },
});
