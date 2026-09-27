/**
 * chat/tools/generate-image —— `generate_image`（文生图，2026-09-27 v0.2.139 新建）。
 *
 * 契约 `docs/IMAGE-GEN-SPEC.md` §3。与 `fetch_image` 的分工：那边搬**已存在的**第三方图
 * （URL → 缓存 → 站内地址），这边让模型**凭空造一张**学习示意图（prompt → 生图端点 →
 * 同一个 image-cache → 同一个站内地址）。产出物落点完全一致（`saveImage` + `/api/images/:name`），
 * 所以正文渲染、历史回放、名字闸门全是既有链路，本工具只补「造图」这一环。
 *
 * ★ `idempotent: false` 是**钱的声明**，不是偷懒：每次调用都是真金白银出一张新图
 * （同 prompt 重画也是新图），network 档「同参重放」的免费重试资格**必须**被它挡住——
 * 声明成 true，上游 504 后调度器自动重试一次，用户一觉醒来额度少两张。
 *
 * ★ 平台张数闸在本工具的落点是**上游调用之前**（`generateImageForOwner` 内部）：
 * 到顶的请求不发起上游调用，钱一分不花、文案照常回灌（SPEC §5「先查再打」）。
 */
import { IMAGE_PROMPT_MAX_CHARS, generateImageForOwner } from '../../llm/image-gen.js';
import { IMAGE_TOOL_NAME } from '../../llm/image-quota.js';
import { registerTool } from './registry.js';

/** prompt 预览截断（onStep 上屏用，全量 prompt 只进上游不进事件流）。 */
function preview(prompt: string): string {
  return prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt;
}

/** 成功回灌：与 `fetch_image.okText` 同构——「只说取到了」模型多半把地址当文本念出来。 */
function okText(url: string, ext: string, kb: number): string {
  return (
    `图已生成并缓存（${ext.toUpperCase()}，约 ${kb} KB）：${url}\n\n` +
    '在回答里**用 Markdown 图片语法引用它**，学习者就能直接看到图：\n\n' +
    `![一句话说明这张图](${url})\n\n` +
    '★ 必须写成完整的 `![说明](地址)`（方括号里写一句人话说明）；不要把地址裸写在正文里。'
  );
}

/** 失败回灌：B-006 口径——不甩内部配置名、明确「你有这能力只是这次没成」、不许编造图的内容。 */
function failText(message: string): string {
  return (
    `${message}\n\n` +
    '你**具备**生图能力，只是这一次没有成功——可以按上面的原因处理后重试；' +
    '不要编造「图已经画好了」，也不要凭想象描述一张没有生成出来的图。'
  );
}

registerTool(IMAGE_TOOL_NAME, {
  definition: {
    type: 'function',
    function: {
      name: IMAGE_TOOL_NAME,
      // description 是**写给模型的提示词**（B-006 口径，同 search_web / fetch_image）：
      // 正面陈述能力 + 触发场景 + 「地址必须写进正文」的强制 + 失败不许编造。
      description:
        '生成一张学习用的示意图，让学习者直接看到图。你**具备**这个能力，可随时调用。' +
        '适用：概念示意、结构/流程/原理图解、学习者说"画个图/画给我看/示意图"，' +
        '或你判断一张图比一段文字讲得更清楚时。' +
        'prompt 要具体（画什么、怎么摆、标什么字）；调用后返回一个图片地址，' +
        '**你要把它用 Markdown 图片语法写进正文**（`![说明](地址)`）。' +
        '示例：讲细胞结构时 → 调 generate_image({prompt:"动物细胞剖面结构示意图，标注细胞核、线粒体、细胞膜"})，' +
        '然后正文里写 ![细胞结构示意图](/api/images/…png)。' +
        '生成要等几秒钟；额度用完或失败时如实说明原因，**不要编造图里画的是什么**。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画什么，越具体越好（主体、布局、要标注的文字）' },
          size: {
            type: 'string',
            enum: ['1024x1024', '1024x1792', '1792x1024'],
            description: '可选，图的尺寸；不传用方形',
          },
        },
        required: ['prompt'],
      },
    },
  },
  kind: 'network',
  idempotent: false, // ★ 每次调用真金白银出新图，不进「同参重放免费重试」（见文件头）
  async run(args, ctx) {
    const raw = String(args.prompt ?? '').trim();
    if (!raw) {
      ctx.onStep(IMAGE_TOOL_NAME, 'error', '提示词为空');
      return { content: 'prompt 为空，请想清楚要画什么再调一次 generate_image。' };
    }
    const prompt = raw.slice(0, IMAGE_PROMPT_MAX_CHARS);
    ctx.onStep(IMAGE_TOOL_NAME, 'running', preview(prompt));

    // size 原样透传：白名单回落是适配器的事（normalizeImageSize 在 image-gen 里），
    // 这里不预判——两处各判一份迟早判出两个结果。
    const result = await generateImageForOwner(ctx.ownerId, prompt, args.size, ctx.signal);
    if (!result.ok) {
      ctx.onStep(IMAGE_TOOL_NAME, 'error', result.message.slice(0, 120));
      return { content: failText(result.message) };
    }
    const kb = Math.max(1, Math.round(result.image.bytes / 1024));
    ctx.onStep(IMAGE_TOOL_NAME, 'done', `${result.image.ext.toUpperCase()} ${kb}KB`);
    return { content: okText(result.image.url, result.image.ext, kb) };
  },
});
