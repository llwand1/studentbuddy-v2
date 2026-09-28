/**
 * quote-ask 纯函数：选区 → 引用块 → 并进输入框。UI 挂线见 QuoteAsk.test.tsx / ChatView.test.tsx。
 */
import { describe, it, expect } from 'vitest';
import { buildQuote, mergeQuoteIntoInput, isQuotableSelection, QUOTE_MAX_CHARS } from './quote-ask';

describe('buildQuote', () => {
  it('逐行加 `> `；空行丢掉、行内多余空白折成一个空格', () => {
    expect(buildQuote('  闭包＝函数 +   词法环境。\n\n\n  第二行  ')).toBe('> 闭包＝函数 + 词法环境。\n> 第二行');
  });
  it('全是空白 ⇒ 空串（调用方据此不动输入框）', () => {
    expect(buildQuote(' \n\t ')).toBe('');
  });
  it(`超过 ${QUOTE_MAX_CHARS} 字截断并加省略号（引用是「指哪句」，不是转述全文）`, () => {
    const long = 'x'.repeat(QUOTE_MAX_CHARS + 50);
    const q = buildQuote(long);
    expect(q.startsWith('> ')).toBe(true);
    expect(q.endsWith('…')).toBe(true);
    expect(q.length).toBe(2 + QUOTE_MAX_CHARS + 1);
  });
  it('截断点落在行尾空白时不留悬空空格', () => {
    expect(buildQuote('ab cd', 3)).toBe('> ab…');
  });
});

describe('mergeQuoteIntoInput', () => {
  it('空输入框 ⇒ 引用块 + 空行，光标位留给提问', () => {
    expect(mergeQuoteIntoInput('', '> 引用')).toBe('> 引用\n\n');
    expect(mergeQuoteIntoInput('   \n', '> 引用')).toBe('> 引用\n\n');
  });
  it('已有内容 ⇒ 接在其后空一行，不覆盖用户打了一半的问题', () => {
    expect(mergeQuoteIntoInput('这句没懂', '> 引用')).toBe('这句没懂\n\n> 引用\n\n');
    expect(mergeQuoteIntoInput('这句没懂\n\n', '> 引用')).toBe('这句没懂\n\n> 引用\n\n');
  });
  it('空引用块 ⇒ 原样返回', () => {
    expect(mergeQuoteIntoInput('abc', '')).toBe('abc');
  });
});

describe('isQuotableSelection', () => {
  it('至少两个非空白字符才算（单字符多半是误触）', () => {
    expect(isQuotableSelection('a')).toBe(false);
    expect(isQuotableSelection(' a \n')).toBe(false);
    expect(isQuotableSelection('ab')).toBe(true);
    expect(isQuotableSelection('闭 包')).toBe(true);
  });
});
