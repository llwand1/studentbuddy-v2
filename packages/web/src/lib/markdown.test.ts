import { describe, it, expect } from 'vitest';
import { parseBlocks, parseInline, remedy, stableCut } from './markdown';
import type { Block } from './markdown';

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

  it('```html → html 块（只给「新标签页打开」卡，绝不内联）；未实现语言仍是代码块', () => {
    const bs = parseBlocks('```html\n<button onclick="alert(1)">点</button>\n```');
    expect(bs[0]?.kind).toBe('html');
    if (bs[0]?.kind === 'html') expect(bs[0].code).toContain('alert(1)');
    expect(parseBlocks('```vue\n<template/>\n```')[0]?.kind).toBe('code');
  });

  it('```chart 围栏 → chart 块；未闭合也成块并标 closed=false（流式）', () => {
    const done = parseBlocks('看数据：\n```chart\n{"type":"bar","labels":["一"],"values":[1]}\n```');
    expect(done.map((b) => b.kind)).toEqual(['para', 'chart']);
    if (done[1]?.kind === 'chart') expect(done[1].closed).toBe(true);

    const half = parseBlocks('```chart\n{"type":"pie"');
    expect(half[0]?.kind).toBe('chart');
    if (half[0]?.kind === 'chart') expect(half[0].closed).toBe(false);

    expect(parseBlocks('```mermaid\nflow TD\na-->b\n```')[0]?.kind).toBe('code');
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

  it('加粗内嵌斜体递归解析（此前 **a *b* c** 会错乱成星号碎片）', () => {
    const inl = parseInline('**a *b* c**');
    expect(inl).toHaveLength(1);
    expect(inl[0]?.t).toBe('strong');
    if (inl[0]?.t === 'strong') {
      expect(inl[0].children.map((x) => x.t)).toEqual(['text', 'em', 'text']);
    }
  });

  it('裸 URL 自动成链接，尾部标点不粘进 href', () => {
    const inl = parseInline('文档见 https://a.example/x,还有说明。');
    const links = inl.filter((x) => x.t === 'a');
    expect(links).toHaveLength(1);
    if (links[0]?.t === 'a') {
      expect(links[0].href).toBe('https://a.example/x'); // 逗号留给正文，不进链接
      expect(JSON.stringify(inl)).toContain(',还有说明。');
    }
  });

  it('括号平衡的 URL 不误剥右括号', () => {
    const inl = parseInline('见 https://en.wikipedia.org/wiki/Tree_(data_structure) 说明');
    const a = inl.find((x) => x.t === 'a');
    if (a?.t === 'a') expect(a.href).toBe('https://en.wikipedia.org/wiki/Tree_(data_structure)');
  });
});

describe('markdown 列表增强（GFM）', () => {
  it('任务列表 [ ] / [x] 解析出 checked，不再原样显示方括号', () => {
    const bs = parseBlocks('- [ ] 未完成\n- [x] 已完成');
    expect(bs[0]?.kind).toBe('ul');
    if (bs[0]?.kind === 'ul') {
      expect(bs[0].items).toHaveLength(2);
      expect(bs[0].items[0]?.checked).toBe(false);
      expect(bs[0].items[1]?.checked).toBe(true);
      expect(JSON.stringify(bs)).not.toContain('[ ]');
    }
  });

  it('缩进子列表不再被压平成同级项', () => {
    const bs = parseBlocks('- 一级\n  - 二级');
    if (bs[0]?.kind === 'ul') {
      const first = bs[0].items[0];
      expect(first?.children).toHaveLength(1);
      expect(JSON.stringify(first?.children)).toContain('二级');
    }
  });

  it('列表项续行并入同一项，不再拆成独立段落', () => {
    const bs = parseBlocks('- 项目一\n  续行说明');
    expect(bs).toHaveLength(1);
    expect(bs[0]?.kind).toBe('ul');
    expect(JSON.stringify(bs)).toContain('续行说明');
  });

  it('有序列表行为不回归', () => {
    const bs = parseBlocks('1. 第一\n2. 第二');
    expect(bs[0]?.kind).toBe('ol');
    if (bs[0]?.kind === 'ol') expect(bs[0].items).toHaveLength(2);
  });
});

describe('stableCut（流式增量解析切点）', () => {
  it('切在最后一个围栏平衡的空行处', () => {
    const src = '段落一\n\n段落二';
    const cut = stableCut(src);
    expect(src.slice(0, cut)).toBe('段落一\n\n');
  });

  it('围栏未闭合（围栏内空行）不切，绝不把代码块劈成两半', () => {
    expect(stableCut('```js\nconst a = 1;\n\nconst b = 2;')).toBe(0);
    // 围栏已闭合之后的空行才是安全切点
    const src = '```js\nconst a = 1;\n```\n\n后文';
    const cut = stableCut(src);
    expect(src.slice(cut)).toBe('后文');
  });

  it('无空行的短文本没有稳定前缀', () => {
    expect(stableCut('一段还没有换行的文字')).toBe(0);
  });

  it('增量拼接与一次性全量解析逐块等价（模拟逐字符到达的流式）', () => {
    const src = '# 标题\n\n段落一 **加粗**。\n\n- 列表甲\n- 列表乙\n  - 子项\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n结尾段落';
    // 模拟流式：文本一字符一字符长，每帧只解析新闭合的块
    let upto = 0;
    let stable: Block[] = [];
    for (let end = 1; end <= src.length; end++) {
      const s = src.slice(0, end);
      const cut = stableCut(s);
      if (cut > upto) {
        stable = [...stable, ...parseBlocks(s.slice(upto, cut))];
        upto = cut;
      }
    }
    const combined = [...stable, ...parseBlocks(src.slice(upto))];
    expect(JSON.stringify(combined)).toBe(JSON.stringify(parseBlocks(src)));
  });
});

describe('remedy（流式未闭合记号修复）', () => {
  it('半截加粗补上收尾的 **', () => {
    expect(remedy('这是 **正在加粗中')).toBe('这是 **正在加粗中**');
  });

  it('半截行内代码补上收尾的反引号', () => {
    expect(remedy('值是 `printf(')).toBe('值是 `printf(`');
  });

  it('半截删除线补上收尾的 ~~', () => {
    expect(remedy('这里要 ~~划掉一半')).toBe('这里要 ~~划掉一半~~');
  });

  it('未闭合的代码围栏补上收尾，整段代码不会被吞成正文', () => {
    const out = remedy('```js\nconst a = 1');
    expect(out).toBe('```js\nconst a = 1\n```');
    // 补完之后必须真的解析成代码块，而不是一段带着 ``` 的正文
    const bs = parseBlocks(out);
    expect(bs).toHaveLength(1);
    expect(bs[0]?.kind).toBe('code');
  });

  it('已闭合的文本一字不动（不给历史消息加尾巴）', () => {
    const src = '**重点** 与 `code()` 与 ~~旧值~~ 混排';
    expect(remedy(src)).toBe(src);
  });

  it('代码区里的星号不参与计数，不误补', () => {
    const src = '```py\nresult = a ** b\n```';
    expect(remedy(src)).toBe(src);
  });

  it('半截链接：只留链接文字，不把半截 URL 变成可点链接（text-only 收口）', () => {
    // 上游 remend 的 'protocol' 模式要求渲染层把占位 URL 特判成「不可点文字」，本仓渲染层没有
    // 这个配合，故默认 text-only：文字保留、半截 URL 标记丢弃，闭合后自动变回可点链接。
    // （旧行为是补 ')' 让半截 URL 直接成为可点链接——URL 逐字变长时每帧重挂 <a>，观感更抖。）
    expect(remedy('见 [官网](https://a.example')).toBe('见 官网');
    expect(remedy('见 [官网](')).toBe('见 官网');
  });

  it('空串与无记号文本原样返回', () => {
    expect(remedy('')).toBe('');
    expect(remedy('一段普通中文回答')).toBe('一段普通中文回答');
  });

  it('修复后的半截加粗能解析出 strong，且屏幕上不留 ** ', () => {
    const bs = parseBlocks(remedy('这是 **正在加粗中'));
    expect(bs[0]?.kind).toBe('para');
    expect(JSON.stringify(bs)).toContain('"strong"');
    expect(JSON.stringify(bs)).not.toContain('**');
  });
});
