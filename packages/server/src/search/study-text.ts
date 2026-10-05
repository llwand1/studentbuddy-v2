/** 保留题目、答案、代码段的块边界；普通标题和摘要仍使用原 htmlToText。 */
import { htmlToText } from './bing-channel.js';

export function studyTextOf(html: string): string {
  const marked = html.replace(/<\/?(?:p|div|li|ol|ul|h[1-6]|pre|blockquote|table|tr|br)\b[^>]*>/gi, '\uE000');
  return htmlToText(marked).replace(/\s*\uE000\s*/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
