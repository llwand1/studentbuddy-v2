// @vitest-environment jsdom
/**
 * svg-sanitize 模糊测试（确定性种子，CI 可复现）。
 *
 * 不是「跑很多随机输入看会不会崩」那种，而是**带判定器**的：每个输出都要过五条不变量——
 *   ① 不抛；输出要么空串、要么以 <svg 开头
 *   ② 按注入点同一套解析器（div.innerHTML）复读：每个元素属 SVG 命名空间且在白名单、无 on*、
 *      href 只在 a 上放行外链、其余属性值都过 isUnsafeValue、style 属性过 safeStyleAttr、
 *      <style> 内容无 @ / 外链 url / 反斜杠 / `<` 且每条规则带本图作用域前缀、SMIL 目标在白名单
 *   ③ 解析器差异：同一串按 XML（blob: 独立文档那条路）解析必须良构，且元素名序列与 HTML 解析一致
 *   ④ 幂等：sanitize(out) === out
 *   ⑤ 单次耗时线性可控（大输入不钉死主线程）
 * 语料生成器专挑坏的：危险元素 / 事件属性 / 各种协议与编码 / SMIL 改 href / CSS 外呼 / HTML 集成点 /
 * 命名空间混排 / 半截标签 / 随机字节级突变。迭代数默认 300，`SB_FUZZ_ITERS=5000` 可本地加深。
 */
import { describe, it, expect } from 'vitest';
import { sanitizeSvgDom, isUnsafeValue, safeStyleAttr } from './svg-sanitize';
import { ALLOWED_ELEMENTS, ANIMATABLE_ATTRS, LINK_SCHEMES, SVG_NS } from './svg-allowlist';

/** mulberry32：32 位种子的确定性 PRNG（够用、可复现、零依赖）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260930;
const ITERS = Number(process.env.SB_FUZZ_ITERS ?? 300);

const ELEMENTS = [
  'svg', 'g', 'rect', 'circle', 'text', 'tspan', 'a', 'path', 'defs', 'use', 'style', 'title', 'desc',
  'linearGradient', 'stop', 'clipPath', 'marker', 'filter', 'feGaussianBlur', 'animate', 'set', 'animateTransform',
  'script', 'SCRIPT', 'foreignObject', 'image', 'feImage', 'iframe', 'object', 'embed', 'img', 'math', 'video',
  'audio', 'link', 'meta', 'base', 'form', 'input', 'template', 'noscript', 'xss', 'svg:script', 'annotation-xml',
];
const SCHEMES = [
  'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java&#115;cript:alert(1)', 'java&#x73;cript:alert(1)',
  'jav\tascript:alert(1)', 'jav&#x09;ascript:alert(1)', 'jav&NewLine;ascript:alert(1)', ' javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>', 'data:image/svg+xml;base64,PHN2Zz4=', 'vbscript:msgbox(1)',
  'https://evil.test/x', 'http://evil.test/x', '//evil.test/x', '/\\evil.test', 'mailto:a@b.c', '#frag', '#',
  'blob:https://11wand.com/x', 'file:///etc/passwd', 'ftp://x', '\u0001javascript:alert(1)',
];
const ATTRS = [
  'id', 'class', 'x', 'y', 'width', 'height', 'fill', 'stroke', 'd', 'viewBox', 'transform', 'opacity',
  'onload', 'onclick', 'ONERROR', 'onmouseover', 'onbegin', 'onfocusin', 'on', 'href', 'xlink:href', 'XLINK:HREF',
  'style', 'attributeName', 'values', 'to', 'from', 'begin', 'src', 'data', 'srcdoc', 'formaction', 'xmlns',
  'xmlns:xlink', 'xml:space', 'data-x', 'aria-label', 'filter', 'clip-path', 'mask', 'marker-end', 'font-family',
];
const VALUES = [
  '1', '10', 'red', '#000', 'var(--sb-ink)', 'url(#g)', 'url(https://evil.test/p.svg#g)', "url('//evil.test')",
  'expression(alert(1))', 'M0 0L1 1', 'translate(1 2)', 'r', 'href', 'onmouseover', 'fill', 'style', 'class',
  'alert(1)', '"', "'", '<', '>', '&', '&lt;script&gt;', '&#60;script&#62;', '\u0000', 'a;b', '中文', '',
  ...SCHEMES,
];
const CSS = [
  '.a{fill:red}', 'text{font-size:12px}', 'body{display:none}', '@import url(https://evil.test/x.css);',
  '@font-face{src:url(https://evil.test/f.woff)}', '.a{background:url(https://evil.test/b.png)}',
  '.a{background:u\\72l(https://evil.test)}', '.a{width:expression(alert(1))}', '.a{fill:url(#g)}',
  '.a{} </style><script>alert(1)</script>', '.a{fill:red}}.b{', ':root{--x:1}', '.a,.b>rect{stroke:blue}',
  '.a{behavior:url(x.htc)}', '.a{-moz-binding:url(https://evil.test/x.xml#b)}', '/* c */ .a{fill:red}',
];
const TEXTS = [
  'hi', '中文', '<script>alert(1)</script>', '</style><img src=x onerror=alert(1)>', '<![CDATA[<b>x</b>]]>',
  '<!-- c -->', '&lt;', '&', '&amp;', ']]>', '<?xml-stylesheet href="https://evil.test/x.css"?>', '"', "'", '<', '>',
  '<img src=x onerror=alert(1)>', '<iframe src="javascript:alert(1)">', '&#60;svg onload=alert(1)&#62;',
];

/** 语料生成器：随机深度的元素树 + 危险属性 + 随机文本，最后可选字节级突变。 */
function genSvg(rnd: () => number): string {
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)] as T;
  const genAttrs = (): string => {
    let s = '';
    const n = Math.floor(rnd() * 4);
    for (let i = 0; i < n; i += 1) {
      const q = rnd() < 0.8 ? '"' : rnd() < 0.5 ? "'" : '';
      s += ` ${pick(ATTRS)}=${q}${pick(VALUES)}${q}`;
    }
    return s;
  };
  const genEl = (depth: number): string => {
    const tag = pick(ELEMENTS);
    const attrs = genAttrs();
    if (tag === 'style') return `<style${attrs}>${pick(CSS)}</style>`;
    if (rnd() < 0.2) return `<${tag}${attrs}/>`;
    let inner = '';
    const kids = depth > 3 ? 0 : Math.floor(rnd() * 3);
    for (let i = 0; i < kids; i += 1) inner += rnd() < 0.3 ? pick(TEXTS) : genEl(depth + 1);
    const close = rnd() < 0.9 ? `</${tag}>` : '';
    return `<${tag}${attrs}>${inner}${close}`;
  };
  let body = '';
  const n = 1 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i += 1) body += genEl(1);
  const rootAttrs = rnd() < 0.5 ? ' xmlns="http://www.w3.org/2000/svg"' : '';
  let doc = rnd() < 0.15 ? body : `<svg${rootAttrs}${genAttrs()}>${body}</svg>`;
  if (rnd() < 0.3) {
    // 字节级突变：删一个字符 / 插入一个结构字符
    const at = Math.floor(rnd() * doc.length);
    doc = rnd() < 0.5 ? doc.slice(0, at) + doc.slice(at + 1) : doc.slice(0, at) + pick(['<', '>', '"', "'", '&', '/', '\u0000', '=']) + doc.slice(at);
  }
  return doc;
}

const SCOPE_RE = /^:where\(svg\[data-sb-scope="([a-z0-9]+)"\], svg\[data-sb-scope="\1"\] \*\):is\(/;

function sinkParse(out: string): Element[] {
  const div = document.createElement('div');
  div.innerHTML = out;
  return Array.from(div.querySelectorAll('*'));
}

/** 判定器：对一份净化输出跑全部不变量，返回违规描述列表（空即通过）。 */
function judge(out: string): string[] {
  const bad: string[] = [];
  if (out === '') return bad;
  if (!out.startsWith('<svg')) bad.push('output does not start with <svg');
  const els = sinkParse(out);
  const root = els[0];
  const token = root?.getAttribute('data-sb-scope');
  for (const el of els) {
    const tag = el.localName.toLowerCase();
    if (el.namespaceURI !== SVG_NS) bad.push(`non-svg namespace element <${el.localName}>`);
    if (!ALLOWED_ELEMENTS.has(tag)) bad.push(`element not in allowlist <${el.localName}>`);
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) bad.push(`event attribute ${a.name}`);
      else if (name === 'href' || name === 'xlink:href') {
        const okHref = a.value.startsWith('#') || (tag === 'a' && LINK_SCHEMES.test(a.value));
        if (!okHref) bad.push(`href not allowed on <${tag}>: ${a.value}`);
      } else if (name === 'style') {
        if (!safeStyleAttr(a.value)) bad.push(`unsafe style attr: ${a.value}`);
      } else if (name !== 'target' && name !== 'rel' && isUnsafeValue(a.value)) bad.push(`unsafe value ${a.name}=${a.value}`);
    }
    if (tag === 'style') {
      const css = el.textContent ?? '';
      if (/[<\\]|@|expression\s*\(/i.test(css)) bad.push(`style content: ${css}`);
      if (/url\s*\(\s*["']?\s*(?!#)[^)"'\s]/i.test(css)) bad.push(`external url in style: ${css}`);
      for (const rule of css.split('\n').filter((l) => l.trim())) {
        const m = SCOPE_RE.exec(rule);
        if (!m || m[1] !== token) bad.push(`unscoped rule: ${rule}`);
      }
    }
    if (tag === 'animate' || tag === 'set' || tag === 'animatetransform') {
      const target = (el.getAttribute('attributeName') ?? '').toLowerCase();
      if (!ANIMATABLE_ATTRS.has(target)) bad.push(`SMIL target ${target}`);
    }
  }
  // 解析器差异：XML 那条路必须良构且元素序列一致
  const xml = new DOMParser().parseFromString(out, 'image/svg+xml');
  if (xml.querySelector('parsererror')) bad.push('output is not well-formed XML');
  else {
    const xmlSeq = Array.from(xml.querySelectorAll('*')).map((e) => e.localName.toLowerCase()).join(',');
    const htmlSeq = els.map((e) => e.localName.toLowerCase()).join(',');
    if (xmlSeq !== htmlSeq) bad.push(`parser differential: html=[${htmlSeq}] xml=[${xmlSeq}]`);
  }
  if (sanitizeSvgDom(out) !== out) bad.push('not idempotent');
  return bad;
}

describe(`svg-sanitize fuzz（seed=${SEED}, iters=${ITERS}）`, () => {
  it('判定器自检：一张已知坏图必须被判红（判定器不空转）', () => {
    expect(judge('<svg><script>alert(1)</script></svg>').length).toBeGreaterThan(0);
    expect(judge('<svg><a href="javascript:alert(1)"/></svg>').length).toBeGreaterThan(0);
    expect(judge('<svg><style>.a{fill:red}</style></svg>').length).toBeGreaterThan(0);
    expect(judge('<svg><rect fill="url(https://evil.test/x)"/></svg>').length).toBeGreaterThan(0);
  });

  it('生成语料全部通过五条不变量', () => {
    const rnd = mulberry32(SEED);
    const failures: string[] = [];
    let nonEmpty = 0;
    for (let i = 0; i < ITERS; i += 1) {
      const input = genSvg(rnd);
      let out = '';
      try {
        out = sanitizeSvgDom(input);
      } catch (e) {
        failures.push(`#${i} threw: ${String(e)}\n  input: ${input}`);
        continue;
      }
      if (out) nonEmpty += 1;
      const bad = judge(out);
      if (bad.length) failures.push(`#${i} ${bad.join('; ')}\n  input: ${input}\n  output: ${out}`);
    }
    expect(failures, failures.slice(0, 5).join('\n\n')).toEqual([]);
    // 语料不能全被打成空串——否则判定器什么都没检查
    expect(nonEmpty).toBeGreaterThan(ITERS * 0.5);
  });

  it('大输入线性完成：4 万字符脚本 + 2000 个矩形 < 1s', () => {
    const big = '<svg>' + '<script>' + 'x'.repeat(40_000) + '</script><script>' + '<rect/>'.repeat(2000) + '</svg>';
    const t0 = Date.now();
    const out = sanitizeSvgDom(big);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out).not.toContain('xxxx');
  });
});
