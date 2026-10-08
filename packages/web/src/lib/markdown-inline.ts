// markdown-inline.ts —— 行内标记的递归下降解析（从 lib/markdown.ts 搬出，2026-09-20）。
//
// 为什么单独成文件：`markdown.ts` 加完图片语法后 401 行，触 `.ts ≤400` 红线（gates 第 1 条）。
// 按本仓先例（`learning/quiz-image.ts` 从 `quiz.ts` 搬出、`storage/migrations-list.ts` 从
// `migrations.ts` 搬出）**拆文件而不是压注释**——那些注释记的是每一条规则为什么这么写。
// 本文件与块级解析天然分工：这里只管「一段文本 → 行内序列」，不碰块边界与围栏。
//
// 设计约束不变：纯字符串进、数据结构出，node 环境可单测。

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'del'; children: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'math'; code: string }
  | { t: 'a'; children: Inline[]; href: string }
  | { t: 'image'; alt: string; src: string }
  | { t: 'br' }
  /** 资料引用 `[n]`（资料溯源，docs/SOURCE-TRACE-SPEC.md §8.3）：渲染层查这条回答的资料架，第 n 条存在才变成可点芯片，否则原样显示 */
  | { t: 'cite'; n: number };

/** 捕获组兜空：tsconfig 开了 noUncheckedIndexedAccess，正则结果一律显式取值。 */
const g = (m: RegExpExecArray, k: number): string => m[k] ?? '';

/** 子串出现次数：split 长度减一，省掉 match 的正则编译与中间数组。块级（stableCut）也在用，故导出。 */
export const countOf = (s: string, sub: string): number => s.split(sub).length - 1;

/**
 * 链接白名单：只放行 http/https/mailto、站内锚点 `#…` 与**站内根相对路径** `/…`，其余（javascript:/data:/
 * vbscript:/未知协议）降级为纯文本。
 * ★ 根相对路径必须排除 `//` 与 `/\`：`//evil.example/x` 是协议相对 URL（浏览器补上当前协议就出站了），
 *   `/\evil.example` 在 Chromium 里等价于 `//evil.example`——两者都长得像站内路径，旧正则 `^\/` 全部放行。
 * ★ 控制字符（含制表 / 换行）先剥再判：`jav\tascript:` 在 HTML 属性里会被浏览器当成 `javascript:`。
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(href)) return null;
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (href.startsWith('#')) return href;
  if (/^\/(?![/\\])/.test(href)) return href;
  return null;
}

/**
 * 图片源白名单：只放行两类 —— **绝对 http(s) URL** 与 **站内图片缓存地址**。
 * 挡掉的理由：`data:image/svg+xml` 是可以藏脚本的活动内容，`javascript:` 同族；
 * 顺带挡掉流式占位 `sb:incomplete-image`（remend 给半截图片产出的假协议）——挡下后回落成
 * alt 文字，屏幕上不会出现那个内部占位串，也不会出现一张破图。
 *
 * ★ 站内缓存地址（2026-09-20 `fetch_image` 新增）＝相对路径 `/api/images/<32hex>.<ext>`。
 *   它**必须**是相对路径：拼成 `http://localhost:18791/…` 开发期能显示、一上线上域名就全成裂图；
 *   相对路径则天然跟随「用户当前访问的那个源」（开发期经 `vite.config.ts` 的 `/api` 代理转到
 *   18791，生产期同源直连，两处都不用改）。
 *   放宽的**只有这一个前缀、且形状卡死**：不是"放行任意相对路径"，否则模型就能在正文里嵌
 *   任意站内资源（含受保护接口的响应）。
 */
function safeImgSrc(raw: string): string | null {
  const src = raw.trim();
  if (/^https?:\/\//i.test(src)) return src;
  if (/^\/api\/images\/[a-f0-9]{32}\.(?:png|jpg|gif|webp|bmp|avif)$/.test(src)) return src;
  return null;
}

// ── 行内标记：递归下降 ──
// 旧实现是「一组平坦正则顺序吞」，**a *b* c** 会因 * 定界符打架解析错乱；
// 现改为先匹配最外层定界符、内部递归 parseInline，嵌套标记天然正确。code 内容是唯一不递归的例外。
const INLINE_RULES: Array<{ re: RegExp; make: (m: RegExpExecArray) => Inline }> = [
  { re: /^`([^`\n]+)`/, make: (m) => ({ t: 'code', v: g(m, 1) }) },
  { re: /^\$\$([^$\n]+)\$\$|^\$([A-Za-z\\][^$\n]*|[-+]?\d[^$\n]*[=+\-×÷^_][^$\n]*|[-+]?\d+(?:\.\d+)?)\$/, make: (m) => ({ t: 'math', code: g(m, 1) || g(m, 2) }) },
  { re: /^\*\*(.+?)\*\*/, make: (m) => ({ t: 'strong', children: parseInline(g(m, 1)) }) },
  { re: /^\*(.+?)\*/, make: (m) => ({ t: 'em', children: parseInline(g(m, 1)) }) },
  { re: /^~~(.+?)~~/, make: (m) => ({ t: 'del', children: parseInline(g(m, 1)) }) },
  { re: /^_([^_\n]+)_/, make: (m) => ({ t: 'em', children: parseInline(g(m, 1)) }) },
  {
    /**
     * 图片 `![alt](url)`（2026-09-20 补的输出侧缺口）。
     * ★ 必须排在下面的链接规则**之前**：`![alt](url)` 里的 `[alt](url)` 对链接规则完全合法，
     *   而扫描到 `!` 时若不匹配任何规则就会先吐一个 `!` 字符、下一轮再把 `[alt](url)` 当链接吃掉
     *   ⇒ 图片语法静默退化成「感叹号 + 链接」（这正是本次要修的缺口）。
     *   规则数组是「逐个位置试、取首个命中」，放在前面才能整段吃掉。
     */
    re: /^!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    make: (m) => {
      const src = safeImgSrc(g(m, 2));
      // 图源不合法（含流式占位 sb:incomplete-image）→ **回落成 alt 文字**而不是原样留下
      // `![..](..)`：图片的 alt 本就是它的文字替身，这样屏幕上既不出破图也不出内部占位串
      if (!src) return { t: 'text', v: g(m, 1) };
      return { t: 'image', alt: g(m, 1), src };
    },
  },
  {
    re: /^\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
    make: (m) => {
      const href = safeHref(g(m, 2));
      // 危险协议不产出 <a>，也不吞字：整段原文回落成纯文本
      if (!href) return { t: 'text', v: m[0] ?? '' };
      return { t: 'a', children: parseInline(g(m, 1)), href };
    },
  },
];

/** 裸 URL（无 [文本](…) 包裹）：匹配后剥掉尾部粘住的标点，标点留给下一轮当普通字符。 */
const AUTOLINK = /^https?:\/\/[^\s<>"]+/;

/**
 * 资料引用 `[n]` / `[1, 3]`（1–2 位数字，后面不能紧跟 `(`——那是链接语法）。
 * ★ 不进 INLINE_RULES：它还要看**前一个字符**——`a[1]` 这类下标写法（前面紧贴英文字母/数字）不算引用，
 *   而 `据[2]` / `[1][2]` / 行首 `[3]` 都算。误判的代价很低：渲染层查不到第 n 条就原样显示文字。
 */
const CITE = /^\[(\d{1,2}(?:\s*[,，]\s*\d{1,2})*)\](?!\()/;

function trimUrlTail(u: string): string {
  let s = u;
  while (s.length > 0) {
    const ch = s[s.length - 1] ?? '';
    // 右括号只有在数量不平衡（这个 ) 不是 URL 的一部分）时才剥，保住 Wikipedia 式链接
    if (ch === ')') {
      if (countOf(s, ')') > countOf(s, '(')) {
        s = s.slice(0, -1);
        continue;
      }
      break;
    }
    // URL 本体只可能是 ASCII：中文/全角字符紧贴 URL 时必须剥掉，否则半句中文被吞进 href；
    // 尾部英文标点同理（URL 后粘逗号句号几乎总是标点）
    if (ch.charCodeAt(0) > 127 || '.,;:!?]}。，；：！？、」』）】'.includes(ch)) {
      s = s.slice(0, -1);
      continue;
    }
    break;
  }
  return s;
}

/** 行内标记入口：`code` / **strong** / *em* / ~~del~~ / [文本](链接) / ![alt](图片) / 裸 URL；未识别的记号原样保留。 */
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
    let matched = false;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (m) {
        flush();
        out.push(rule.make(m));
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const ci = CITE.exec(rest);
    if (ci && !/[A-Za-z0-9_]/.test(i > 0 ? (text[i - 1] ?? '') : '')) {
      flush();
      for (const n of g(ci, 1).split(/[,，]/)) out.push({ t: 'cite', n: Number(n.trim()) });
      i += ci[0].length;
      continue;
    }
    const al = AUTOLINK.exec(rest);
    if (al) {
      const url = trimUrlTail(g(al, 0));
      if (url) {
        flush();
        out.push({ t: 'a', children: [{ t: 'text', v: url }], href: url });
        i += url.length; // 只消费 URL 本体，剥下来的尾部标点回到下一轮按普通字符走
        continue;
      }
    }
    buf += text[i] ?? '';
    i += 1;
  }
  flush();
  return out;
}
