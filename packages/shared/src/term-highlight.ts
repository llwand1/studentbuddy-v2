/**
 * shared/term-highlight — 正文「命中词条」的匹配规则**唯一事实源**
 * （契约 `docs/TERM-HIGHLIGHT-SPEC.md` §4）。
 *
 * ★ 为什么上提到 shared：本规则原本只活在服务端 `learning/term-usage.ts` 的 `replyHitsKey`
 *   （回复完成后扫命中、+1 `usage_count`、落提及流水）。现在正文渲染层要用**同一套规则**
 *   把词条标出来；前端若再抄一份，必然出现「统计说命中了 3 个、屏幕上只标出 2 个」——
 *   与 `doc-rag.ts` 常量双写、`ebbinghaus.ts` 判定双写是同一类病。故服务端 `countUsage`
 *   与前端高亮都只**调用**本文件、不重写。
 *
 * ★ 规则三条（改动前必读——任何一条变了都会**同时**改掉统计口径与呈现口径）：
 *   1. 匹配键 = `term` + `aliases`，**大小写不敏感**（别名在回复中出现照样算命中，
 *      见 `TERM-TIDY-SPEC` §7.3：呈现侧必须与统计侧同口径）；
 *   2. **含拉丁字母的键按词边界匹配**（`(?<![a-z0-9])…(?![a-z0-9])`）——防子串误报：
 *      `let` 不该命中 `outlet`；**纯中文键按子串**（中文无词边界概念）；
 *   3. 同一位置多个键命中时**取更长者**（`机器学习` 不该被 `机器` 截断）。
 *
 * ★ 本文件只放纯函数、不碰 IO（同 `ebbinghaus.ts` 约定）：组件与路由只接线。
 */

/** 词条的可匹配键（只取匹配需要的字段，不绑定 `TermItem` 全量形状） */
export interface TermKey {
  /** 主词条名：命中后回传给 UI 的永远是它（别名只是入口） */
  term: string;
  aliases?: readonly string[] | null;
}

/** 正文里的一次命中：字符区间 + 归属的主词条名 */
export interface TermHit {
  /** 命中起点（原文下标，含） */
  start: number;
  /** 命中终点（原文下标，不含） */
  end: number;
  /** 归属的**主词条名**（不是实际匹配到的别名） */
  term: string;
  /** 实际匹配到的文本（可能来自 `aliases`；UI 一般不用，留给调试与测试断言） */
  key: string;
}

/** 拉丁字母判定（`i` 标志：大小写两种形态都算） */
const LATIN = /[a-z]/i;

/** 键是否含拉丁字母 → 决定走「词边界」还是「子串」匹配 */
export function hasLatinKey(key: string): boolean {
  return LATIN.test(key);
}

/** 正则元字符转义（键来自用户词条库，可能含 `.` `(` `+` 等） */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 单个键的正则**源**（不含标志位，调用方自行加 `g` / `i`）。
 * 含拉丁字母 → 两侧加词边界断言；纯中文 → 原样子串。
 * ★ 边界断言写成 `[a-z0-9]` 即可：调用方带 `i` 标志时它自动覆盖大写形态。
 */
export function termKeyPattern(key: string): string {
  const k = escapeRegex(key.trim());
  if (!hasLatinKey(k)) return k;
  return `(?<![a-z0-9])${k}(?![a-z0-9])`;
}

/**
 * 正文是否命中某个键（**服务端 `countUsage` 的判定入口**）。
 * ★ 与上提前的 `replyHitsKey` **逐字等价**——统计口径不得因这次重构漂移，
 *   等价性由既有 `terms.test.ts` 与新增边界用例共同锁住。
 */
export function textHitsKey(text: string, key: string): boolean {
  const k = key.trim();
  if (!k) return false;
  if (!hasLatinKey(k)) return text.toLowerCase().includes(k.toLowerCase());
  return new RegExp(termKeyPattern(k), 'i').test(text);
}

/** 一个词条的全部匹配键（去空白、去重、按长度降序——长键优先，防短键截断长键） */
export function termKeysOf(t: TermKey): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | null | undefined): void => {
    const k = (raw ?? '').trim();
    if (!k) return;
    const lower = k.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    out.push(k);
  };
  push(t.term);
  for (const a of t.aliases ?? []) push(a);
  out.sort((a, b) => b.length - a.length);
  return out;
}

/** 从合并正则的命名组里取出**实际命中**的那个键（交替分支只有一个非 undefined） */
function matchedKey(m: RegExpMatchArray): string | null {
  const g = m.groups;
  if (!g) return null;
  for (const name of Object.keys(g)) {
    const v = g[name];
    if (v !== undefined) return v;
  }
  return null;
}

/** 重叠去重：按起点升序（同起点取更长），被前一条覆盖的丢弃 */
function dedupeOverlap(hits: TermHit[]): TermHit[] {
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: TermHit[] = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.start >= lastEnd) {
      out.push(h);
      lastEnd = h.end;
    }
  }
  return out;
}

/**
 * 词条匹配器：**索引编译一次、正文扫描多次**。
 *
 * ★ 为什么要这个形状（而不是每次调 `findTermHits` 现建正则）：正文是**流式**渲染的，
 *   尾块每帧都在变、每帧都要重扫。词条几百条时，合并正则的编译开销与扫描同量级，
 *   每帧重编译会白白吃掉帧预算。编译一次、复用实例，是这一层唯一的性能要点。
 * ★ 正则带 `g` 标志也能安全复用：`String.prototype.matchAll` 内部会克隆正则并把
 *   `lastIndex` 归零（规范行为），不存在跨次调用互相污染的问题。
 */
export interface TermMatcher {
  /** 索引里的键总数（主名 + 别名，已去重） */
  keyCount: number;
  /** 扫出正文里的全部命中（重叠已去重） */
  find: (text: string) => TermHit[];
}

/** 编译索引：小写键 → 主词条名 + 合并正则（交替分支按键长度降序） */
function compile(terms: readonly TermKey[]): { owner: Map<string, string>; re: RegExp | null } {
  const owner = new Map<string, string>();
  const keys: string[] = [];
  for (const t of terms) {
    for (const k of termKeysOf(t)) {
      const lower = k.toLowerCase();
      if (owner.has(lower)) continue;
      owner.set(lower, t.term);
      keys.push(k);
    }
  }
  if (keys.length === 0) return { owner, re: null };
  keys.sort((a, b) => b.length - a.length);
  const source = keys.map((k, i) => `(?<k${i}>${termKeyPattern(k)})`).join('|');
  return { owner, re: new RegExp(source, 'gi') };
}

/** 用一份词条表建匹配器（前端索引层用；索引不变则复用同一个实例） */
export function createTermMatcher(terms: readonly TermKey[]): TermMatcher {
  const { owner, re } = compile(terms);
  return {
    keyCount: owner.size,
    find: (text) => {
      if (!text || !re) return [];
      const raw: TermHit[] = [];
      for (const m of text.matchAll(re)) {
        const key = matchedKey(m);
        if (key === null) continue;
        const start = m.index ?? 0;
        raw.push({ start, end: start + m[0].length, term: owner.get(key.toLowerCase()) ?? key, key });
      }
      return dedupeOverlap(raw);
    },
  };
}

/**
 * 一次扫出正文里的**全部**命中（便捷入口：内部现建匹配器）。
 *
 * ★ 用**合并正则**（各键各占一个命名组）而不是逐键 `indexOf`：词条数上到几百时，
 *   逐键扫描是 O(词条数 × 文本长度)，合并正则只扫一遍。**重复调用请改用
 *   `createTermMatcher`**（本函数每次都重编译正则）。
 * ★ `i` 标志直接在**原文**上匹配、不做小写化副本：某些字符小写化后长度会变（如 `İ`），
 *   在副本上取到的下标映射回原文会错位，切出来的高亮区间就会漂。
 * ★ 交替分支按**键长度降序**排列：JS 正则同起点是「先出现的分支优先」，
 *   降序排列才能保证同位置取到更长的键。
 */
export function findTermHits(text: string, terms: readonly TermKey[]): TermHit[] {
  return createTermMatcher(terms).find(text);
}
