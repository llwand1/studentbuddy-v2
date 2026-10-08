// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { extractSvgBlocks, hasClosedSvgTag, stripSvgFenceLine, parseSvgSize, fixSvg, sanitizeSvg, prepareSvg } from './svg-utils';

// sanitizeSvg 是白名单 DOM 净化器（svg-sanitize.ts），需要 DOM ⇒ 本文件按文件 pragma 启用 jsdom。
// 攻击语料 / 模糊测试在 svg-sanitize.test.ts 与 svg-sanitize.fuzz.test.ts；这里只锁 svg-utils 这层的组合行为。

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

  it('保留纯黑文字与白色绘图内容，不反转为夜间主题色', () => {
    const themed = fixSvg('<svg><text fill="#000" stroke="white">x</text></svg>').code;
    expect(themed).toContain('fill="#000"');
    expect(themed).toContain('stroke="white"');
  });
});

describe('安全净化 sanitizeSvg（白名单 DOM 路径）', () => {
  it('剥掉 script / foreignObject / iframe 整块与自闭合危险标签，空 <style/> 保留', () => {
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

  it('自愈产物保留黑白配色，并有同一份导出白底', () => {
    const out = prepareSvg('<svg width="400" height="200"><text fill="#000" stroke="white">x</text></svg>');
    expect(out).toContain('viewBox="0 0 400 200"');
    expect(out).toContain('fill="#000"');
    expect(out).toContain('stroke="white"');
    expect(out).toContain('fill="#ffffff"');
  });

  it('透明图的白底覆盖非零 viewBox，主题变量在独立 SVG 中为实体颜色', () => {
    const out = prepareSvg('<svg viewBox="-40 20 320 200"><text fill="var(--sb-ink)" style="stroke:var(--sb-line)">流程</text><path stroke="red"/></svg>');
    const root = new DOMParser().parseFromString(out, 'image/svg+xml').documentElement;
    const paper = root.firstElementChild;
    expect(paper?.getAttribute('x')).toBe('-40');
    expect(paper?.getAttribute('y')).toBe('20');
    expect(paper?.getAttribute('width')).toBe('320');
    expect(paper?.getAttribute('height')).toBe('200');
    expect(paper?.getAttribute('fill')).toBe('#ffffff');
    expect(root.querySelector('text')?.getAttribute('fill')).toBe('#20242c');
    expect(out).not.toContain('var(--sb-');
    expect(root.querySelector('path')?.getAttribute('stroke')).toBe('red');
  });

  it('重复准备不会叠白底；模型样式不覆盖固定纸面，净化仍挡脚本', () => {
    const original = '<svg viewBox="0 0 200 100"><style>rect{fill:black;opacity:0.5}</style><script>evil()</script><text fill="currentColor">默认文字</text></svg>';
    const out = prepareSvg(prepareSvg(original));
    const root = new DOMParser().parseFromString(out, 'image/svg+xml').documentElement;
    expect(root.querySelectorAll('rect')).toHaveLength(1);
    expect(root.firstElementChild?.getAttribute('style')).toContain('fill:#ffffff!important');
    expect(root.getAttribute('color')).toBe('#20242c');
    expect(out).not.toContain('evil()');
    expect(root.querySelector('style')?.textContent).toContain('data-sb-scope');
  });

  it('没有 <svg> 根的输入净化为空串（卡片走「无法解析」降级，不注入任何东西）', () => {
    expect(sanitizeSvg('<div onclick="x">not svg</div>')).toBe('');
  });
});
