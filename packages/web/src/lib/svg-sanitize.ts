// svg-sanitize.ts —— 模型产出 SVG 的白名单净化器（DOM 遍历，O(n)）。
//
// 数据流：字符串 → **HTML 解析器**建树（与 innerHTML 注入点同一套解析器，消灭「净化时按 XML 解析、
// 注入时按 HTML 解析」的解析器差异）→ 白名单遍历（元素 / 属性 / 属性值 / CSS）→ XMLSerializer 序列化
// （输出是良构 XML：innerHTML 与 blob: 独立文档两条路读到的是同一棵树；文本里的 `<` 一律成 `&lt;`）。
//
// 四条硬规则（对应 docs/UNTRUSTED-RENDER-SPEC.md §2）：
//   R1 元素：不在 svg-allowlist.ts 登记的元素**整棵子树丢弃**（含 HTML 命名空间元素、foreignObject、image、feImage）。
//   R2 属性：不在登记表的属性丢弃；on* 事件属性丢弃；属性值含 javascript:/data:/vbscript:/expression(/
//      非 `#` 片段的 url(…) 一律丢弃（fill="url(https://…)" 是外呼，fill="url(#g)" 是合法引用）。
//   R3 链接：href / xlink:href 只在 `<a>` 上允许 http(s)/mailto/#，其余元素只允许 `#片段`（use / gradient / textPath）。
//   R4 样式：style 属性与 <style> 元素同一套 CSS 过滤（禁 @ 规则 / 外链 url / expression / 反斜杠转义 / `<`），
//      且 <style> 的每条规则都被限定到本图（`:where(svg[data-sb-scope="…"], svg[data-sb-scope="…"] *):is(原选择器)`）
//      ——内联 SVG 里的 <style> 本来是全页生效的，模型一句 `body{display:none}` 就能把应用画黑。
//
// 没有 DOM（纯 node）时**关闭输出**（返回空串）而不是退回弱正则：宁可不画，也不放一张没审过的图进 innerHTML。
/* eslint-disable no-control-regex -- 控制字符正是要剥的东西：`jav\tascript:` 在属性里等于 `javascript:` */
import { ALLOWED_ATTRS, ALLOWED_ELEMENTS, ANIMATABLE_ATTRS, LINK_SCHEMES, SVG_NS } from './svg-allowlist';

/** 是否存在可用的 DOM 解析能力（浏览器 / jsdom）。 */
export function hasDom(): boolean {
  return typeof DOMParser !== 'undefined' && typeof XMLSerializer !== 'undefined';
}

/** 属性值里的「活动内容」特征：协议、CSS 表达式、以及**非片段**的 url(...)。 */
const ACTIVE_VALUE = /javascript:|vbscript:|data:|expression\s*\(|&\{|-moz-binding|behavior\s*:/i;
const EXTERNAL_URL_FUNC = /url\s*\(\s*["']?\s*(?!#)[^)"'\s]/i;

/** 只解最常见的数值实体并去掉控制字符，让 `java&#115;cript:` / `jav\tascript:` 在判定前现形。 */
function normalizeForCheck(s: string): string {
  const decoded = s.includes('&')
    ? s
        .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16) || 0))
        .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10) || 0))
        .replace(/&(?:newline|tab);/gi, '')
    : s;
  return decoded.replace(/[\u0000-\u0020]/g, '');
}

/** 属性值是否危险（所有白名单属性都过这一关，不区分属性名——攻击面在值不在名）。 */
export function isUnsafeValue(value: string): boolean {
  const v = normalizeForCheck(value);
  return ACTIVE_VALUE.test(v) || EXTERNAL_URL_FUNC.test(v);
}

/** href 策略：`<a>` 允许外链协议，其余元素只允许内部片段引用。 */
export function safeSvgHref(el: string, raw: string): string | null {
  const href = raw.replace(/[\u0000-\u0020]/g, '');
  if (href.startsWith('#')) return href;
  if (el === 'a' && LINK_SCHEMES.test(href)) return href;
  return null;
}

/** CSS 一票否决项：@ 规则（@import/@font-face 会外呼）、反斜杠转义（绕过下面所有判断）、`<`、表达式。 */
const CSS_FORBIDDEN = /[<\\]|@|expression\s*\(|javascript:|-moz-binding|behavior\s*:/i;
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** style 属性：通过则原样保留，否则整条丢弃（不做逐条声明的救回——救回逻辑本身就是新的攻击面）。 */
export function safeStyleAttr(css: string): boolean {
  const s = stripCssComments(css);
  return !CSS_FORBIDDEN.test(s) && !EXTERNAL_URL_FUNC.test(s) && !/[{}]/.test(s);
}

/**
 * `<style>` 内容：先一票否决，再把每条规则限定到本图。
 * 返回 null 表示这段样式不可救（调用方删掉整个 <style>）。
 * 只认「选择器列表 { 声明 }」的扁平语法；嵌套花括号一律拒——@media 之类已被 `@` 一关挡掉。
 * 用 `:where(scope):is(list)` 包整条选择器列表而不是逐个加前缀：不必拆逗号（`:is(a, b)` / `[x="a,b"]` 里也有逗号），
 * `:where` 零特异度 ⇒ 规则间的层叠顺序与原样式一致。
 */
export function scopeCss(css: string, scopePrefix: string): string | null {
  const stripped = stripCssComments(css);
  if (CSS_FORBIDDEN.test(stripped) || EXTERNAL_URL_FUNC.test(stripped)) return null;
  const out: string[] = [];
  for (const part of stripped.split('}')) {
    if (!part.trim()) continue;
    const brace = part.indexOf('{');
    if (brace < 0 || part.indexOf('{', brace + 1) >= 0) return null;
    const selector = part.slice(0, brace).trim();
    const decl = part.slice(brace + 1).trim();
    if (!selector) return null;
    const scoped = selector.startsWith(scopePrefix) ? selector : `${scopePrefix}:is(${selector})`;
    out.push(`${scoped} { ${decl} }`);
  }
  return out.join('\n');
}

/** aria-* / data-* 放行，但名字必须是合法 XML 名（HTML 解析器接受 `aria-&label` 这种名，XMLSerializer 会原样吐出——fuzz 逮到的）。 */
const CUSTOM_ATTR = /^(?:aria|data)-[a-z0-9_.-]+$/;

/** XML 1.0 不许出现的控制字符：HTML 解析器放行、XML 解析器直接报错 ⇒ 序列化前剥掉（fuzz 逮到的解析器差异）。 */
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

const SMIL = new Set(['animate', 'set', 'animatetransform', 'animatemotion']);
const TEXT_ONLY = new Set(['title', 'desc', 'metadata']);
const SCOPE_ATTR = 'data-sb-scope';

let scopeCounter = 0;
/** 本图作用域令牌：已净化过的图沿用旧令牌（保证 sanitize 幂等），否则新发一个。 */
function scopeToken(root: Element): string {
  const existing = root.getAttribute(SCOPE_ATTR);
  if (existing && /^[a-z0-9]{4,24}$/.test(existing)) return existing;
  scopeCounter += 1;
  return `s${scopeCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 对单个元素做属性白名单；返回 false 表示元素本身该被删掉（SMIL 目标非法 / 样式不可救）。 */
function cleanAttributes(el: Element, tag: string, scopePrefix: string): boolean {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    if (name.startsWith('on') || name === 'xmlns' || name.startsWith('xmlns:')) {
      // 事件属性；以及**所有命名空间声明**——序列化器会按元素真实命名空间重新生成声明，
      // 模型写的 `xmlns:xlink=""` / `xmlns="data:…"` 留着只会让 XML 那条路解析失败或换命名空间（fuzz 逮到的）
      el.removeAttribute(attr.name);
    } else if (name === 'href' || name === 'xlink:href') {
      // xlink:href 统一归一成 SVG2 的裸 href：输出里不再出现 xlink 命名空间，
      // 免得序列化器为未声明前缀造出 `ns1:href`——HTML 解析器读回来就成了一个叫「ns1:href」的普通属性
      const safe = safeSvgHref(tag, value);
      if (safe === null) el.removeAttribute(attr.name);
      else if (name !== 'href' || safe !== value) {
        el.removeAttribute(attr.name);
        if (!el.hasAttribute('href')) el.setAttribute('href', safe);
      }
    } else if (name === 'style') {
      if (!safeStyleAttr(value)) el.removeAttribute(attr.name);
    } else if (name === SCOPE_ATTR) {
      if (tag !== 'svg' || el.parentElement) el.removeAttribute(attr.name);
    } else if (!ALLOWED_ATTRS.has(name) && !CUSTOM_ATTR.test(name)) {
      el.removeAttribute(attr.name);
    } else if (isUnsafeValue(value)) {
      el.removeAttribute(attr.name);
    } else if (XML_ILLEGAL.test(value)) {
      el.setAttribute(attr.name, value.replace(XML_ILLEGAL, ''));
    }
  }
  if (SMIL.has(tag) && tag !== 'animatemotion') {
    const target = (el.getAttribute('attributeName') ?? '').toLowerCase();
    if (!ANIMATABLE_ATTRS.has(target)) return false;
    if (tag === 'animatetransform' && !target.endsWith('transform')) return false;
  }
  if (tag === 'style') {
    const scoped = scopeCss(el.textContent ?? '', scopePrefix);
    if (scoped === null) return false;
    el.textContent = scoped;
  }
  if (tag === 'a' && el.hasAttribute('href') && !el.getAttribute('href')?.startsWith('#')) {
    // 同源文档里的外链：新窗口 + 不带 referrer / opener（与 Markdown 链接同一口径）
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
  return true;
}

/** 深度优先净化一棵子树（删元素时连子树一起删，不做「解包保留子节点」）。 */
function cleanTree(root: Element, scopePrefix: string): void {
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    const tag = el.localName.toLowerCase();
    if (el.namespaceURI !== SVG_NS || !ALLOWED_ELEMENTS.has(tag) || !cleanAttributes(el, tag, scopePrefix)) {
      el.remove();
      continue;
    }
    if (TEXT_ONLY.has(tag)) {
      // HTML 集成点：<title>/<desc> 里的子元素会被 HTML 解析器当成 HTML 元素，一律压平成纯文本
      el.textContent = (el.textContent ?? '').replace(XML_ILLEGAL, '');
      continue;
    }
    for (const child of Array.from(el.childNodes)) {
      const t = child.nodeType;
      if (t === 1) stack.push(child as Element);
      else if (t === 3 || t === 4) {
        const v = child.nodeValue ?? '';
        if (XML_ILLEGAL.test(v)) child.nodeValue = v.replace(XML_ILLEGAL, '');
      } else child.remove(); // 注释 / 处理指令一律不留
    }
  }
}

/**
 * 净化入口：返回**良构 XML 字符串**（根为 <svg>），无 DOM / 没有 <svg> 根时返回空串。
 * 幂等：sanitizeSvgDom(sanitizeSvgDom(x)) === sanitizeSvgDom(x)（作用域令牌沿用、选择器不重复加前缀）。
 */
export function sanitizeSvgDom(svg: string): string {
  if (!hasDom()) return '';
  let root: Element | null;
  try {
    const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${svg}`, 'text/html');
    root = doc.body.querySelector('svg');
  } catch {
    return '';
  }
  if (!root || root.namespaceURI !== SVG_NS) return '';
  const token = scopeToken(root);
  const scopePrefix = `:where(svg[${SCOPE_ATTR}="${token}"], svg[${SCOPE_ATTR}="${token}"] *)`;
  root.remove();
  cleanTree(root, scopePrefix);
  if (root.querySelector('style')) root.setAttribute(SCOPE_ATTR, token);
  else root.removeAttribute(SCOPE_ATTR);
  try {
    return new XMLSerializer().serializeToString(root);
  } catch {
    return '';
  }
}
