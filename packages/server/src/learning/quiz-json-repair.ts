/**
 * learning/quiz-json-repair — 出题模型输出的「无损修复」（两类：漏括号 / 非法转义）。
 * 真机端到端复验抓到的第四种失败，与前三种都不同：模型 finish=stop、输出一个字没少、
 * [QUIZ] 标记成对、svg 键齐全，但写成了 `"options":["A. …","B. …","answer":[0]`
 * ——options 数组漏了收尾的 `]`，整份 JSON 因此非法。
 * v1.1 的阶梯（原样 → 剥 svg → 逐题回退）治不了它：那三种对付的是「图坏了」和「没写完」，
 * 而这里是「模型自己写漏个括号」，四道题明明好端端在，整组却被判死成 502。
 * 与契约 §2.3「图可以没有，题不能丢」同一条原则，所以补在这里而不是改提示词赌它下次不写漏。
 */

/** 修复结果：fixed=0 表示原文一个字没动（调用方可据此判断是否真需要重试） */
export interface RepairResult {
  text: string;
  fixed: number;
}

/** 一处编辑：在 at 处插入 `]`，并先删掉自 at 起的 del 个字符 */
interface Edit {
  at: number;
  del: number;
}

/** 从 p 向前跳过空白：若撞到一个 `,` 就返回它的下标，否则 -1 */
function commaBefore(src: string, p: number): number {
  let k = p - 1;
  while (k >= 0 && (src[k] ?? '').trim() === '') k -= 1;
  return src[k] === ',' ? k : -1;
}

/**
 * 只补漏掉的 `]`，两类情形，均在「不在字符串里」的前提下判定——
 * 所以 `"A. 3:1"` 这种**串内**冒号不会误触发：
 * ① 数组上下文里出现「闭合引号后紧跟冒号」：该字符串只可能是对象键（合法 JSON 里数组元素后
 *   只能跟 `,` 或 `]`），说明这个数组漏了 `]`。`]` 要插在**那个分隔逗号之前**——
 *   插在其后就成了 `["a","b",]` 的尾逗号，照样非法；插在前头逗号正好改当对象成员分隔符。
 * ② 数组还没收尾就撞上 `}`：补 `]`；若 `}` 前还有个悬空 `,`，那个逗号是junk，直接被 `]` 顶掉。
 * 两条都**在合法 JSON 上永不触发**，故本函数是严格增益：能解析的照原样返回，不能解析的多一次机会。
 * 末尾残缺不补：那是 quiz.ts 里逐题回退的活，凭猜往下编 JSON 会造出错题。
 * 刻意单遍线性扫描而不用正则——解析器这一带曾是正则回溯钉死线程的事故点。
 */
export function repairJsonBrackets(src: string): RepairResult {
  const edits: Edit[] = [];
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let strStart = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? '';
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') {
        inStr = false;
        if (stack[stack.length - 1] !== '[') continue;
        let j = i + 1;
        while (j < src.length && (src[j] ?? '').trim() === '') j += 1;
        if (src[j] === ':') {
          const comma = commaBefore(src, strStart);
          edits.push({ at: comma >= 0 ? comma : strStart, del: 0 });
          stack.pop();
        }
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      strStart = i;
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      if (ch === '}' && stack[stack.length - 1] === '[') {
        const comma = commaBefore(src, i);
        edits.push(comma >= 0 ? { at: comma, del: 1 } : { at: i, del: 0 });
        stack.pop();
      }
      stack.pop();
    }
  }
  if (edits.length === 0) return { text: src, fixed: 0 };
  let text = '';
  let at = 0;
  for (const e of edits) {
    text += src.slice(at, e.at) + ']';
    at = e.at + e.del;
  }
  return { text: text + src.slice(at), fixed: edits.length };
}

/** JSON 字符串里合法的转义首字符（`u` 另需紧跟 4 位 hex，单独判） */
const VALID_ESCAPE_CHARS = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

/**
 * 把「非法转义」的反斜杠补成 `\\`：模型写 LaTeX 时常漏掉第二根斜杠（`$\sin\theta$` 直出），
 * 而 JSON 里 `\s` 是非法转义 → JSON.parse 抛 → 整组题被判死 502。
 * ★ 真机跑出来的：出题风格选「详细 + 列点」后解析变长、LaTeX 变多，7 次里 3 次死在解析层
 *   （默认档 6 次 0 次），详见 docs/ANSWER-STYLE-SPEC.md §8。
 * 与补括号同一条原则：**合法 JSON 上永不触发**（合法串里每个反斜杠后面必然跟合法字符），
 * 故仍是严格增益。必须逐字符扫而不用正则：串内的 `\\` 会被正则误当串尾。
 * 修的是题目文本里的一个字符，不凭猜往下编结构——与「图可以没有，题不能丢」不同层。
 */
export function repairJsonEscapes(src: string): RepairResult {
  let out = '';
  let fixed = 0;
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? '';
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inStr = false;
      out += ch;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const nx = src[i + 1] ?? '';
    if (VALID_ESCAPE_CHARS.has(nx)) {
      out += ch + nx;
      i += 1;
      continue;
    }
    if (nx === 'u' && /^[0-9a-fA-F]{4}/.test(src.slice(i + 2, i + 6))) {
      out += src.slice(i, i + 6);
      i += 5;
      continue;
    }
    out += '\\\\'; // 只补这一根斜杠，后面那个字符当普通字面量下一轮照抄
    fixed += 1;
  }
  return { text: out, fixed };
}
