/**
 * remend —— 流式 Markdown「未闭合记号」修补器（修补层）。
 *
 * 移植自 Vercel streamdown 的 packages/remend（MIT），按本仓自写解析器的方言裁剪：
 * 去掉 KaTeX / 比较符转义 / 单波浪转义（前两者服务数学渲染与 remarkGfm，本仓不引；
 * 后者依赖 remarkGfm 的 singleTilde 开关，本仓解析器不把单个 ~ 当删除线）。
 * 保留：围栏 / HTML 标签 / 链接与图片 / 粗体 / 粗斜体 / 斜体（双下划线·单星·单下划线）/ 行内代码 / 删除线。
 *
 * 结构对应上游：正则 = patterns.ts；下面的 handle* = 各 handler；remend() = index.ts 的优先级编排。
 * 判定层（代码区查表 / 计数 / flanking 规则）在 ./remend-lookup，对应上游 utils.ts + code-block-utils.ts。
 *
 * 调用约定：**仅流式渲染时调用**（见 Markdown.tsx）。落库、导出、复制一律用原文——
 * 补出来的尾巴进了历史就是数据污染，下次从库里读出来会多一对星号。
 */
import {
  countOutside,
  countSingleBackticks,
  countSingleStars,
  countSingleUnderscores,
  findMatchingOpen,
  hasContent,
  inCode,
  isHorizontalRule,
  isListMarkerLead,
  isWhitespace,
  isWordChar,
} from './remend-lookup';

export type LinkMode = 'protocol' | 'text-only';

export interface RemendOptions {
  /** 未闭合的 ``` 围栏补尾（本仓额外：上游把围栏补全放在组件层，不放 remend） */
  codeBlock?: boolean;
  /** 剥掉尾部半截 HTML 标签（`文字 <custom` → `文字`） */
  htmlTags?: boolean;
  /** 半截链接与图片 */
  links?: boolean;
  /** 粗体 `**` */
  bold?: boolean;
  /** 粗斜体 `***` */
  boldItalic?: boolean;
  /** 斜体 `__` `*` `_` */
  italic?: boolean;
  /** 行内代码 `` ` `` */
  inlineCode?: boolean;
  /** 删除线 `~~` */
  strikethrough?: boolean;
  /**
   * 半截链接的收口方式。默认 `'text-only'`：只留链接文字、丢掉半截 URL 标记——
   * 文字不会消失，也不会因为 URL 逐字变长而每帧重挂 <a>（上游 `'protocol'` 需渲染层把占位
   * URL 特判成不可点文字，本仓渲染层没这个配合，故默认 text-only）。
   */
  linkMode?: LinkMode;
}

// ── 正则（对齐上游 patterns.ts）──
const BOLD_ITALIC = /(\*\*\*)([^*]*?)$/;
const BOLD = /(\*\*)([^*]*\*?)$/;
const ITALIC_UNDERSCORE_PAIR = /(__)([^_]*?)$/;
const HALF_UNDERSCORE = /(__)([^_]+)_$/;
const ITALIC_STAR = /(\*)([^*]*?)$/;
const ITALIC_UNDERSCORE = /(_)([^_]*?)$/;
const INLINE_CODE = /(`)([^`]*?)$/;
const INLINE_TRIPLE_CODE = /^```[^`\n]*```?$/;
const STRIKE = /(~~)([^~]*?)$/;
const HALF_TILDE = /(~~)([^~]+)~$/;
const INCOMPLETE_HTML_TAG = /<[a-zA-Z/][^>]*$/;

/** 子串出现次数（不做代码区排除；围栏计数专用，因为查表本身依赖围栏平衡） */
const countOccur = (s: string, sub: string): number => s.split(sub).length - 1;
/** 捕获组取值：tsconfig 开了 noUncheckedIndexedAccess，一律显式兜空 */
const g = (m: RegExpExecArray, k: number): string => m[k] ?? '';

// ── handlers（按优先级从低到高执行）──

/** 未闭合围栏补尾：不补则整段代码被当成正文吞掉 */
function handleCodeFence(text: string): string {
  if (countOccur(text, '```') % 2 === 1) return text + (text.endsWith('\n') ? '```' : '\n```');
  return text;
}

/** 尾部半截 HTML 标签直接剥掉：`文字 <custom` 留着会被后续字符拼成标签或被转义显示 */
function handleHtmlTag(text: string): string {
  const m = INCOMPLETE_HTML_TAG.exec(text);
  if (!m || m.index === undefined || inCode(text, m.index)) return text;
  return text.slice(0, m.index).trimEnd();
}

/** 半截链接 / 图片：`[文字](半截URL`、`[文字` 都要收口，否则原始记号糊在屏幕上 */
function handleLinks(text: string, linkMode: LinkMode): string {
  const lastParen = text.lastIndexOf('](');
  if (lastParen !== -1 && !inCode(text, lastParen)) {
    const afterParen = text.slice(lastParen + 2);
    if (!afterParen.includes(')')) {
      const open = findMatchingOpen(text, lastParen);
      if (open !== -1 && !inCode(text, open)) {
        const isImage = open > 0 && text[open - 1] === '!';
        const before = text.slice(0, isImage ? open - 1 : open);
        const label = text.slice(open + 1, lastParen);
        if (isImage) return `${before}![${label}](sb:incomplete-image)`;
        return linkMode === 'text-only' ? `${before}${label}` : `${before}[${label}](sb:incomplete-link)`;
      }
    }
  }
  // 连 `]` 都还没到的半截链接文字
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] !== '[' || inCode(text, i)) continue;
    const after = text.slice(i + 1);
    if (after.includes(']')) continue;
    const isImage = i > 0 && text[i - 1] === '!';
    const before = text.slice(0, isImage ? i - 1 : i);
    if (isImage) return `${before}![${after}](sb:incomplete-image)`;
    return linkMode === 'text-only' ? before + after : `${text}](sb:incomplete-link)`;
  }
  return text;
}

/** 粗斜体 `***`：必须早于 `**`，否则 `***abc` 会被当成未闭合的粗体补成 `***abc**` */
function handleBoldItalic(text: string): string {
  const m = BOLD_ITALIC.exec(text);
  if (!m) return text;
  const markerIndex = text.lastIndexOf(g(m, 1));
  if (inCode(text, markerIndex)) return text;
  if (!hasContent(g(m, 2)) || isHorizontalRule(text, markerIndex, '*')) return text;
  return countOutside(text, '***') % 2 === 1 ? text + '***' : text;
}

/** 粗体 `**`；`**内容*` 这种半闭合的收尾只补一个 `*` */
function handleBold(text: string): string {
  const m = BOLD.exec(text);
  if (!m) return text;
  const markerIndex = text.lastIndexOf(g(m, 1));
  if (inCode(text, markerIndex)) return text;
  const content = g(m, 2);
  if (!hasContent(content) || isHorizontalRule(text, markerIndex, '*')) return text;
  if (isListMarkerLead(text, markerIndex) && content.includes('\n')) return text;
  if (countOutside(text, '**') % 2 !== 1) return text;
  return content.endsWith('*') ? text + '*' : text + '**';
}

/** 斜体 `__`（含 `__内容_` 半闭合） */
function handleItalicDoubleUnderscore(text: string): string {
  const pair = ITALIC_UNDERSCORE_PAIR.exec(text);
  const half = pair ? null : HALF_UNDERSCORE.exec(text);
  const first = pair ?? half;
  if (!first) return text;
  const markerIndex = text.lastIndexOf(g(first, 1));
  if (inCode(text, markerIndex)) return text;
  if (pair && !hasContent(g(pair, 2))) return text;
  if (countOutside(text, '__') % 2 !== 1) return text;
  return half ? text + '_' : text + '__';
}

/** 找第一个「可以开启强调」的单个 `*`（跳过代码区 / 转义 / 词内冷星 / 右侧空白 / 列表标记） */
function findOpenStarIndex(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '*' || inCode(text, i)) continue;
    const prev = i > 0 ? text[i - 1] ?? '' : '';
    const next = i < text.length - 1 ? text[i + 1] ?? '' : '';
    if (prev === '*' || next === '*' || prev === '\\') continue;
    if ((!prev || isWhitespace(prev)) && (!next || isWhitespace(next))) continue;
    if (prev && next && isWordChar(prev) && isWordChar(next)) continue;
    if (!next || isWhitespace(next)) continue; // 只能右闭合的记号开不了斜体
    if (isListMarkerLead(text, i)) continue;
    return i;
  }
  return -1;
}

/** 斜体 `*` */
function handleItalicStar(text: string): string {
  if (!ITALIC_STAR.test(text)) return text;
  const first = findOpenStarIndex(text);
  if (first === -1 || inCode(text, first)) return text;
  if (!hasContent(text.slice(first + 1))) return text;
  return countSingleStars(text) % 2 === 1 ? text + '*' : text;
}

/** 斜体 `_` */
function handleItalicUnderscore(text: string): string {
  const m = ITALIC_UNDERSCORE.exec(text);
  if (!m) return text;
  const markerIndex = text.lastIndexOf(g(m, 1));
  if (inCode(text, markerIndex) || !hasContent(g(m, 2))) return text;
  if (isHorizontalRule(text, markerIndex, '_')) return text;
  const prev = markerIndex > 0 ? text[markerIndex - 1] ?? '' : '';
  if (prev && isWordChar(prev)) return text;
  return countSingleUnderscores(text) % 2 === 1 ? text + '_' : text;
}

/** 行内代码 `` ` ``（含单行的 `` ```code``` ``） */
function handleInlineCode(text: string): string {
  if (INLINE_TRIPLE_CODE.test(text) && !text.includes('\n')) {
    return text.endsWith('``') && !text.endsWith('```') ? text + '`' : text;
  }
  const m = INLINE_CODE.exec(text);
  if (!m) return text;
  // 围栏还没闭合时不碰行内反引号：那多半是围栏本身，补了就成两对
  if (countOccur(text, '```') % 2 === 1 || !hasContent(g(m, 2))) return text;
  return countSingleBackticks(text) % 2 === 1 ? text + '`' : text;
}

/** 删除线 `~~`（含 `~~内容~` 半闭合） */
function handleStrikethrough(text: string): string {
  const m = STRIKE.exec(text);
  const half = m ? null : HALF_TILDE.exec(text);
  const first = m ?? half;
  if (!first) return text;
  const markerIndex = text.lastIndexOf(g(first, 1));
  if (m && !hasContent(g(m, 2))) return text;
  if (inCode(text, markerIndex)) return text;
  if (countOutside(text, '~~') % 2 !== 1) return text;
  return half ? text + '~' : text + '~~';
}

interface Handler {
  name: string;
  priority: number;
  enabled: boolean;
  run: (text: string) => string;
}

/**
 * 修补流式文本（纯函数，不改入参）：未闭合的记号补尾、半截 HTML 标签剥掉、半截链接收口。
 * 已闭合的文本原样返回——这是「历史消息一字不动」的保证。
 */
export function remend(text: string, options?: RemendOptions): string {
  if (!text || typeof text !== 'string') return text;
  // 单个尾空格去掉（两个空格 = 硬换行，保留）
  let result = text.endsWith(' ') && !text.endsWith('  ') ? text.slice(0, -1) : text;

  const on = (v: boolean | undefined): boolean => v !== false;
  const linkMode: LinkMode = options?.linkMode ?? 'text-only';
  const handlers: Handler[] = [
    { name: 'codeBlock', priority: 0, enabled: on(options?.codeBlock), run: handleCodeFence },
    { name: 'htmlTags', priority: 10, enabled: on(options?.htmlTags), run: handleHtmlTag },
    { name: 'links', priority: 20, enabled: on(options?.links), run: (t) => handleLinks(t, linkMode) },
    { name: 'boldItalic', priority: 30, enabled: on(options?.boldItalic), run: handleBoldItalic },
    { name: 'bold', priority: 35, enabled: on(options?.bold), run: handleBold },
    { name: 'italicDoubleUnderscore', priority: 40, enabled: on(options?.italic), run: handleItalicDoubleUnderscore },
    { name: 'italicStar', priority: 41, enabled: on(options?.italic), run: handleItalicStar },
    { name: 'italicUnderscore', priority: 42, enabled: on(options?.italic), run: handleItalicUnderscore },
    { name: 'inlineCode', priority: 50, enabled: on(options?.inlineCode), run: handleInlineCode },
    { name: 'strikethrough', priority: 60, enabled: on(options?.strikethrough), run: handleStrikethrough },
  ];

  for (const h of handlers.filter((x) => x.enabled).sort((a, b) => a.priority - b.priority)) {
    result = h.run(result);
  }
  return result;
}
