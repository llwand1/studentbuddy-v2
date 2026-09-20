/**
 * chat/vision — 「文本模型读图」的视觉蒸馏层（v17）。
 *
 * 架构定位（与 FrameWise 的 vision-as-tool 同构，按本仓契约落地）：
 * 主模型始终是**纯文本**，它不直接收像素。用户上传的图片在这里被发给一个
 * 单独配置的「视觉」角色模型（qwen-vl-plus / gpt-4o / glm-4v 等），蒸馏成
 * 一段中文文字描述，再作为用户消息的一部分塞回纯文本主模型的上下文。
 *
 * 为什么蒸馏而非原生直通：
 * ① 老板原话「studentbuddy 确实只有文本模型」——主模型选型不被看图绑架；
 * ② 视觉是**可插拔的外部能力**：视觉模型挂了/换了/降级了，不影响主 Agent 其它能力；
 * ③ 描述随用户消息持久化，历史回放/重新生成都不再二次调视觉模型，省成本且结论稳定。
 *
 * 提示词套路（踩过 FrameWise 的坑后固化）：把**最关键的图示细节/文字/数值放最前**——
 * 视觉模型撞 max_tokens 时截断是「从后往前吃」，放最后 = 每回先丢最有价值的信息。
 *
 * ★ 三笔限额（张数 / 单张字符数 / body 上限）**已收敛到 `@sb/shared` 的 chat-limits**
 *   （2026-09-20）。此前三处各写一遍、靠注释互相指认，实测已经不平：单张 700 万字符 × 4 张
 *   ≈ 28MB > 24mb body ⇒ 4 张各自合法的图一起发会撞 413，症状是「点发送没反应」。
 *   改限额请去 chat-limits.ts，别在本文件重新写死数字。
 */
import type { ChatMessage, ContentPart, UploadedImage } from '../llm/types.js';
import { routeRole } from '../llm/router.js';
import { MAX_CHAT_IMAGES, MAX_IMAGE_DATAURL_CHARS, maxImageSizeHint } from '@sb/shared';

/**
 * 看图提示词：关键信息前置（详见文件头注释）。覆盖学习场景最常见的读图需求——
 * 公式、代码、图表、表格、界面、标注。多图分别描述。
 */
const VISION_PROMPT =
  '请仔细观察这张图片，用简体中文描述其中与学习相关的内容。优先且详细写出：图中的文字、公式、' +
  '代码、图表数据、表格、界面元素、标注。若含多张图请分别描述。控制在 300 字以内，把最关键的信息放在最前面。';

/**
 * 校验并归一化前端送来的图片（HTTP 边界的脏数据在这里清掉，不让脏值往里走）。
 *
 * 规则（个人本地工具，够用即可，不搞重量级校验）：
 * - 最多 `MAX_CHAT_IMAGES` 张；单张 dataURL ≤ `MAX_IMAGE_DATAURL_CHARS` 字符
 * - 只认 `data:image/` 前缀，其余一律丢弃——不把任意字符串透传给视觉模型
 *
 * @returns `{ ok: true, images }` 或 `{ ok: false, error }`（error 可直接回 400 给用户）
 */
export function parseIncomingImages(raw: unknown): { ok: true; images: UploadedImage[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: true, images: [] };

  const images: UploadedImage[] = [];
  for (const item of raw) {
    const i = item as { dataUrl?: unknown; name?: unknown } | null;
    if (!i || typeof i.dataUrl !== 'string' || !i.dataUrl.startsWith('data:image/')) continue;
    if (i.dataUrl.length > MAX_IMAGE_DATAURL_CHARS) return { ok: false, error: `单张图片过大（上限${maxImageSizeHint()}）` };
    images.push(typeof i.name === 'string' ? { dataUrl: i.dataUrl, name: i.name } : { dataUrl: i.dataUrl });
  }
  // 先过滤再限流：脏值不该占额度（否则夹带垃圾就能把合法图片挤掉，报错还很莫名）
  if (images.length > MAX_CHAT_IMAGES) return { ok: false, error: `一次最多上传 ${MAX_CHAT_IMAGES} 张图片` };
  return { ok: true, images };
}

/**
 * 把一组图片蒸馏成一段文字描述。
 *
 * @returns 视觉模型产出的中文描述（已 trim）；空图返回空串。
 * @throws 清晰可读的错误：未配置视觉模型 / 视觉调用本身失败。调用方（flow.ts）据此
 *         向用户报「请到设置页配置视觉模型」之类真话，而不是笼统的「模型不可用」。
 */
export async function describeImages(
  images: UploadedImage[],
  signal?: AbortSignal,
  ownerId?: string | null,
): Promise<string> {
  if (!images || images.length === 0) return '';

  // ★ M2c：读图也是 LLM 调用 ⇒ 必须知道"这轮是谁在问"（契约 TENANCY-SPEC §8.1.4）
  const target = routeRole('vision', undefined, ownerId);
  if (!target || !target.model) {
    throw new Error(
      '未配置视觉模型：请到设置页「角色模型绑定」为「视觉（看图）」绑定一个支持图片的模型' +
        '（如 qwen-vl-plus / gpt-4o / glm-4v），否则无法读图。',
    );
  }

  const parts: ContentPart[] = [{ type: 'text', text: VISION_PROMPT }];
  for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });

  const messages: ChatMessage[] = [{ role: 'user', content: parts }];

  let desc = '';
  for await (const chunk of target.adapter.chat({
    model: target.model,
    apiKey: target.apiKey,
    baseUrl: target.baseUrl,
    messages,
    signal,
    streamMode: target.streamMode,
    // 视觉理解不开思考链：Anthropic 下 thinking 会强制占 max_tokens 预算且对「看图说话」无益
    thinking: false,
  })) {
    if (chunk.content) desc += chunk.content;
  }
  return desc.trim();
}
