/**
 * search/decode-text —— 字节 → 文本（按声明或嗅探的编码）。
 *
 * 2026-09-30 从 `chat/tools/fetch-page.ts` 原样搬出：资料溯源的阅读页（`sources/reader.ts`）也要解外站页面，
 * 而 fetch-page 反过来要把读到的 HTML 交给阅读页缓存——两边互引会成环，故把公共的解码层落到 search/ 下。
 * 逻辑零改动，注释保留（那些是实测教训）。
 */

/** 替换符占比：用来判断「按这个编码解是不是解错了」。 */
function replacementRatio(s: string): number {
  if (!s) return 0;
  let n = 0;
  for (const ch of s) if (ch === '\uFFFD') n++;
  return n / s.length;
}

/**
 * 按**声明或嗅探**的编码把字节解成文本。
 *
 * ★ 为什么不能直接用 `res.text()`（2026-09-20 真机实测驱动）：
 *   它**恒按 UTF-8 解码、忽略 `content-type` 里的 `charset`** ⇒ GBK 页满屏 U+FFFD
 *   仍被当「正文」回灌。实测三例：湘潭市政府 **61.8%** 替换符、岳阳市政府 **65.5%**、
 *   ★ **当当网 `content-type` 明写 `charset=GBK` 也照样 60.7%**——服务端已经告诉我们了，
 *   我们没听。这与「二进制当正文」是**同一症状、不同根因**，故另起一层修。
 *
 * 顺序：① **服务端声明的 charset 优先**（它自己说的最可信）→ ② 未声明或声明 utf-8 时，
 * 先按 UTF-8 解，替换符超 1% 再试 GB18030，**取替换符更少的那个**。
 * ★ 不用 `fatal:true` 硬判：UTF-8 页里夹几个坏字节也应当照读，不该整页回退。
 */
export function decodeText(bytes: Uint8Array, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      /* 未知编码名 → 落到嗅探 */
    }
  }
  const asUtf8 = new TextDecoder('utf-8').decode(bytes);
  if (replacementRatio(asUtf8) <= 0.01) return asUtf8;
  const asGbk = new TextDecoder('gb18030').decode(bytes);
  return replacementRatio(asGbk) < replacementRatio(asUtf8) ? asGbk : asUtf8;
}
