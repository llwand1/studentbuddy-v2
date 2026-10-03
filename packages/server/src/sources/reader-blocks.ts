/**
 * sources/reader-blocks —— 清洗后的 HTML → **块模型**（契约 `docs/SOURCE-TRACE-SPEC.md` §14.1）。
 *
 * 为什么要这一层：阅读页从「sandbox iframe 里塞 HTML 字符串」改成「前端用 React 渲染」之后，
 * 前端不该再碰 HTML 字符串——`dangerouslySetInnerHTML` 等于把清洗器当成唯一防线，
 * 而清洗器是正则实现的。改成结构化的块以后，**第三方内容不再以标记形态进入 DOM**：
 * 前端只认 `ReaderBlock` 上那几个受控字段，连标签名都是前端自己写死的。
 *
 * 输入恒为 `sanitizeReaderHtml` 的输出（白名单标签 + 受控属性），所以这里不再做安全清洗，
 * 只做**结构归并**。即便如此仍坚持两件事：
 *   ① `href` / `src` 再过一次 `http(s)` 判定（纵深防御，正则清洗器出 bug 时这里兜一道）；
 *   ② 不认识的标签一律降级成文本，不透传。
 *
 * ★ 纯函数、零 IO：`reader-blocks.test.ts` 直接喂字符串断言结构。
 */
import type { ReaderBlock, ReaderInline } from '@sb/shared';

/** 行内样式标签 → 片段类型；其余（span/div/abbr…）只取文本 */
const INLINE_AS: Record<string, ReaderInline['t']> = {
  strong: 'strong',
  b: 'strong',
  em: 'em',
  i: 'em',
  code: 'code',
  kbd: 'code',
};

/** 这些块级标签各自起一个块；`li` 另算（要带序号与层级） */
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'dt', 'dd', 'figcaption', 'caption', 'td', 'th']);

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const attr = (attrs: string, key: string): string => {
  const m = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs);
  return m?.[1] ?? '';
};

const httpOnly = (u: string): string => (/^https?:\/\//i.test(u) ? u : '');

type Cur = 'p' | 'h' | 'quote' | 'pre' | 'li' | null;

interface Token {
  tag: string;
  closing: boolean;
  attrs: string;
  text: string | null;
}

function tokenize(html: string): Token[] {
  const raw = html.match(/<\/?[a-zA-Z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g) ?? [];
  const out: Token[] = [];
  for (const t of raw) {
    if (!t.startsWith('<')) {
      out.push({ tag: '', closing: false, attrs: '', text: t });
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)([\s\S]*?)\/?>$/.exec(t);
    if (!m) continue;
    out.push({ tag: (m[2] ?? '').toLowerCase(), closing: m[1] === '/', attrs: m[3] ?? '', text: null });
  }
  return out;
}

/** 行内片段累加器：相邻的同型片段合并，避免切出一地碎块 */
class Spans {
  private readonly items: ReaderInline[] = [];

  push(t: ReaderInline['t'], v: string, href?: string): void {
    if (v === '') return;
    const last = this.items[this.items.length - 1];
    if (last && last.t === t && t !== 'link') {
      last.v += v;
      return;
    }
    this.items.push(t === 'link' ? { t: 'link', v, href: href ?? '' } : ({ t, v } as ReaderInline));
  }

  take(): ReaderInline[] {
    const out = this.items.filter((s) => s.v.trim() !== '' || s.v === ' ');
    this.items.length = 0;
    return out;
  }

  get empty(): boolean {
    return this.items.every((s) => s.v.trim() === '');
  }
}

/**
 * 清洗后的 HTML → 块数组。块 id 按产出顺序编号（`b0`、`b1`…）：
 * **稳定、与内容无关**——同一页重复抓取 id 一致，选区锚点不会因为文案微调而错位。
 */
export function parseReaderBlocks(html: string): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  const spans = new Spans();
  let seq = 0;
  const id = (): string => `b${seq++}`;

  // 当前块的上下文。★ 放进容器而不是裸 `let`：`flush`/`open` 是闭包，TS 的控制流分析看不见
  //   它们对外层变量的赋值，会把 `cur` 误收窄成 `'p' | null`。属性读取在函数调用后会重置收窄，
  //   所以这里用对象持有，既让类型正确又不必到处写断言。
  const st: { cur: Cur; hLevel: 1 | 2 | 3 | 4 | 5 | 6; preBuf: string } = { cur: null, hLevel: 1, preBuf: '' };
  /** 列表栈：记录每层是不是有序，`li` 据此取 ordered 与 depth */
  const listStack: boolean[] = [];
  /** 行内样式栈：最靠内的那层决定文本归哪种片段 */
  const styleStack: ReaderInline['t'][] = [];
  let linkHref = '';

  const flush = (): void => {
    if (st.cur === 'pre') {
      const v = decode(st.preBuf).replace(/^\n+|\s+$/g, '');
      if (v !== '') blocks.push({ t: 'pre', id: id(), v });
      st.preBuf = '';
      st.cur = null;
      return;
    }
    const s = spans.take();
    if (s.length > 0) {
      if (st.cur === 'h') blocks.push({ t: 'h', id: id(), level: st.hLevel, spans: s });
      else if (st.cur === 'quote') blocks.push({ t: 'quote', id: id(), spans: s });
      else if (st.cur === 'li') {
        blocks.push({ t: 'li', id: id(), ordered: listStack[listStack.length - 1] === true, depth: Math.max(0, listStack.length - 1), spans: s });
      } else blocks.push({ t: 'p', id: id(), spans: s });
    }
    st.cur = null;
  };

  const open = (kind: Cur): void => {
    flush();
    st.cur = kind;
  };

  for (const tk of tokenize(html)) {
    if (tk.text !== null) {
      if (st.cur === 'pre') {
        st.preBuf += tk.text;
        continue;
      }
      const v = decode(tk.text).replace(/\s+/g, ' ');
      if (v.trim() === '' && spans.empty) continue;
      if (st.cur === null) st.cur = 'p'; // 裸文本（没被 p 包住）也算一段，不丢
      if (linkHref) spans.push('link', v, linkHref);
      else spans.push(styleStack[styleStack.length - 1] ?? 'text', v);
      continue;
    }

    const { tag, closing, attrs } = tk;

    if (tag === 'a') {
      if (closing) linkHref = '';
      else linkHref = httpOnly(decode(attr(attrs, 'href')));
      continue;
    }

    if (INLINE_AS[tag]) {
      if (closing) styleStack.pop();
      else styleStack.push(INLINE_AS[tag] as ReaderInline['t']);
      continue;
    }

    if (tag === 'img') {
      if (closing) continue;
      const src = httpOnly(decode(attr(attrs, 'src')));
      if (!src) continue;
      flush();
      blocks.push({ t: 'img', id: id(), src, alt: decode(attr(attrs, 'alt')) });
      continue;
    }

    if (tag === 'hr') {
      flush();
      blocks.push({ t: 'hr', id: id() });
      continue;
    }

    if (tag === 'br') {
      if (st.cur === 'pre') st.preBuf += '\n';
      else spans.push('text', ' ');
      continue;
    }

    if (tag === 'ul' || tag === 'ol') {
      flush();
      if (closing) listStack.pop();
      else listStack.push(tag === 'ol');
      continue;
    }

    if (tag === 'li') {
      if (closing) flush();
      else open('li');
      continue;
    }

    if (tag === 'pre') {
      if (closing) flush();
      else open('pre');
      continue;
    }

    if (/^h[1-6]$/.test(tag)) {
      if (closing) flush();
      else {
        open('h');
        st.hLevel = Number(tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
      }
      continue;
    }

    if (tag === 'blockquote') {
      if (closing) flush();
      else open('quote');
      continue;
    }

    if (BLOCK_TAGS.has(tag)) {
      // 表格单元格 / 定义列表项都按普通段落收：阅读态不需要还原表格的二维关系
      if (closing) flush();
      else open('p');
      continue;
    }

    // 其余容器（div/section/article/table/tr/figure/span…）只作为「分段信号」，本身不产块
    if (closing && (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'tr' || tag === 'figure')) flush();
  }
  flush();
  return blocks;
}
