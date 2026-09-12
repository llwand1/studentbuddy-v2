/**
 * remend 的「位置判定」层 —— 对应 Vercel streamdown/packages/remend 的 code-block-utils.ts + utils.ts。
 * 只做纯字符串查询与计数，不含任何修补逻辑，便于单独推理与复用。
 *
 * 与上游的差异：上游每个计数函数各自重扫一遍代码区状态；这里统一用一次线性扫描建 Uint8Array
 * 查表，之后任意次查询都是 O(1)——流式长回答每帧要问十几次「这位置在代码里吗」，差别明显。
 */

/** 记号之后只跟空白/别的记号 = 还没开始写正文，补尾会造出空标记 */
export const WHITESPACE_OR_MARKERS = /^[\s_~*`]*$/;
const UNICODE_WORD = /[\p{L}\p{N}_]/u;

// ── 代码区查表 ──
let cacheText = '';
// 显式标注：TS 5.7 起 Uint8Array 带 ArrayBufferLike 泛型参数，不标注会被收窄成 <ArrayBuffer>
let cacheLookup: Uint8Array = new Uint8Array(0);

function buildCodeLookup(text: string): Uint8Array {
  const lookup = new Uint8Array(text.length + 1);
  let inInline = false;
  let inFence = false;
  let i = 0;
  while (i < text.length) {
    // 转义的反引号不参与配对
    if (text[i] === '\\' && text[i + 1] === '`') {
      const state = inInline || inFence ? 1 : 0;
      lookup[i + 1] = state;
      lookup[i + 2] = state;
      i += 2;
      continue;
    }
    if (text.startsWith('```', i)) {
      inFence = !inFence;
      const state = inInline || inFence ? 1 : 0;
      const next = Math.min(i + 3, text.length);
      for (let p = i + 1; p <= next; p += 1) lookup[p] = state;
      i = next;
      continue;
    }
    if (!inFence && text[i] === '`') inInline = !inInline;
    lookup[i + 1] = inInline || inFence ? 1 : 0;
    i += 1;
  }
  return lookup;
}

/** 位置 pos 是否在代码区内（行内代码或围栏代码） */
export function inCode(text: string, pos: number): boolean {
  if (cacheText !== text) {
    cacheLookup = buildCodeLookup(text);
    cacheText = text;
  }
  return cacheLookup[Math.min(pos, text.length)] === 1;
}

// ── 字符与结构判定 ──
export function isWordChar(char: string): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  // ASCII 快路径：0-9 / A-Z / a-z / _
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95) {
    return true;
  }
  return UNICODE_WORD.test(char);
}

export const isWhitespace = (char: string): boolean => char === ' ' || char === '\t' || char === '\n';

/** `---` / `***` / `___`：整行只有 ≥3 个同种记号（可夹空白），不能被当成强调符配平 */
export function isHorizontalRule(text: string, markerIndex: number, marker: string): boolean {
  let lineStart = 0;
  for (let i = markerIndex - 1; i >= 0; i -= 1) {
    if (text[i] === '\n') {
      lineStart = i + 1;
      break;
    }
  }
  let lineEnd = text.length;
  for (let i = markerIndex; i < text.length; i += 1) {
    if (text[i] === '\n') {
      lineEnd = i;
      break;
    }
  }
  let markerCount = 0;
  for (const char of text.slice(lineStart, lineEnd)) {
    if (char === marker) markerCount += 1;
    else if (char !== ' ' && char !== '\t') return false;
  }
  return markerCount >= 3;
}

/** 反向找与 closeIndex 处 `]` 配对的 `[`（支持嵌套） */
export function findMatchingOpen(text: string, closeIndex: number): number {
  let depth = 1;
  for (let i = closeIndex - 1; i >= 0; i -= 1) {
    if (text[i] === ']') depth += 1;
    else if (text[i] === '[') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 该位置是否落在列表标记位上（行首的 `- ` / `* ` / `+ `），不当强调符起始 */
export function isListMarkerLead(text: string, markerIndex: number): boolean {
  const lineStart = text.lastIndexOf('\n', markerIndex - 1) + 1;
  return /^[\s]*[-*+][\s]+$/.test(text.slice(lineStart, markerIndex));
}

// ── 非代码区计数 ──

/** 非代码区里 marker 的非重叠出现次数 */
export function countOutside(text: string, marker: string): number {
  const step = marker.length;
  let n = 0;
  for (let i = 0; i + step <= text.length; i += 1) {
    if (text.startsWith(marker, i) && !inCode(text, i)) {
      n += 1;
      i += step - 1;
    }
  }
  return n;
}

/**
 * 数单个 `*`：排除 `**`/`***` 内、转义、代码区、列表标记、两侧空白。
 * 词内星号（`2*3`）只有在「已开启的链」里才算配平——冷启动的词内星号是乘号，不是斜体。
 */
export function countSingleStars(text: string): number {
  let count = 0;
  let inWordChain = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (inCode(text, i)) {
      if (!isWordChar(char)) inWordChain = false;
      continue;
    }
    if (char !== '*') {
      if (!isWordChar(char)) inWordChain = false;
      continue;
    }
    const prev = i > 0 ? text[i - 1] ?? '' : '';
    const next = i < text.length - 1 ? text[i + 1] ?? '' : '';
    if (prev === '\\') continue;
    // `***` 的首个 * 可以关闭单个 * 斜体（`**粗 **斜***` 这种），必须计入
    if (prev !== '*' && next === '*') {
      const nextNext = i + 2 < text.length ? text[i + 2] ?? '' : '';
      if (nextNext !== '*') continue;
    } else if (prev === '*') continue;
    const prevWs = !prev || isWhitespace(prev);
    const nextWs = !next || isWhitespace(next);
    if (prevWs && nextWs) continue;
    const wordInternal = Boolean(prev && next && isWordChar(prev) && isWordChar(next));
    const canOpen = Boolean(next) && !isWhitespace(next);
    const canClose = Boolean(prev) && !isWhitespace(prev);
    if (wordInternal && count % 2 === 0 && !inWordChain) continue;
    if ((canClose && count % 2 === 1) || canOpen) {
      count += 1;
      inWordChain = wordInternal;
    }
  }
  return count;
}

/** 数单个 `_`：排除 `__` 内、转义、代码区、词内（`snake_case` 不该被当斜体开启） */
export function countSingleUnderscores(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '_' || inCode(text, i)) continue;
    const prev = i > 0 ? text[i - 1] ?? '' : '';
    const next = i < text.length - 1 ? text[i + 1] ?? '' : '';
    if (prev === '\\') continue;
    if (prev === '_' || next === '_') continue;
    if (prev && next && isWordChar(prev) && isWordChar(next)) continue;
    n += 1;
  }
  return n;
}

/** 数非代码区里单独的反引号（排除三段 ``` 与转义） */
export function countSingleBackticks(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && text[i + 1] === '`') {
      i += 1;
      continue;
    }
    if (text[i] !== '`') continue;
    const partOfTriple =
      text.startsWith('```', i) ||
      (i > 0 && text.startsWith('```', i - 1)) ||
      (i > 1 && text.startsWith('```', i - 2));
    if (!partOfTriple) n += 1;
  }
  return n;
}

/** 内容是否已是有效正文（只有空白或别的记号 = 还没开始写，不补） */
export const hasContent = (s: string): boolean => Boolean(s) && !WHITESPACE_OR_MARKERS.test(s);
