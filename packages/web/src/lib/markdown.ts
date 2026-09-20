// markdown.ts —— 零依赖正文解析（块级切分 + 递归行内标记），渲染在 features/chat/Markdown.tsx。
// 设计约束：纯字符串进、数据结构出，node 环境可单测；```svg / ```chart / ```html 围栏识别成专用块。
// 批次二（2026-09-10）：行内递归下降（修 **a *b* c** 错乱）、GFM 任务列表、嵌套列表、列表续行、自动链接、stableCut。
// 批次三（2026-09-12）：流式修补 remedy 升级为 remend 的 handler 体系（lib/remend.ts，移植
// Vercel streamdown/packages/remend）：补斜体 / 粗斜体 / 半截 HTML 标签，并修正原「全局奇偶」
// 在 `***`、词内记号、列表标记上的误判。仍零外部依赖（remend 是本仓内的纯函数模块）。

import { remend } from './remend';
import { countOf, parseInline } from './markdown-inline';
import type { Inline } from './markdown-inline';

/** 行内解析（Inline 类型与 parseInline）已搬至 `./markdown-inline`（2026-09-20 行数红线）。
 *  这里**转出**而非让调用方改路径——既有 import（Markdown.tsx / 各测试）零改动。 */
export { parseInline };
export type { Inline };

/** 列表项：checked 非空 = GFM 任务列表项；children = 缩进更深的子列表 */
export interface ListItem {
  inline: Inline[];
  checked?: boolean;
  children?: ListTree[];
}
/** 一层列表：ordered 决定渲染 ul 还是 ol（子层可与父层不同类型） */
export interface ListTree {
  ordered: boolean;
  items: ListItem[];
}

export type Block =
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'para'; inline: Inline[] }
  | { kind: 'ul'; items: ListItem[] }
  | { kind: 'ol'; items: ListItem[] }
  | { kind: 'quote'; lines: Inline[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'code'; lang: string; text: string; closed: boolean }
  | { kind: 'svg'; code: string; closed: boolean }
  | { kind: 'chart'; code: string; closed: boolean }
  | { kind: 'html'; code: string; closed: boolean }
  | { kind: 'hr' };

const FENCE = /^ {0,3}```([+\-\w]*)\s*$/;

/** 捕获组兜空：tsconfig 开了 noUncheckedIndexedAccess，正则结果一律显式取值。 */
const g = (m: RegExpExecArray, k: number): string => m[k] ?? '';

// 行内解析（safeHref / safeImgSrc / INLINE_RULES / parseInline）已搬至 `./markdown-inline`
// （2026-09-20 行数红线，见该文件头注）——`countOf` 也随它走，本文件改为 import。
// 本文件只留块级切分与流式修补。

// ── 块级 ──

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isDivider = (line: string): boolean => line.includes('-') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line);
const cellRow = (line: string): boolean => line.includes('|') && !!line.trim();
const isTableStart = (line: string, next: string): boolean => cellRow(line) && isDivider(next);

const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?/;
const HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/;
/** 列表行：捕获缩进与标记，嵌套层级由缩进决定，有序/无序由标记决定 */
const LIST_MARK = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
/** GFM 任务列表前缀：- [ ] 未完成 / - [x] 已完成 */
const TASK_BOX = /^\[([ xX])\]\s+/;

function isBlockStart(line: string): boolean {
  return !!(FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || LIST_MARK.test(line) || HR.test(line));
}

/** 段内逐行 → inline 序列（行间插 br，行内标记各自解析）。 */
function joinPara(para: string[]): Inline[] {
  const out: Inline[] = [];
  para.forEach((p, idx) => {
    if (idx) out.push({ t: 'br' });
    out.push(...parseInline(p));
  });
  return out;
}

/**
 * 收集一个（可能嵌套的）列表块，返回树与结束行号。缩进比当前层深 → 下钻成子列表；浅 → 弹栈回层。
 * 列表项后面缩进 ≥2 的非结构行是「续行」，并入最近那个列表项（行间 br）。
 */
function collectList(lines: string[], start: number): { tree: ListTree; next: number } {
  const stack: Array<{ indent: number; tree: ListTree }> = [];
  let i = start;
  const topOf = (): { indent: number; tree: ListTree } | undefined => stack[stack.length - 1];

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) break;

    const mark = LIST_MARK.exec(line);
    if (mark) {
      const indent = g(mark, 1).length;
      const ordered = /\d/.test(g(mark, 2));
      let content = g(mark, 3);
      const box = TASK_BOX.exec(content);
      const checked = box ? g(box, 1).toLowerCase() === 'x' : undefined;
      if (box) content = content.slice(box[0].length);
      const item: ListItem = { inline: parseInline(content.trim()) };
      if (checked !== undefined) item.checked = checked;

      const top = topOf();
      if (!top || indent > top.indent) {
        const tree: ListTree = { ordered, items: [item] };
        // 挂到上一层最后一项的 children（top 存在时才可能走到这里）
        if (top) {
          const last = top.tree.items[top.tree.items.length - 1];
          if (last) (last.children ??= []).push(tree);
        }
        stack.push({ indent, tree });
      } else {
        while (stack.length > 1 && indent < (topOf()?.indent ?? 0)) stack.pop();
        const cur = topOf();
        // 有序/无序混排（- a 后紧跟 1. b）＝两个独立列表，结束当前块让外层重开，
        // 否则会像旧版那样把「1. x」吞进无序列表，丢掉编号语义
        if (cur && cur.tree.ordered !== ordered) break;
        if (cur) {
          cur.tree.items.push(item);
          cur.indent = indent; // 同层允许轻微缩进抖动，对齐到最新值
        }
      }
      i += 1;
      continue;
    }

    // 续行：缩进 ≥2 的普通行并入最深层列表项；顶格/结构行/表格行都算列表结束
    const cur = topOf();
    const trimmed = line.trim();
    if (
      cur &&
      /^ {2,}\S/.test(line) &&
      !isBlockStart(trimmed) &&
      !isTableStart(trimmed, lines[i + 1] ?? '')
    ) {
      const last = cur.tree.items[cur.tree.items.length - 1];
      if (last) {
        last.inline.push({ t: 'br' });
        last.inline.push(...parseInline(trimmed));
      }
      i += 1;
      continue;
    }
    break;
  }

  return { tree: stack[0]?.tree ?? { ordered: false, items: [] }, next: i };
}

/** 按行切块：围栏优先（未闭合的 ```svg 也算 svg 块，交渲染层出"正在绘制"占位）。 */
export function parseBlocks(src: string): Block[] {
  const lines = (src || '').replace(/\r\n/g, '\n').split('\n');
  const at = (k: number): string => lines[k] ?? '';
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = at(i);
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const lang = g(fence, 1).toLowerCase();
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (FENCE.test(at(j))) {
          closed = true;
          break;
        }
        body.push(at(j));
      }
      const text = body.join('\n');
      // svg/chart 有内联渲染器，html 只有「新标签页打开」卡（本应用 DOM 内绝不渲染）；
      // 其余语言（含 mermaid/echarts 等未实现通道）一律按代码块显示，绝不裸注入
      if (lang === 'svg') blocks.push({ kind: 'svg', code: text, closed });
      else if (lang === 'chart') blocks.push({ kind: 'chart', code: text, closed });
      else if (lang === 'html' || lang === 'htm') blocks.push({ kind: 'html', code: text, closed });
      else blocks.push({ kind: 'code', lang, text, closed });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: g(heading, 1).length, inline: parseInline(g(heading, 2).trim()) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    if (LIST_MARK.test(line)) {
      const { tree, next } = collectList(lines, i);
      blocks.push(tree.ordered ? { kind: 'ol', items: tree.items } : { kind: 'ul', items: tree.items });
      i = next;
      continue;
    }

    if (QUOTE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && QUOTE.test(at(i))) {
        items.push(at(i).replace(QUOTE, ''));
        i++;
      }
      blocks.push({ kind: 'quote', lines: items.map(parseInline) });
      continue;
    }

    if (isTableStart(line, at(i + 1))) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && cellRow(at(i))) {
        rows.push(splitRow(at(i)).map(parseInline));
        i++;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    // 段落：吃到下一个空行或结构性行首（聊天文本靠换行分段，段内换行保留为 br）
    const para: string[] = [];
    while (i < lines.length && at(i).trim() && !isBlockStart(at(i)) && !isTableStart(at(i), at(i + 1))) {
      para.push(at(i).trim());
      i++;
    }
    blocks.push({ kind: 'para', inline: joinPara(para) });
  }

  return blocks;
}

/**
 * 流式未闭合记号修复（remedy）—— 只喂给渲染层，不改数据源。
 * 实现已升级为 remend 的 handler 体系（lib/remend.ts，移植 Vercel streamdown/packages/remend）：
 * 从「全局奇偶计数 + 正则剥离代码区」改为「按优先级串行 handler + 代码区线性查表判定」，
 * 并补齐斜体 / 粗斜体 / 半截 HTML 标签三类此前完全没处理的情况。
 * 调用约定不变：仅流式渲染时调用。落库、导出、复制一律用原文——补出来的尾巴进历史就是数据污染。
 */
export function remedy(src: string): string {
  return remend(src);
}

/**
 * stableCut —— 流式增量解析的稳定切点：从右往左找第一个「围栏平衡的空行」，
 * 返回 head = src.slice(0, 返回值) 的长度，0 表示暂无稳定前缀（比如整段还在围栏里）。
 * 用途见 Markdown.tsx：head 的块已闭合可缓存复用，每帧只重解析 tail，流式从 O(n²) 降到 O(n·块长)。
 * 正确性前提：切点落在空行（块边界）时 parseBlocks(head)+parseBlocks(tail) 与全量逐块等价；
 * 围栏平衡检查保证绝不把代码块从中间劈开。
 */
export function stableCut(src: string): number {
  let from = src.length;
  for (;;) {
    const idx = src.lastIndexOf('\n\n', from - 1);
    if (idx <= 0) return 0;
    if (countOf(src.slice(0, idx), '```') % 2 === 0) return idx + 2;
    from = idx;
  }
}
