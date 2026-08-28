// markdown.ts —— 零依赖正文解析（块级切分 + 行内标记），渲染在 features/chat/Markdown.tsx。
// 设计约束：纯字符串进、数据结构出，node 环境可单测；```svg 围栏在此识别成 svg 块。

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'del'; v: string }
  | { t: 'code'; v: string }
  | { t: 'a'; v: string; href: string }
  | { t: 'br' };

export type Block =
  | { kind: 'heading'; level: number; inline: Inline[] }
  | { kind: 'para'; inline: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'ol'; items: Inline[][] }
  | { kind: 'quote'; lines: Inline[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'svg'; code: string; closed: boolean }
  | { kind: 'hr' };

const FENCE = /^ {0,3}```([+\-\w]*)\s*$/;

/** 捕获组兜空：tsconfig 开了 noUncheckedIndexedAccess，正则结果一律显式取值。 */
const g = (m: RegExpExecArray, k: number): string => m[k] ?? '';

/** 链接白名单：只放行 http/https/mailto 与站内锚点，javascript:/data: 直接降级为纯文本。 */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^(https?:|mailto:)/i.test(href) || /^(#|\/)/.test(href)) return href;
  return null;
}

/** 行内标记：`code` / **strong** / *em* / ~~del~~ / [文本](链接)；未识别的记号原样保留。 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  let i = 0;
  const flush = (): void => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  while (i < text.length) {
    const rest = text.slice(i);
    const hit: Array<{ re: RegExp; push: (m: RegExpExecArray) => Inline }> = [
      { re: /^`([^`\n]+)`/, push: (m) => ({ t: 'code', v: g(m, 1) }) },
      { re: /^\*\*([^*\n]+)\*\*/, push: (m) => ({ t: 'strong', v: g(m, 1) }) },
      { re: /^\*([^*\n]+)\*/, push: (m) => ({ t: 'em', v: g(m, 1) }) },
      { re: /^_([^_\n]+)_/, push: (m) => ({ t: 'em', v: g(m, 1) }) },
      { re: /^~~([^~\n]+)~~/, push: (m) => ({ t: 'del', v: g(m, 1) }) },
    ];
    const matched = hit.find((h) => h.re.test(rest));
    if (matched) {
      const m = matched.re.exec(rest);
      if (m) {
        flush();
        out.push(matched.push(m));
        i += m[0].length;
        continue;
      }
    }
    const link = /^\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      const href = safeHref(g(link, 2));
      if (href) {
        flush();
        out.push({ t: 'a', v: g(link, 1) || href, href });
        i += link[0].length;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

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
const UL = /^\s*[-*+]\s+/;
const OL = /^\s*\d+[.)]\s+/;
const HR = /^\s*([-*_])\s*(?:\1\s*){2,}$/;

function isBlockStart(line: string): boolean {
  return !!(FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || UL.test(line) || OL.test(line) || HR.test(line));
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
      // 只有 svg 有专用渲染器；其余语言（含 html/mermaid 等未实现通道）一律按代码块显示，绝不裸注入
      if (lang === 'svg') blocks.push({ kind: 'svg', code: text, closed });
      else blocks.push({ kind: 'code', lang, text });
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

    const grouped: Array<{ re: RegExp; kind: 'quote' | 'ul' | 'ol'; strip: RegExp }> = [
      { re: QUOTE, kind: 'quote', strip: QUOTE },
      { re: UL, kind: 'ul', strip: UL },
      { re: OL, kind: 'ol', strip: OL },
    ];
    const grp = grouped.find((cand) => cand.re.test(line));
    if (grp) {
      const items: string[] = [];
      while (i < lines.length && grp.re.test(at(i))) {
        items.push(at(i).replace(grp.strip, ''));
        i++;
      }
      if (grp.kind === 'quote') blocks.push({ kind: 'quote', lines: items.map(parseInline) });
      else blocks.push({ kind: grp.kind, items: items.map(parseInline) });
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
