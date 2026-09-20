/**
 * image-intake — 待发送图片的「收编判定」（纯函数，node 环境可单测）。
 *
 * 为什么单独成文件：`ChatComposer.tsx` 贴 300 行门禁；且按本仓测试方案 §7 的约定，
 * 判定逻辑放可测纯函数里，组件只排版、不判。
 *
 * ★ 限额一律从 `@sb/shared` 的 chat-limits 取，**前端不重写数字**。
 *   前端与后端各写一套数字，必然出现「前端放行、后端 400」或「前端拦下、后端其实收得下」
 *   这类错位——而它的症状（点了发送没反应）正是最难定位的那种。
 */

import { MAX_CHAT_IMAGES, MAX_IMAGE_DATAURL_CHARS, maxImageSizeHint } from '@sb/shared';

export type IntakeVerdict = 'accept' | 'too-large' | 'full';

/**
 * 一张图读完后（FileReader.onload 拿到 dataURL 时）要不要收。
 *
 * 为什么判在「读完之后」而不是选文件时：文件大小要读出来才知道，`File.size` 是原图字节数、
 * 而限额是 base64 后的字符数（膨胀 4/3），拿 `size` 预判会两头都错。
 */
export function judgeLoadedImage(dataUrl: string, currentCount: number): IntakeVerdict {
  if (dataUrl.length > MAX_IMAGE_DATAURL_CHARS) return 'too-large';
  if (currentCount >= MAX_CHAT_IMAGES) return 'full';
  return 'accept';
}

/**
 * 还剩几个名额。★ 必须把「读取中」的张数算进来：`attachments` 是本次渲染的快照，
 * 同一 tick 内连续两次粘贴/选图都会读到旧值，只按它算的话上限会被突破
 * （服务端 `chat/vision.ts` 与 body 限额是同一套账，越线的症状是「点发送没反应」）。
 */
export function remainingSlots(currentCount: number, inflight: number): number {
  return Math.max(0, MAX_CHAT_IMAGES - currentCount - inflight);
}

/**
 * 被拒图片给用户的一句话说明。
 * **不静默丢弃**：用户以为选上了却不见图，比明确报错更糟（本仓 ADR-5 不静默）。
 */
export function intakeRejectHint(reason: Exclude<IntakeVerdict, 'accept'>, count: number): string {
  if (reason === 'too-large') return `已跳过 ${count} 张过大的图片（单张上限${maxImageSizeHint()}）`;
  return `一次最多 ${MAX_CHAT_IMAGES} 张图片，多出的已跳过`;
}
