/**
 * remend（流式未闭合记号修补）单测 —— 移植 Vercel streamdown/packages/remend 后的行为基线。
 * 分组：可直接补的、必须不动的（词内/列表标记/水平线/代码区）、半闭合与链接收口、开关。
 */
import { describe, it, expect } from 'vitest';
import { remend } from './remend';
import { parseBlocks, remedy } from './markdown';

describe('remend 强调符补全', () => {
  it('半截斜体：单星 / 单下划线 / 双下划线各自补尾', () => {
    expect(remend('这是 *斜体')).toBe('这是 *斜体*');
    expect(remend('这是 _斜体')).toBe('这是 _斜体_');
    expect(remend('这是 __斜体')).toBe('这是 __斜体__');
  });

  it('半截粗斜体 *** 补 ***，不会被当成未闭合的 ** 补成 ***x**', () => {
    expect(remend('***粗斜体')).toBe('***粗斜体***');
  });

  it('半闭合收尾只补一个记号：**内容* → **内容**', () => {
    expect(remend('**内容*')).toBe('**内容**');
    expect(remend('~~内容~')).toBe('~~内容~~');
    expect(remend('__内容_')).toBe('__内容__');
  });

  it('已闭合的记号一字不动', () => {
    for (const s of ['**粗** *斜* `码` ~~删~~', '***全都闭合了***', '__下划线闭合__']) {
      expect(remend(s)).toBe(s);
    }
  });

  it('记号后还没写正文（只有空白/别的记号）时不补，避免造出空标记', () => {
    expect(remend('**')).toBe('**');
    expect(remend('文字 **')).toBe('文字 **');
  });
});

describe('remend 不该动的场景（上游边界判定）', () => {
  it('词内星号是乘号/普通字符，不开斜体（2*3=a 不补）', () => {
    expect(remend('2*3=6')).toBe('2*3=6');
    expect(remend('snake_case_name 变量')).toBe('snake_case_name 变量');
  });

  it('列表标记 * / - 不当强调符起始', () => {
    expect(remend('* 列表项一')).toBe('* 列表项一');
  });

  it('水平线 --- / *** 不参与配平', () => {
    expect(remend('上面一段\n---')).toBe('上面一段\n---');
    expect(remend('上面一段\n***')).toBe('上面一段\n***');
  });

  it('代码区内的记号不参与计数：已闭合围栏原样', () => {
    expect(remend('```py\nresult = a ** b\n```')).toBe('```py\nresult = a ** b\n```');
  });

  it('行内代码里的星号不污染外层补全', () => {
    expect(remend('`a ** b`')).toBe('`a ** b`');
  });

  it('转义记号不计数', () => {
    expect(remend('\\*\\*不是加粗')).toBe('\\*\\*不是加粗');
  });
});

describe('remend 围栏 / 行内代码 / HTML / 链接', () => {
  it('未闭合围栏补尾，补完能解析成代码块', () => {
    const out = remend('```js\nconst a = 1');
    expect(out).toBe('```js\nconst a = 1\n```');
    const bs = parseBlocks(out);
    expect(bs[0]?.kind).toBe('code');
  });

  it('围栏未闭合时不补行内反引号（那多半是围栏本身）', () => {
    expect(remend('```js\nconst s = "`"')).toBe('```js\nconst s = "`"\n```');
  });

  it('剥掉尾部半截 HTML 标签', () => {
    expect(remend('文字 <custom')).toBe('文字');
    expect(remend('文字 <div class="a')).toBe('文字');
    // 已闭合的标签不动
    expect(remend('文字 <b>粗</b>')).toBe('文字 <b>粗</b>');
  });

  it('半截链接只留文字（text-only 默认），半截图片给占位 src', () => {
    expect(remend('见 [官网](https://a.example')).toBe('见 官网');
    expect(remend('见 [官网](')).toBe('见 官网');
    expect(remend('![配图](https://a.example/png')).toBe('![配图](sb:incomplete-image)');
  });

  it('linkMode 可切回 protocol（给渲染层留出特判占位 URL 的余地）', () => {
    expect(remend('见 [官网](https://a.example', { linkMode: 'protocol' })).toBe(
      '见 [官网](sb:incomplete-link)',
    );
  });
});

describe('remend 开关与接入', () => {
  it('可单独关掉某一类补全', () => {
    expect(remend('这是 *斜体', { italic: false })).toBe('这是 *斜体');
    expect(remend('文字 <custom', { htmlTags: false })).toBe('文字 <custom');
  });

  it('空串 / 无记号文本原样返回', () => {
    expect(remend('')).toBe('');
    expect(remend('一段普通中文回答')).toBe('一段普通中文回答');
  });

  it('remedy 即 remend 的默认配置（渲染层入口不变）', () => {
    expect(remedy('这是 **正在加粗中')).toBe(remend('这是 **正在加粗中'));
  });

  it('补出来的斜体真的能解析成 em（不留 * 在屏幕上）', () => {
    const bs = parseBlocks(remedy('这是 *斜体中'));
    expect(bs[0]?.kind).toBe('para');
    expect(JSON.stringify(bs)).toContain('"em"');
    expect(JSON.stringify(bs)).not.toContain('*');
  });
});
