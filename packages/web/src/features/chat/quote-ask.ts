/**
 * quote-ask —— 「引用追问」的纯函数层：选中回答里的一句，变成输入框里的引用块。
 *
 * 学习对话最常见的追问是「这句没懂」，此前只能手抄或整段复制再粘贴。
 * 这里只负责两件事：把选区文本整理成 Markdown 引用块（`> ` 前缀、去空行、限长），
 * 以及把引用块并进输入框已有内容（保留用户已打的字、留出提问位）。
 * 选区侦测与浮动按钮在 `QuoteAsk.tsx`。
 */

/** 引用块上限（字符）：太长的引用把提问淹掉，也没必要——引用是「指哪句」，不是转述全文 */
export const QUOTE_MAX_CHARS = 300;

/** 选区文本 → 引用块：逐行 trim、丢空行、行内连续空白折成一个空格，超长截断加省略号 */
export function buildQuote(raw: string, max: number = QUOTE_MAX_CHARS): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  let text = lines.join('\n');
  if (text.length > max) text = `${text.slice(0, max).trimEnd()}…`;
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

/**
 * 并进输入框：空框 ⇒ 引用块 + 空行（光标落在提问位）；
 * 已有内容 ⇒ 接在其后（中间空一行），用户打了一半的问题不被覆盖。
 */
export function mergeQuoteIntoInput(input: string, quote: string): string {
  if (!quote) return input;
  const head = input.replace(/\s+$/, '');
  return head ? `${head}\n\n${quote}\n\n` : `${quote}\n\n`;
}

/** 选区是否值得当引用：至少两个非空白字符（单字符多半是误触） */
export function isQuotableSelection(text: string): boolean {
  return text.replace(/\s+/g, '').length >= 2;
}
