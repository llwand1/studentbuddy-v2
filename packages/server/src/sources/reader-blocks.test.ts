/**
 * reader-blocks：清洗后的 HTML → 块模型（契约 `docs/SOURCE-TRACE-SPEC.md` §14.1）。
 *
 * 这层的职责是**结构归并**，不是安全清洗（上游 `sanitizeReaderHtml` 已经做过）。
 * 但它是「第三方内容进入主文档前的最后一道形状约束」，所以仍然钉两条纵深防御：
 *   ① 不认识的标签一律降级成文本，**绝不透传**；
 *   ② `href` / `src` 再过一次 http(s) 判定（上游正则清洗器出 bug 时这里兜住）。
 * 其余用例钉结构正确性——块 id 必须稳定且唯一，选区锚点全靠它。
 */
import { describe, expect, it } from 'vitest';
import { blockText } from '@sb/shared';
import { parseReaderBlocks } from './reader-blocks.js';

describe('parseReaderBlocks：基本结构', () => {
  it('标题带级别、段落成块、块 id 稳定唯一', () => {
    const bs = parseReaderBlocks('<h2>标题</h2><p>第一段</p><p>第二段</p>');
    expect(bs.map((b) => b.t)).toEqual(['h', 'p', 'p']);
    expect(bs[0]).toMatchObject({ t: 'h', level: 2, id: 'b0' });
    expect(bs.map((b) => b.id)).toEqual(['b0', 'b1', 'b2']);
    expect(new Set(bs.map((b) => b.id)).size).toBe(3);
  });

  it('同一份输入两次解析结果逐字相同（id 与内容无关，文案微调不会错位）', () => {
    const html = '<h1>A</h1><p>B</p><ul><li>C</li></ul>';
    expect(parseReaderBlocks(html)).toEqual(parseReaderBlocks(html));
  });

  it('列表记 ordered 与 depth；嵌套层级正确', () => {
    const bs = parseReaderBlocks('<ul><li>一</li><li>二<ol><li>二甲</li></ol></li></ul>');
    const lis = bs.filter((b) => b.t === 'li');
    expect(lis).toHaveLength(3);
    expect(lis[0]).toMatchObject({ ordered: false, depth: 0 });
    expect(lis[2]).toMatchObject({ ordered: true, depth: 1 });
  });

  it('pre 保留换行与原样文本，不折叠空白', () => {
    const bs = parseReaderBlocks('<pre>line1\n  line2</pre>');
    expect(bs[0]).toMatchObject({ t: 'pre', v: 'line1\n  line2' });
  });

  it('引用、分隔线、图片各自成块；图片取 src/alt', () => {
    const bs = parseReaderBlocks('<blockquote>引</blockquote><hr><img src="https://e.com/a.png" alt="图说">');
    expect(bs.map((b) => b.t)).toEqual(['quote', 'hr', 'img']);
    expect(bs[2]).toMatchObject({ src: 'https://e.com/a.png', alt: '图说' });
  });
});

describe('parseReaderBlocks：行内片段', () => {
  it('链接成 link 片段并保留 href', () => {
    const bs = parseReaderBlocks('<p>看<a href="https://e.com/x">这里</a>好</p>');
    const spans = bs[0] && bs[0].t === 'p' ? bs[0].spans : [];
    expect(spans.find((s) => s.t === 'link')).toMatchObject({ v: '这里', href: 'https://e.com/x' });
    expect(blockText(bs[0]!)).toBe('看这里好');
  });

  it('strong/b 与 em/i 归一；相邻同型片段合并，不切一地碎块', () => {
    const bs = parseReaderBlocks('<p><b>粗</b><strong>也粗</strong><i>斜</i></p>');
    const spans = bs[0] && bs[0].t === 'p' ? bs[0].spans : [];
    expect(spans.filter((s) => s.t === 'strong')).toHaveLength(1);
    expect(spans.find((s) => s.t === 'strong')?.v).toBe('粗也粗');
    expect(spans.find((s) => s.t === 'em')?.v).toBe('斜');
  });
});

describe('parseReaderBlocks：纵深防御', () => {
  it('① 不认识的标签降级成文本，绝不透传', () => {
    const bs = parseReaderBlocks('<p>前<marquee onclick="x()">中</marquee>后</p>');
    expect(blockText(bs[0]!)).toBe('前中后');
    expect(JSON.stringify(bs)).not.toContain('onclick');
    expect(JSON.stringify(bs)).not.toContain('marquee');
  });

  it('② javascript: 链接被丢掉 href（上游漏了这里兜住）', () => {
    const bs = parseReaderBlocks('<p><a href="javascript:alert(1)">点我</a></p>');
    const spans = bs[0] && bs[0].t === 'p' ? bs[0].spans : [];
    expect(spans.some((s) => s.t === 'link')).toBe(false);
    expect(blockText(bs[0]!)).toBe('点我'); // 文字仍在，只是不再是链接
  });

  it('② data:/相对 图片被丢弃，只认 http(s)', () => {
    expect(parseReaderBlocks('<img src="data:image/svg+xml,<svg onload=alert(1)>">')).toHaveLength(0);
    expect(parseReaderBlocks('<img src="/local.png">')).toHaveLength(0);
    expect(parseReaderBlocks('<img src="https://e.com/ok.png">')).toHaveLength(1);
  });

  it('裸文本（没被 p 包住）也成段，不丢内容', () => {
    expect(blockText(parseReaderBlocks('散落的文字')[0]!)).toBe('散落的文字');
  });

  it('空白与空块不产出，省得页面一堆空段', () => {
    expect(parseReaderBlocks('<p>  </p><p></p><div>\n</div>')).toHaveLength(0);
  });
});
