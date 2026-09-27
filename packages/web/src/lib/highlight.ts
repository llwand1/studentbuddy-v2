// highlight.ts —— 零依赖代码高亮 tokenizer（零依赖路线，不引 prismjs）。
// 纯函数：源码 + 语言 → token 数组，渲染层只做「token → span」（React children 自动转义，无 XSS 面）。
// 精度定位：正则单遍扫描，约等于 prism 的六成效果（关键字/字符串/注释/数字/函数名五类），
// 换来的是零依赖 + O(n) 单遍。
//
// 两个入口，按围栏是否闭合分流：
//   highlightCode    —— 整块闭合后用（全量、最准）；
//   highlightStable  —— 流式中用（只上色已换行的部分，末行纯文本，防每帧闪色）。
// 语言不支持一律返回 null，渲染层回落纯文本，绝不瞎猜。

export type HlKind =
  | 'kw'
  | 'str'
  | 'com'
  | 'num'
  | 'fn'
  | 'key'
  | 'tag'
  | 'var'
  /** diff 行：新增 / 删除 / 定位头（@@ 与 +++ --- 文件头） */
  | 'add'
  | 'del'
  | 'hunk'
  | 'x';
export interface HlToken {
  t: HlKind;
  v: string;
}

/** 一条词法规则：src 是不含捕获组的正则源（组号由合并时的序号决定），t 是命中后的着色类 */
interface HlRule {
  src: string;
  t: HlKind;
}

// ── 各语言词法 ──
// 顺序即优先级：注释/字符串必须排在关键字前，否则字符串里的字会被拆着色。

const JS_KW =
  'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|class|extends|new|this|super|import|export|from|as|async|await|yield|try|catch|finally|throw|typeof|instanceof|delete|void|in|of|null|undefined|true|false|NaN|interface|type|enum|implements|public|private|protected|readonly|static|declare|namespace|get|set|satisfies|keyof|infer|abstract';

const PY_KW =
  'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case|self|None|True|False';

const SH_KW =
  'if|then|else|elif|fi|for|while|do|done|case|esac|function|echo|cd|ls|export|source|return|exit|npm|npx|node|git|sudo|mkdir|rm|cp|mv|cat|grep|sed|awk|curl|pip|python|chmod|make';

/** 单双引号字符串（含转义）；python 版前置三引号规则。注意不要用 $ 做未闭合容错——
 * master 正则带 m 标志，$ 是「行尾」不是「串尾」，三引号会在第一个换行处被截断；
 * 未闭合场景由「围栏闭合后才高亮」的原则兜底，这里不需要。 */
const DQ_STR = '"(?:\\\\.|[^"\\\\\\n])*"';
const SQ_STR = "'(?:\\\\.|[^'\\\\\\n])*'";
const PY_TQ = '"{3}[\\s\\S]*?"{3}';
const COM_LINE_JS = '//[^\\n]*';
const COM_BLOCK_C = '/\\*[\\s\\S]*?\\*/';
const NUM = '\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b';
const FN_CALL = '[A-Za-z_$][\\w$]*(?=\\s*\\()';

const LANG_RULES: Record<string, HlRule[]> = {
  js: [
    { src: COM_LINE_JS, t: 'com' },
    { src: COM_BLOCK_C, t: 'com' },
    { src: DQ_STR, t: 'str' },
    { src: SQ_STR, t: 'str' },
    { src: '`(?:\\\\.|[^`\\\\])*`', t: 'str' },
    { src: `\\b(?:${JS_KW})\\b`, t: 'kw' },
    { src: FN_CALL, t: 'fn' },
    { src: NUM, t: 'num' },
  ],
  py: [
    { src: PY_TQ, t: 'str' },
    { src: "#[^\\n]*", t: 'com' },
    { src: DQ_STR, t: 'str' },
    { src: SQ_STR, t: 'str' },
    { src: `\\b(?:${PY_KW})\\b`, t: 'kw' },
    { src: FN_CALL, t: 'fn' },
    { src: NUM, t: 'num' },
  ],
  json: [
    { src: '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)', t: 'key' },
    { src: '"(?:\\\\.|[^"\\\\])*"', t: 'str' },
    { src: '\\b(?:true|false|null)\\b', t: 'kw' },
    { src: NUM, t: 'num' },
  ],
  sh: [
    { src: '#[^\\n]*', t: 'com' },
    { src: DQ_STR, t: 'str' },
    { src: SQ_STR, t: 'str' },
    { src: '\\$\\{?[\\w]+\\}?', t: 'var' },
    { src: `\\b(?:${SH_KW})\\b`, t: 'kw' },
    { src: NUM, t: 'num' },
  ],
  css: [
    { src: '/\\*[\\s\\S]*?(?:\\*/|$)', t: 'com' },
    { src: DQ_STR, t: 'str' },
    { src: SQ_STR, t: 'str' },
    { src: '@[\\w-]+', t: 'kw' },
    { src: '#[0-9a-fA-F]{3,8}\\b', t: 'num' },
    { src: '[a-zA-Z-]+(?=\\s*:)', t: 'key' },
    { src: '\\b\\d+(?:\\.\\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|fr|deg)?\\b', t: 'num' },
  ],
  html: [
    { src: '<!--[\\s\\S]*?-->', t: 'com' },
    { src: '</?[a-zA-Z][\\w-]*', t: 'tag' },
    { src: '"[^"\\n]*"', t: 'str' },
  ],
  /** diff：整行着色，属主键是**行首**的 +/-/@@。顺序即正确性——
   *  三个字符的 +++ / --- 必须排在单字符 + / - 之前，否则文件头会被判成增删行。
   *  正文里行中的 -（如 `a - b`）不受影响：^ 在 m 标志下只认行首。 */
  diff: [
    { src: '^@@[^\\n]*', t: 'hunk' },
    { src: '^\\+\\+\\+[^\\n]*', t: 'hunk' },
    { src: '^---[^\\n]*', t: 'hunk' },
    { src: '^(?:diff|index|new file|deleted file)[^\\n]*', t: 'hunk' },
    { src: '^\\+[^\\n]*', t: 'add' },
    { src: '^-[^\\n]*', t: 'del' },
  ],
};

/** 围栏语言名 → 规则键；返回 undefined = 不支持（渲染层回落纯文本，绝不瞎猜） */
const LANG_ALIAS: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  ts: 'js', typescript: 'js', tsx: 'js',
  py: 'py', python: 'py',
  json: 'json', jsonc: 'json',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  css: 'css',
  html: 'html', xml: 'html', htm: 'html', svg: 'html',
  diff: 'diff', patch: 'diff',
};

/**
 * 高亮入口：code + 围栏语言名 → token 数组；语言不支持返回 null（调用方回落纯文本）。
 * 实现：把该语言全部规则按优先级合成一条 alternation 正则（g 标志）单遍 exec——
 * 每个命中点看「第几个捕获组非空」定着色类，组间夹的原文就是普通字符。O(n)。
 */
export function highlightCode(code: string, lang: string): HlToken[] | null {
  const key = LANG_ALIAS[lang.trim().toLowerCase()];
  const rules = key ? LANG_RULES[key] : undefined;
  if (!rules || !code) return null;

  const master = new RegExp(rules.map((r) => `(${r.src})`).join('|'), 'gm');
  const out: HlToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = master.exec(code)) !== null) {
    const text = m[0];
    if (text.length === 0) {
      // 零宽命中防死循环：跳过一个字符
      master.lastIndex += 1;
      continue;
    }
    if (m.index > last) out.push({ t: 'x', v: code.slice(last, m.index) });
    let kind: HlKind = 'x';
    for (let k = 1; k < m.length; k++) {
      if (m[k] !== undefined) {
        kind = rules[k - 1]?.t ?? 'x';
        break;
      }
    }
    out.push({ t: kind, v: text });
    last = m.index + text.length;
  }
  if (last < code.length) out.push({ t: 'x', v: code.slice(last) });
  return out;
}

/**
 * 流式高亮：只对**已完整换行的部分**上色，最后一个未完行保持纯文本。
 *
 * 为什么按最后一个 \n 切：流式 token 逐段到达，末行永远处于半截状态。
 * 直接对半截行高亮有两个毛病——① 行内记号（引号、反引号）每帧开合不同，颜色闪；
 * ② 跨行容器（块注释 / 三引号）在未闭合时会把后面的行整段吞进字符串色。
 * 以 \n 为界，head 是确定内容（高亮无损），tail 原样输出（x 类不上色），两者都稳。
 *
 * 精度边界（可接受）：head 末尾若停在跨行容器中间，该容器在 head 内没有闭合点，
 * 正则会一路吃到 head 结尾——多染一段，不会吞字（无损不变量恒成立）。围栏闭合后
 * 调用方立刻改用 highlightCode 全量重算，所以这点误差只存活流式的那几秒。
 *
 * 成本：每次调用对当前 head 跑一遍 O(n)。流式期 head 单调增长，累计约 O(n²)，
 * 但代码块量级小（千字符级）+ 外层 rAF 合批限流，实测可忽略；换来的是零缓存、
 * 零失效风险。
 */
export function highlightStable(code: string, lang: string): HlToken[] | null {
  const cut = code.lastIndexOf('\n');
  if (cut < 0) return null; // 一行都没写完 → 纯文本回落
  const head = code.slice(0, cut + 1); // 含结尾 \n：让 `//...` 这类行尾锚点能正确收口
  const tokens = highlightCode(head, lang);
  if (!tokens) return null; // 语言不支持 → 纯文本回落
  const tail = code.slice(cut + 1);
  if (tail) tokens.push({ t: 'x', v: tail });
  return tokens;
}

/** 下载文件扩展名：语言名 → 扩展（下载按钮用，映射不到就 txt） */
const EXT: Record<string, string> = {
  js: 'js', javascript: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  ts: 'ts', typescript: 'ts', tsx: 'tsx',
  py: 'py', python: 'py', json: 'json', jsonc: 'json',
  sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
  css: 'css', html: 'html', xml: 'xml', svg: 'svg', md: 'md',
  sql: 'sql', vue: 'vue', txt: 'txt',
  diff: 'diff', patch: 'diff',
};

export function extFor(lang: string): string {
  return EXT[lang.trim().toLowerCase()] ?? 'txt';
}
