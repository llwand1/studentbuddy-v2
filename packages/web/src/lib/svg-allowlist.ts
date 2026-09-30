// svg-allowlist.ts —— 模型产出 SVG 的**白名单**（只有数据，没有逻辑；逻辑在 svg-sanitize.ts）。
//
// 立场：这里渲染的是**不可信内容**（```svg / ```chart 围栏来自模型），而且落点是 innerHTML——
// 与应用同源、同 DOM、同 CSS 作用域。黑名单（剥 script/on*/javascript:）挡得住已知招式，
// 挡不住「我没想到的那一种」：非 javascript 协议、SMIL 把 href 动画成危险值、`<style>` 泄到全页、
// `fill="url(https://…)"` 外呼、`<desc>` 这类 HTML 集成点里藏 HTML 元素……
// 白名单的性质相反：**没登记的一律不进**，新招式默认被挡，代价是画图能力要在这里逐项登记。
//
// 登记原则：只收「画图会用到」的元素/属性；任何会**发网络请求**（image/feImage/外链 href/url(…)）、
// **执行代码**（script/事件属性/javascript:）、**引入外部命名空间**（foreignObject/HTML 元素）的，一概不收。

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** 允许的 SVG 元素（全部小写比较；HTML 解析器已把 linearGradient 等大小写归一）。 */
export const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  // 结构
  'svg', 'g', 'defs', 'symbol', 'use', 'switch', 'view', 'title', 'desc', 'metadata',
  // 几何
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  // 文本
  'text', 'tspan', 'textpath', 'a',
  // 绘制服务器 / 裁剪 / 遮罩 / 标记
  'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask', 'marker',
  // 滤镜（★ 刻意不收 feImage：它会加载外部资源）
  'filter', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix',
  'fediffuselighting', 'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood',
  'fefunca', 'fefuncb', 'fefuncg', 'fefuncr', 'fegaussianblur', 'femerge', 'femergenode',
  'femorphology', 'feoffset', 'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile',
  'feturbulence',
  // 样式（内容另行过滤 + 作用域限定，见 svg-sanitize.ts）
  'style',
  // SMIL 动画（attributeName 另行白名单，见 ANIMATABLE_ATTRS）
  'animate', 'animatemotion', 'animatetransform', 'set', 'mpath',
]);

/**
 * 允许的属性（全部小写比较）。`href`/`xlink:href`/`style` 不在此表——它们走专门的值策略；
 * `xmlns` / `xmlns:*` 也不在——命名空间声明由序列化器按元素真实命名空间重新生成，不信模型写的。
 */
export const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  // 通用
  'id', 'class', 'lang', 'tabindex', 'role', 'xml:space', 'xml:lang', 'version', 'baseprofile',
  // 根/视口
  'viewbox', 'preserveaspectratio', 'width', 'height', 'x', 'y', 'overflow',
  // 几何
  'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'd', 'points', 'pathlength',
  'dx', 'dy', 'rotate', 'textlength', 'lengthadjust', 'startoffset', 'method', 'spacing', 'side',
  'transform', 'transform-origin',
  // 呈现属性
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity',
  'color', 'visibility', 'display', 'paint-order', 'vector-effect', 'shape-rendering',
  'text-rendering', 'image-rendering', 'color-interpolation', 'color-interpolation-filters',
  'mix-blend-mode', 'isolation', 'pointer-events', 'cursor',
  // 文本呈现
  'font-family', 'font-size', 'font-size-adjust', 'font-style', 'font-weight', 'font-variant',
  'font-stretch', 'letter-spacing', 'word-spacing', 'text-anchor', 'text-decoration',
  'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'writing-mode', 'direction',
  'unicode-bidi', 'white-space',
  // 引用型呈现属性（值必须是 url(#…) 片段引用，见 svg-sanitize.ts）
  'clip-path', 'clip-rule', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end',
  // 渐变 / 图案 / 裁剪 / 遮罩 / 标记的参数
  'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod',
  'fx', 'fy', 'fr', 'patternunits', 'patterncontentunits', 'patterntransform',
  'clippathunits', 'maskunits', 'maskcontentunits',
  'markerwidth', 'markerheight', 'refx', 'refy', 'orient', 'markerunits',
  // 滤镜参数
  'filterunits', 'primitiveunits', 'in', 'in2', 'result', 'stddeviation', 'flood-color',
  'flood-opacity', 'lighting-color', 'mode', 'type', 'values', 'operator', 'k1', 'k2', 'k3', 'k4',
  'scale', 'xchannelselector', 'ychannelselector', 'radius', 'order', 'kernelmatrix',
  'divisor', 'bias', 'targetx', 'targety', 'edgemode', 'kernelunitlength', 'preservealpha',
  'surfacescale', 'diffuseconstant', 'specularconstant', 'specularexponent', 'azimuth',
  'elevation', 'z', 'pointsatx', 'pointsaty', 'pointsatz', 'limitingconeangle',
  'basefrequency', 'numoctaves', 'seed', 'stitchtiles', 'tablevalues', 'slope', 'intercept',
  'amplitude', 'exponent',
  // SMIL 时序与取值
  'attributename', 'attributetype', 'from', 'to', 'by', 'dur', 'begin', 'end', 'repeatcount',
  'repeatdur', 'restart', 'min', 'max', 'calcmode', 'keytimes', 'keysplines', 'keypoints',
  'additive', 'accumulate', 'path',
]);

/** 允许通过 SMIL 动画驱动的目标属性：只有几何与呈现类；href/style/class/事件一律不许被动画改写。 */
export const ANIMATABLE_ATTRS: ReadonlySet<string> = new Set([
  'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'd', 'points',
  'dx', 'dy', 'rotate', 'offset', 'transform', 'gradienttransform', 'patterntransform',
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-dashoffset', 'opacity', 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity',
  'font-size', 'letter-spacing', 'visibility', 'display', 'stddeviation', 'scale', 'values',
  'basefrequency', 'seed', 'k1', 'k2', 'k3', 'k4', 'startoffset', 'viewbox',
]);

/** `<a>` 上允许的外链协议（其余元素的 href 只允许 `#片段` 内部引用）。 */
export const LINK_SCHEMES = /^(?:https?:|mailto:)/i;
