/**
 * typing — 「打字练习式」填空的纯口径（2026-09-30；契约 `docs/WAIT-DRILL-SPEC.md` §5.2、`KNOWLEDGE-CONTINENT-SPEC.md` 填空题）。
 *
 * 用户要的手感是打字练习软件那种：**一格一字、符号不用打、提示按段揭**。三处填空（刷词拼写卡 / 大陆填空题 /
 * 对话出题填空）共用这一份，免得三处各自决定"哪些字要打、一段是几个字"。
 *   - 要打的字 = 字母 / 数字 / 汉字等（Unicode `L` / `N` / `M` 类）；空格与标点符号是**替你填好的固定格**，键入时跳过。
 *     （大陆与刷词的判分 `normText` 本来就抹掉空白与标点，所以"不打符号"不改变对错口径。）
 *   - 分段：按固定格切成"词"，词内汉字 2 字一段、字母数字 3 字一段，尾段只剩 1 字就并入前一段——「提示」一次揭一段。
 *   - `spellFriendly`：拼写卡挑词的门槛——可打字符占比 ≥ 70% 且 ≤ `TYPING_MAX_CELLS` 格；不达标的词条改出选择题
 *     （尽量不让人打符号；实在只能拼写时，符号格也替你填好）。
 */

export interface TypingCell {
  /** 答案里的这个字符（固定格就是那个符号 / 空格本身） */
  ch: string;
  /** true = 要打；false = 固定格（空格 / 符号，替你填好） */
  typed: boolean;
  /** 所属提示段（固定格记 -1） */
  seg: number;
}

/** 一格一字的上限：更长的答案（整句）不适合逐格打，退回普通输入框 */
export const TYPING_MAX_CELLS = 24;
/** 可打字符占比低于它的词条不适合拼写（`C++` / `O(n)` 之类满是符号） */
export const TYPING_MIN_TYPED_RATIO = 0.7;

const TYPED_RE = /^[\p{L}\p{N}\p{M}]$/u;
const HAN_RE = /^\p{Script=Han}$/u;

/** 字母 / 数字 / 汉字（及组合标记）算要打的字；其余（空格、标点、符号、emoji）是固定格 */
export function isTypedChar(ch: string): boolean {
  return TYPED_RE.test(ch);
}

/**
 * 一段词（连续可打格）切成提示段：汉字 2 字一段，其余 3 字一段。
 * 字母词尾段只剩 1 个字母时并入前一段（单独提示一个字母没意义）；
 * 汉字不并——三字词（原型链 / 哈希表）若并成一段，第一次提示就把整个词交代了，「分段」名存实亡（2026-09-30 真机验出）。
 */
function chunkWord(len: number, han: boolean): number[] {
  const size = han ? 2 : 3;
  const out: number[] = [];
  for (let left = len; left > 0; left -= size) out.push(Math.min(size, left));
  if (!han && out.length > 1 && out[out.length - 1] === 1) {
    out.pop();
    out[out.length - 1] = (out[out.length - 1] ?? 0) + 1;
  }
  return out;
}

/** 把答案铺成格子：谁要打、谁是固定格、每个要打的格属于第几段提示 */
export function typingCells(answer: string): TypingCell[] {
  const chars = [...answer.normalize('NFC').trim()];
  const cells: TypingCell[] = chars.map((ch) => ({ ch, typed: isTypedChar(ch), seg: -1 }));
  let seg = 0;
  let i = 0;
  while (i < cells.length) {
    if (!cells[i]?.typed) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < cells.length && cells[j]?.typed) j += 1;
    const word = cells.slice(i, j);
    const han = word.every((c) => HAN_RE.test(c.ch));
    let at = i;
    for (const n of chunkWord(word.length, han)) {
      for (let k = 0; k < n; k += 1) {
        const c = cells[at + k];
        if (c) c.seg = seg;
      }
      at += n;
      seg += 1;
    }
    i = j;
  }
  return cells;
}

/** 要打的格数 */
export function typedCount(cells: readonly TypingCell[]): number {
  return cells.reduce((n, c) => n + (c.typed ? 1 : 0), 0);
}

/** 提示段数 */
export function segmentCount(cells: readonly TypingCell[]): number {
  return cells.reduce((m, c) => Math.max(m, c.seg + 1), 0);
}

/**
 * 把打进来的字放回格子，得到**带符号的完整答案**（交给各处既有判分，口径不变）。
 * 没打完时只给到最后一个已打的字（尾随的固定格不带上，免得半截答案末尾挂个逗号）；打完了给整串。
 */
export function mergeTyped(cells: readonly TypingCell[], typed: string): string {
  const chars = [...typed];
  const out: string[] = [];
  let p = 0;
  let lastTyped = -1;
  for (const c of cells) {
    if (c.typed) {
      if (p >= chars.length) break;
      out.push(chars[p] ?? '');
      p += 1;
      lastTyped = out.length - 1;
    } else out.push(c.ch);
  }
  if (chars.length >= typedCount(cells)) return out.join('');
  return out.slice(0, lastTyped + 1).join('');
}

/** `mergeTyped` 的逆：从完整答案里抠出打过的字（受控组件的 value 是完整答案，格子要的是打过的字） */
export function typedOf(cells: readonly TypingCell[], full: string): string {
  const chars = [...full];
  const out: string[] = [];
  chars.forEach((ch, i) => {
    if (cells[i]?.typed) out.push(ch);
  });
  return out.join('');
}

/** 只保留可打的字，并截到格数（键入的符号 / 多余的字直接丢，不落进格子） */
export function clampTyped(cells: readonly TypingCell[], raw: string): string {
  return [...raw]
    .filter(isTypedChar)
    .slice(0, typedCount(cells))
    .join('');
}

/** 逐格对错（打字练习式的即时反馈；只看已打的格） */
export function cellVerdicts(cells: readonly TypingCell[], typed: string): Array<'ok' | 'bad' | null> {
  const chars = [...typed];
  let p = 0;
  return cells.map((c) => {
    if (!c.typed) return null;
    if (p >= chars.length) return null;
    const got = chars[p] ?? '';
    p += 1;
    return got.normalize('NFKC').toLowerCase() === c.ch.normalize('NFKC').toLowerCase() ? 'ok' : 'bad';
  });
}

/** 这条答案适合逐格打吗（拼写卡挑词 / 对话填空要不要用格子） */
export function spellFriendly(answer: string): boolean {
  const cells = typingCells(answer);
  const n = typedCount(cells);
  if (n === 0 || cells.length > TYPING_MAX_CELLS) return false;
  return n / cells.length >= TYPING_MIN_TYPED_RATIO;
}
