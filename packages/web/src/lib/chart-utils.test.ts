import { describe, it, expect } from 'vitest';
import { fixJson, parseChart, renderChartSvg, renderTrendSvg } from './chart-utils';

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

/**
 * 趋势卡折线（记忆联动 P5，契约 docs/MEMORY-TREND-SPEC.md §4.1/§4.4）。
 *
 * 这里钉的不是"好不好看"，而是三条**数据纪律**：① 只画不算（点数 = 值数，不插值不预测）；
 * ② 空数据不画（坏 meta 时宁可没图，也不能画一张假的）；③ 数字全来自入参（脏值当 0 而不是整图作废）。
 */
describe('renderTrendSvg — 趋势卡紧凑折线', () => {
  const labels = ['09-12', '09-13', '09-14', '09-15', '09-16', '09-17', '09-18'];

  it('7 个点 → 一条 polyline + 7 个圆点；用的是紧凑画布（320 宽，不是 ```chart 的 680）', () => {
    const svg = renderTrendSvg({ labels, values: [1, 0, 3, 2, 0, 5, 4] });
    expect(svg.match(/<circle /g)).toHaveLength(7);
    expect(svg).toContain('<polyline');
    expect(svg).toContain('viewBox="0 0 320 112"');
    expect(svg).not.toContain('viewBox="0 0 680');
  });

  it('空数据（坏 meta 被服务端退成的形状）⇒ 空串：宁可不画图，也不画一张假的', () => {
    expect(renderTrendSvg({ labels: [], values: [] })).toBe('');
    expect(renderTrendSvg({ labels: ['09-18'], values: [] })).toBe('');
    expect(renderTrendSvg({ labels: [], values: [3] })).toBe('');
  });

  it('只画不算：点数严格 = min(标签数, 值数)，不补点、不插值、不预测', () => {
    expect(renderTrendSvg({ labels: labels.slice(0, 3), values: [2, 4, 8] }).match(/<circle /g)).toHaveLength(3);
    expect(renderTrendSvg({ labels: ['09-18'], values: [7] }).match(/<circle /g)).toHaveLength(1);
    // 长度不等时按短的截：多出来的标签不画点、多出来的值也不编造一天出来
    const mixed = renderTrendSvg({ labels, values: [1, 2, 3] });
    expect(mixed.match(/<circle /g)).toHaveLength(3);
  });

  it('峰值点实心加重（小图里"最高那天在哪"是唯一要一眼读到的事实）；全 0 时不误标', () => {
    expect(renderTrendSvg({ labels, values: [1, 0, 3, 2, 0, 5, 4] }).match(/r="3\.4"/g)).toHaveLength(1);
    // 全 0 时第一个点不该被当成"最高那天"——那是 indexOf(0) 的陷阱
    expect(renderTrendSvg({ labels, values: [0, 0, 0] })).not.toContain('r="3.4"');
  });

  it('脏值（负数/NaN）当 0 而不是整图作废（数据来自自己的 SQL，个别脏值不该让整卡少一块）', () => {
    const svg = renderTrendSvg({ labels: labels.slice(0, 3), values: [-5, Number.NaN, 7] });
    expect(svg.match(/<circle /g)).toHaveLength(3);
    expect(svg).toContain('>10<'); // 纵轴上界取好看的整数：niceMax(7) = 10
  });

  it('横轴抽稀：7 天不超过 4 个日期标签，且"今天"必标（它是这张图默认的落点）', () => {
    const svg = renderTrendSvg({ labels, values: [1, 1, 1, 1, 1, 1, 1] });
    // 横轴日期在画布底部 y = 112 - 6 = 106（峰值刻度在左上，不参与计数）
    const xLabels = svg.match(/<text[^>]*y="106"[^>]*>/g) ?? [];
    expect(xLabels.length).toBeLessThanOrEqual(4);
    expect(xLabels.length).toBeGreaterThan(1);
    expect(svg).toContain('09-18');
  });

  it('文本节点全转义：日期以外的一切都不拼裸标签', () => {
    const svg = renderTrendSvg({ labels: ['<script>x</script>'], values: [1] });
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;');
  });
});
