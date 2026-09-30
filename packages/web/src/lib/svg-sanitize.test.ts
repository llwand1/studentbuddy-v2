// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeSvgDom, scopeCss, safeStyleAttr, isUnsafeValue, safeSvgHref } from './svg-sanitize';
import { ALLOWED_ELEMENTS, SVG_NS } from './svg-allowlist';
import { renderChartSvg, renderTrendSvg } from './chart-utils';

/** 与注入点同一套解析：div.innerHTML（React dangerouslySetInnerHTML 的落点）。 */
function parseAsSink(out: string): Element[] {
  const div = document.createElement('div');
  div.innerHTML = out;
  return Array.from(div.querySelectorAll('*'));
}

describe('白名单净化 sanitizeSvgDom —— 攻击语料（每条都是一类真实招式）', () => {
  const CORPUS: Array<[string, string, (out: string) => boolean]> = [
    ['script 整棵子树', '<svg><script>alert(1)</script><rect/></svg>', (o) => !o.includes('alert') && o.includes('<rect')],
    ['SVG 命名空间里的 script 变体大小写', '<svg><SCRIPT>alert(1)</SCRIPT></svg>', (o) => !o.includes('alert')],
    ['foreignObject 里的 HTML', '<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>', (o) => !o.includes('img') && !o.includes('onerror')],
    ['desc 是 HTML 集成点：里面的 <img> 是真 HTML 元素', '<svg><desc><img src=x onerror=alert(1)></desc></svg>', (o) => !o.includes('<img') && !o.includes('onerror')],
    ['title 同理，且文本保留', '<svg><title>标题<iframe src=x></iframe></title></svg>', (o) => o.includes('标题') && !o.includes('iframe')],
    ['非 javascript 协议：data:text/html 链接', '<svg><a href="data:text/html,<script>alert(1)</script>"><text>x</text></a></svg>', (o) => !o.includes('data:')],
    ['vbscript: 与大小写混排', '<svg><a href="VbScRiPt:msgbox(1)"><text>x</text></a></svg>', (o) => !/href/i.test(o)],
    ['实体编码的 javascript:', '<svg><a href="java&#115;cript:alert(1)"><text>x</text></a></svg>', (o) => !/javascript/i.test(o) && !/href/i.test(o)],
    ['制表符切开的协议', '<svg><a href="jav\tascript:alert(1)"><text>x</text></a></svg>', (o) => !/href/i.test(o)],
    ['xlink:href 走同一条策略', '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>', (o) => !/javascript/i.test(o)],
    ['use 只允许片段引用', '<svg><use href="data:image/svg+xml;base64,PHN2Zz4=#x"/><use href="#ok"/></svg>', (o) => !o.includes('data:') && o.includes('href="#ok"')],
    ['SMIL 把 href 动画成危险值', '<svg><a href="#a"><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>', (o) => !o.includes('animate') && !o.includes('javascript')],
    ['set 改事件属性', '<svg><rect><set attributeName="onmouseover" to="alert(1)"/></rect></svg>', (o) => !o.includes('<set') && !o.includes('alert')],
    ['合法的 SMIL 保留', '<svg><circle r="1"><animate attributeName="r" from="1" to="9" dur="1s"/></circle></svg>', (o) => o.includes('<animate') && o.includes('attributeName="r"')],
    ['style 元素 @import 外呼', '<svg><style>@import url(https://evil.test/x.css);</style><rect/></svg>', (o) => !o.includes('<style') && !o.includes('evil.test')],
    ['style 元素全页泄漏被限定作用域', '<svg><style>body{display:none} .a{fill:red}</style><rect class="a"/></svg>', (o) => /svg\[data-sb-scope="[a-z0-9]+"\]/.test(o) && /:is\(body\)/.test(o)],
    ['style 属性里的外链 url()', '<svg><rect style="fill:url(https://evil.test/p.svg#g)"/></svg>', (o) => !o.includes('evil.test') && !o.includes('style=')],
    ['style 属性里的 expression()', '<svg><rect style="width:expression(alert(1))"/></svg>', (o) => !o.includes('expression')],
    ['fill 属性外链画笔服务器', '<svg><rect fill="url(https://evil.test/p.svg#g)"/><rect fill="url(#g)"/></svg>', (o) => !o.includes('evil.test') && o.includes('fill="url(#g)"')],
    ['image 外链信标', '<svg><image href="https://evil.test/b.png"/><image xlink:href="https://evil.test/c.png"/></svg>', (o) => !o.includes('evil.test') && !o.includes('<image')],
    ['feImage 外链', '<svg><filter id="f"><feImage href="https://evil.test/x.png"/><feGaussianBlur stdDeviation="2"/></filter></svg>', (o) => !o.includes('feImage') && o.includes('feGaussianBlur')],
    ['事件属性各种写法', '<svg onload="alert(1)"><rect ONCLICK="x" onMouseOver=\'y\' on="z"/></svg>', (o) => !/\son/i.test(o)],
    ['HTML 元素直接塞进 svg', '<svg><iframe src="javascript:alert(1)"></iframe><object data="x"></object><embed src="x"/><math><mtext></mtext></math></svg>', (o) => !/iframe|object|embed|math/.test(o)],
    ['嵌套 svg 里的 script', '<svg><svg><script>alert(1)</script><rect/></svg></svg>', (o) => !o.includes('alert') && o.includes('<rect')],
    ['注释与处理指令不留', '<svg><!-- <script>alert(1)</script> --><?xml-stylesheet href="https://evil.test/x.css"?><rect/></svg>', (o) => !o.includes('evil.test') && !o.includes('<!--')],
    ['CDATA 里的标签只是文本', '<svg><text><![CDATA[<script>alert(1)</script>]]></text></svg>', (o) => !o.includes('<script') && parseAsSink(o).every((e) => e.localName !== 'script')],
    ['未登记元素整棵删（含子树里的合法元素）', '<svg><unknownTag><rect id="inside"/></unknownTag><rect id="outside"/></svg>', (o) => !o.includes('inside') && o.includes('outside')],
    ['反斜杠转义绕过 CSS 关键字', '<svg><style>.a{background:u\\72l(https://evil.test)}</style></svg>', (o) => !o.includes('evil.test') && !o.includes('<style')],
  ];

  for (const [name, dirty, check] of CORPUS) {
    it(name, () => {
      const out = sanitizeSvgDom(dirty);
      expect(check(out), `output: ${out}`).toBe(true);
    });
  }

  it('注入点复读：净化输出里每个元素都在白名单且属 SVG 命名空间，没有任何 on* 属性', () => {
    for (const [, dirty] of CORPUS) {
      for (const el of parseAsSink(sanitizeSvgDom(dirty))) {
        expect(el.namespaceURI).toBe(SVG_NS);
        expect(ALLOWED_ELEMENTS.has(el.localName.toLowerCase())).toBe(true);
        for (const a of Array.from(el.attributes)) expect(a.name.toLowerCase().startsWith('on')).toBe(false);
      }
    }
  });
});

describe('白名单净化 —— 正常画图能力不误伤（回归护栏）', () => {
  it('```chart 自绘输出逐元素逐属性存活', () => {
    const svg = renderChartSvg({ type: 'bar', title: '销量', labels: ['一', '二', '三'], values: [3, 5, 2] });
    const out = sanitizeSvgDom(svg);
    const before = parseAsSink(svg);
    const after = parseAsSink(out);
    expect(after.map((e) => e.localName)).toEqual(before.map((e) => e.localName));
    before.forEach((el, i) => {
      for (const a of Array.from(el.attributes)) expect(after[i]?.getAttribute(a.name)).toBe(a.value);
    });
  });

  it('督促趋势折线同样完整存活', () => {
    const svg = renderTrendSvg({ labels: ['09-01', '09-02', '09-03'], values: [1, 4, 2] });
    expect(svg).not.toBe('');
    expect(parseAsSink(sanitizeSvgDom(svg)).length).toBe(parseAsSink(svg).length);
  });

  it('渐变 / 标记 / 裁剪 / 文本路径 / 主题变量 / 片段引用全部保留（xlink:href 归一成裸 href，输出不含 xlink 命名空间）', () => {
    const svg =
      '<svg viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
      '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f00"/></linearGradient>' +
      '<marker id="m" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto"><path d="M0 0L4 2L0 4z"/></marker>' +
      '<clipPath id="c"><rect width="50" height="50"/></clipPath><path id="p" d="M0 40 Q50 0 100 40"/></defs>' +
      '<rect fill="url(#g)" clip-path="url(#c)" stroke="var(--sb-ink)" width="100" height="50"/>' +
      '<line x1="0" y1="0" x2="10" y2="10" marker-end="url(#m)"/>' +
      '<text font-family="Verdana, sans-serif" text-anchor="middle"><textPath xlink:href="#p">曲线上的字</textPath></text>' +
      '<use href="#p" transform="translate(1 2) rotate(3)"/><a href="https://example.com/doc"><text>外链</text></a></svg>';
    const out = sanitizeSvgDom(svg);
    for (const must of [
      'linearGradient', 'stop-color="#f00"', 'marker', 'clipPath', 'fill="url(#g)"', 'clip-path="url(#c)"',
      'stroke="var(--sb-ink)"', 'marker-end="url(#m)"', '<textPath href="#p"', '<use href="#p"', 'transform="translate(1 2) rotate(3)"',
      'href="https://example.com/doc"', 'target="_blank"', 'rel="noopener noreferrer"', '曲线上的字',
    ]) {
      expect(out, `missing ${must}`).toContain(must);
    }
    expect(out).not.toContain('xlink');
  });

  it('合法 <style> 保留且被限定作用域（复选 / 逗号选择器不拆），根上挂 data-sb-scope', () => {
    const out = sanitizeSvgDom('<svg><style>.a, .b > rect { fill: red } text { font-size: 12px }</style><rect class="a"/></svg>');
    const token = /data-sb-scope="([a-z0-9]+)"/.exec(out)?.[1];
    expect(token).toBeTruthy();
    const prefix = `:where(svg[data-sb-scope="${token}"], svg[data-sb-scope="${token}"] *)`;
    expect(out).toContain(`${prefix}:is(.a, .b &gt; rect) { fill: red }`);
    expect(out).toContain(`${prefix}:is(text) { font-size: 12px }`);
    // 注入点复读：文本里的 &gt; 解回 >，选择器仍是合法 CSS
    const style = parseAsSink(out).find((e) => e.localName === 'style');
    expect(style?.textContent).toContain('.b > rect');
  });

  it('幂等：净化两次 === 净化一次（作用域令牌沿用、前缀不叠加）', () => {
    const once = sanitizeSvgDom('<svg><style>.a{fill:red}</style><a href="https://x.test"><text>t</text></a><rect onclick="x"/></svg>');
    expect(sanitizeSvgDom(once)).toBe(once);
  });

  it('输出是良构 XML（blob: 独立文档那条路读到同一棵树），且不带重复 xmlns', () => {
    const out = sanitizeSvgDom('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect/><text>a &lt; b</text></svg>');
    const xml = new DOMParser().parseFromString(out, 'image/svg+xml');
    expect(xml.querySelector('parsererror')).toBeNull();
    expect(xml.documentElement.localName).toBe('svg');
    expect((out.match(/xmlns="/g) ?? []).length).toBe(1);
  });

  it('没有 <svg> 根 / 空输入 → 空串（调用方走降级卡），绝不抛', () => {
    expect(sanitizeSvgDom('')).toBe('');
    expect(sanitizeSvgDom('<div>not svg</div>')).toBe('');
    expect(sanitizeSvgDom('<svg')).toBe('');
  });
});

describe('值策略纯函数', () => {
  it('isUnsafeValue：协议 / 表达式 / 外链 url() 为真，片段 url(#) 与 var() 为假', () => {
    for (const bad of ['javascript:x', ' JAVA\nSCRIPT:x', 'data:text/html', 'expression(1)', 'url(https://x)', "url( 'http://x' )", 'a url(x.svg#g)'])
      expect(isUnsafeValue(bad), bad).toBe(true);
    for (const ok of ['url(#g)', "url('#g')", 'var(--sb-ink)', '#f00', 'M0 0 L1 1', 'translate(1,2)', '0;1;0'])
      expect(isUnsafeValue(ok), ok).toBe(false);
  });

  it('safeSvgHref：a 上放行 http(s)/mailto/#，其余元素只放行 #', () => {
    expect(safeSvgHref('a', 'https://x.test/p')).toBe('https://x.test/p');
    expect(safeSvgHref('a', '#frag')).toBe('#frag');
    expect(safeSvgHref('a', '//x.test')).toBeNull();
    expect(safeSvgHref('use', 'https://x.test/p.svg#g')).toBeNull();
    expect(safeSvgHref('use', '#g')).toBe('#g');
  });

  it('safeStyleAttr / scopeCss：@ 规则、外链、转义、花括号嵌套一律拒', () => {
    expect(safeStyleAttr('fill:red;stroke:var(--sb-ink)')).toBe(true);
    expect(safeStyleAttr('fill:url(#g)')).toBe(true);
    expect(safeStyleAttr('background:url(https://x)')).toBe(false);
    expect(safeStyleAttr('a{b}')).toBe(false);
    expect(scopeCss('@media screen { .a { fill: red } }', 'P')).toBeNull();
    expect(scopeCss('.a { .b { fill: red } }', 'P')).toBeNull();
    expect(scopeCss('.a { fill: red } /* c */ .b{stroke:blue}', 'P')).toBe('P:is(.a) { fill: red }\nP:is(.b) { stroke:blue }');
    expect(scopeCss('', 'P')).toBe('');
  });
});
