import { describe, it, expect } from 'vitest';
import { fixJson, parseChart, renderChartSvg } from './chart-utils';

describe('fixJson（port from v1）', () => {
  it('剥 // 行注释与块注释，字符串内与协议 :// 不受伤', () => {
    const src = '{\n// 注释\n"url": "https://a.example/x", /* 块注释 */\n"s": "a//b"\n}';
    const out = fixJson(src).code;
    expect(out).toContain('https://a.example/x');
    expect(out).toContain('"a//b"');
    expect(out).not.toContain('// 注释');
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('剥尾逗号后可 parse', () => {
    expect(() => JSON.parse(fixJson('{"a":1,}').code)).not.toThrow();
  });
});

describe('parseChart 校验', () => {
  it('合法 bar 通过；注释+尾逗号也能修复解析', () => {
    const s = parseChart('{"type":"bar","title":"t","labels":["a","b"],"values":[1,2]}');
    expect(s?.type).toBe('bar');
    expect(s?.values).toEqual([1, 2]);
    expect(parseChart('{"type":"line","labels":["a"],"values":[3],}')?.type).toBe('line');
  });

  it('type 非法/长度不等/负值/非数值/饼图全零/空数组 → null', () => {
    expect(parseChart('{"type":"scatter","labels":[],"values":[]}')).toBeNull();
    expect(parseChart('{"type":"bar","labels":["a"],"values":[1,2]}')).toBeNull();
    expect(parseChart('{"type":"bar","labels":["a"],"values":[-1]}')).toBeNull();
    expect(parseChart('{"type":"bar","labels":["a"],"values":["3"]}')).toBeNull();
    expect(parseChart('{"type":"pie","labels":["a"],"values":[0]}')).toBeNull();
    expect(parseChart('{"type":"bar","labels":[],"values":[]}')).toBeNull();
    expect(parseChart('not json at all')).toBeNull();
  });

  it('超限降级：柱状 >31 点、饼图 >8 扇区 → null；标题截断到 40 字', () => {
    const labels = Array.from({ length: 32 }, (_, i) => `k${i}`);
    const values = labels.map((_, i) => i);
    expect(parseChart(JSON.stringify({ type: 'bar', labels, values }))).toBeNull();
    expect(parseChart(JSON.stringify({ type: 'pie', labels: labels.slice(0, 9), values: values.slice(0, 9) }))).toBeNull();
    expect(
      parseChart(JSON.stringify({ type: 'bar', labels: ['a'], values: [1], title: '长'.repeat(41) }))?.title,
    ).toHaveLength(40);
  });
});

describe('renderChartSvg 自产 SVG', () => {
  it('bar：rect 数 = 值数，主题色走变量，标题在图内', () => {
    const svg = renderChartSvg({ type: 'bar', title: '周学习时长', labels: ['周一', '周二', '周三'], values: [30, 45, 20] });
    expect(svg.match(/<rect /g)).toHaveLength(3);
    expect(svg).toContain('var(--sb-primary)');
    expect(svg).toContain('周学习时长');
  });

  it('line：polyline + 每点一个圆点', () => {
    const svg = renderChartSvg({ type: 'line', title: '', labels: ['a', 'b', 'c', 'd'], values: [1, 3, 2, 4] });
    expect(svg).toContain('<polyline');
    expect(svg.match(/<circle /g)).toHaveLength(4);
  });

  it('pie：扇区 path 数 = 值数，图例含占比；单项扇区画整圆', () => {
    const svg = renderChartSvg({ type: 'pie', title: '', labels: ['a', 'b', 'c'], values: [2, 1, 1] });
    expect(svg.match(/<path /g)).toHaveLength(3);
    expect(svg).toContain('%');
    expect(renderChartSvg({ type: 'pie', title: '', labels: ['only'], values: [5] })).toContain('<circle');
  });

  it('文本节点全转义：恶意 label 不产生裸标签', () => {
    const svg = renderChartSvg({ type: 'bar', title: '', labels: ['<script>x</script>', '&<>"'], values: [1, 2] });
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('&amp;');
  });
});
