import { describe, it, expect } from 'vitest';
import { parseBlocks, parseInline } from './markdown';

describe('markdown 块级切分', () => {
  it('普通中文回答整段落成一个 para，不吞字', () => {
    const bs = parseBlocks('光合作用是植物利用光能的过程。\n它分光反应与暗反应两阶段。');
    expect(bs).toHaveLength(1);
    expect(bs[0]?.kind).toBe('para');
    const flat = JSON.stringify(bs);
    expect(flat).toContain('光合作用是植物利用光能的过程。');
    expect(flat).toContain('它分光反应与暗反应两阶段。');
  });

  it('标题/无序列表/有序列表/引用/分割线各自成块', () => {
    const bs = parseBlocks('# 标题\n- a\n- b\n1. x\n2. y\n> 引文\n---\n结尾段落');
    expect(bs.map((b) => b.kind)).toEqual(['heading', 'ul', 'ol', 'quote', 'hr', 'para']);
    if (bs[0]?.kind === 'heading') expect(bs[0].level).toBe(1);
    if (bs[1]?.kind === 'ul') expect(bs[1].items).toHaveLength(2);
  });

  it('表格：表头 + 分隔行 + 数据行', () => {
    const bs = parseBlocks('| 名 | 值 |\n|---|---|\n| a | 1 |\n| b | 2 |');
    expect(bs[0]?.kind).toBe('table');
    if (bs[0]?.kind === 'table') {
      expect(bs[0].head).toHaveLength(2);
      expect(bs[0].rows).toHaveLength(2);
    }
  });

  it('```svg 围栏 → svg 块；未闭合也成块并标 closed=false（流式）', () => {
    const done = parseBlocks('看图：\n```svg\n<svg viewBox="0 0 10 10"><rect/></svg>\n```');
    expect(done.map((b) => b.kind)).toEqual(['para', 'svg']);
    if (done[1]?.kind === 'svg') expect(done[1].closed).toBe(true);

    const half = parseBlocks('```svg\n<svg viewBox="0 0 10 10"><rect');
    expect(half[0]?.kind).toBe('svg');
    if (half[0]?.kind === 'svg') expect(half[0].closed).toBe(false);
  });

  it('未实现的围栏语言（html/mermaid）只能当代码块，不会变成 svg 通道', () => {
    const bs = parseBlocks('```html\n<script>alert(1)</script>\n```');
    expect(bs[0]?.kind).toBe('code');
    if (bs[0]?.kind === 'code') expect(bs[0].lang).toBe('html');
  });
});

describe('markdown 行内标记', () => {
  it('bold / inline code / 链接 解析成对应 inline', () => {
    const inl = parseInline('**重点** 和 `code()` 以及 [官网](https://a.example)');
    expect(inl.map((x) => x.t)).toEqual(['strong', 'text', 'code', 'text', 'a']);
    const a = inl.find((x) => x.t === 'a');
    if (a?.t === 'a') expect(a.href).toBe('https://a.example');
  });

  it('javascript: 链接降级为纯文本（不出 a 标签）', () => {
    const inl = parseInline('[点我](javascript:alert(1))');
    expect(inl.some((x) => x.t === 'a')).toBe(false);
    expect(JSON.stringify(inl)).toContain('javascript:alert(1)');
  });

  it('未闭合记号原样保留，不误吞后文', () => {
    const inl = parseInline('2 * 3 与 a`b 混排');
    expect(inl.every((x) => x.t === 'text')).toBe(true);
  });
});
