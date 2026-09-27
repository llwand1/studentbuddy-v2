import { describe, it, expect } from 'vitest';
import { extractSvgBlocks, hasClosedSvgTag, stripSvgFenceLine, parseSvgSize, fixSvg, sanitizeSvg, prepareSvg } from './svg-utils';

// node 环境无 DOMParser → sanitizeSvg 走线性正则回退路径（浏览器里走 DOM 快路径）。

describe('svg 围栏提取', () => {
  it('抽出所有已闭合 ```svg 块', () => {
    const text = '前\n```svg\n<svg><rect/></svg>\n```\n中\n```svg\n<svg><circle/></svg>\n```\n后';
    expect(extractSvgBlocks(text)).toEqual(['<svg><rect/></svg>', '<svg><circle/></svg>']);
  });

  it('stripSvgFenceLine 去掉流式首行 / hasClosedSvgTag 判闭合', () => {
    expect(stripSvgFenceLine('```svg\n<svg')).toBe('<svg');
    expect(hasClosedSvgTag('<svg><rect/></svg>')).toBe(true);
    expect(hasClosedSvgTag('<svg><rect/>')).toBe(false);
  });
});

describe('svg 尺寸解析', () => {
  it('优先 width/height，缺失时退回 viewBox', () => {
    expect(parseSvgSize('<svg width="300" height="200">')).toEqual({ w: 300, h: 200 });
    expect(parseSvgSize('<svg viewBox="0 0 640 480">')).toEqual({ w: 640, h: 480 });
  });

  it('内部子元素的 width 不参与解析（只看根标签）', () => {
    expect(parseSvgSize('<svg viewBox="0 0 100 50"><rect width="180" height="9"/></svg>').w).toBe(100);
  });
});

describe('L1 自愈 fixSvg', () => {
  it('补上缺失的 </svg> 闭合', () => {
    const r = fixSvg('<svg viewBox="0 0 9 9"><rect/>');
    expect(r.code.endsWith('</svg>')).toBe(true);
    expect(r.fixed).toBe(true);
  });

  it('超宽钳到 680；无 viewBox 时按 width/height 合成', () => {
    expect(fixSvg('<svg width="2000" height="800">').code).toContain('width="680"');
    const merged = fixSvg('<svg width="400" height="200"><rect/></svg>').code;
    expect(merged).toContain('viewBox="0 0 400 200"');
  });

  it('纯黑/纯白描边换成主题变量（深色主题不再一团黑）', () => {
    const themed = fixSvg('<svg><text fill="#000" stroke="white">x</text></svg>').code;
    expect(themed).toContain('fill="var(--sb-ink)"');
    expect(themed).toContain('stroke="var(--sb-bg)"');
  });
});

describe('安全净化 sanitizeSvg（正则回退路径）', () => {
  it('剥掉 script / foreignObject / iframe 整块与自闭合危险标签', () => {
    const dirty =
      '<svg><script>alert(1)</script><foreignObject><b>x</b></foreignObject><iframe/><style/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('alert(1)');
    expect(clean).not.toContain('foreignObject');
    expect(clean).not.toContain('iframe');
    expect(clean).toContain('<style/>');
  });

  it('剥掉 <image> 外链（否则本地应用会被动发请求，泄露 IP 与本机存在）', () => {
    const clean = sanitizeSvg('<svg><image href="https://evil.test/beacon.png" width="10" height="10"/><rect/></svg>');
    expect(clean).not.toContain('evil.test');
    expect(clean).not.toContain('<image');
    expect(clean).toContain('<rect');
  });

  it('剥掉 on* 事件属性与 javascript: 链接协议', () => {
    const clean = sanitizeSvg('<svg><a href="javascript:alert(2)" onclick="evil()" onmouseover=3><text>ok</text></a></svg>');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('onmouseover');
    expect(clean).toContain('ok');
  });

  it('大输入线性完成（v1 曾因 [\\s\\S]*? 回溯把主线程钉死几十秒）', () => {
    const big = '<svg>' + '<script>' + 'x'.repeat(40_000) + '</script>'.repeat(1) + '<rect/>'.repeat(2000) + '</svg>';
    const t0 = Date.now();
    sanitizeSvg(big.replace('</script>', '</script><script>'));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('prepareSvg = 自愈 + 净化：流式半截危险图既不白屏也不留脚本', () => {
    const out = prepareSvg('<svg width="1200" height="40"><script>bad()</script><rect fill="#000"/>');
    expect(out).toContain('width="680"');
    expect(out).not.toContain('bad()');
    expect(out).toContain('</svg>');
  });
});
