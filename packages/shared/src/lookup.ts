/**
 * shared/lookup —— 划词速查小窗的契约与取词口径（契约 `docs/LOOKUP-SPEC.md`）。
 *
 * 为什么有这一层：划线之后的「这是什么意思」，**大多数情况根本不需要动模型**。
 * 划中的多半是一个术语（「闭包」「HNSW」「边际效用」），而百科条目又快又免费又稳定；
 * 只有当它是一整句、或百科查不到时，才值得花一次模型额度去讲解。
 * 于是小窗的顺序是固定的：**先查百科 → 查不到/不够 → 才给「让 AI 讲解」的按钮**。
 *
 * ★ 这里只有数据形状与纯函数（取词、判定值不值得查百科、选语种），
 *   服务端用它构造请求、前端用它决定按钮怎么排，两端共读同一份判断。
 */

/** 百科查询结果。`ok:false` 也要带 `reason`，小窗要如实显示「为什么没查到」（ADR-5） */
export type WikiLookup =
  | {
      ok: true;
      /** 实际命中的条目标题（可能与查询词不同，如「闭包」→「闭包 (计算机科学)」） */
      title: string;
      /** 摘要正文（百科的首段），已去标记 */
      extract: string;
      /** 条目地址，小窗底部给「看完整条目 ↗」 */
      url: string;
      lang: string;
      /** 查询词与命中标题不一致时为 true，小窗要提示「你查的是 X，这是 Y」 */
      redirected: boolean;
    }
  | { ok: false; reason: string };

/** AI 讲解 / 出题的一次性结果。**不写进任何会话**，所以没有 messageId */
export type LookupAnswer = { ok: true; text: string } | { ok: false; reason: string };

/** 送给服务端的那份材料；与 `ReaderSelection` 同源（SOURCE-TRACE-SPEC §14.3） */
export interface LookupContext {
  /** 用户划中的原文 */
  text: string;
  heading: string;
  section: string;
  sourceTitle: string;
  sourceUrl: string;
}

/**
 * 查询词上限——**按字形分开设**。
 *
 * 一条用例逼出来的：「闭包是函数与它词法环境的组合」不含任何标点、只有 14 字，
 * 单一的 40 字上限会把它判成「词」，于是拿一整句去搜百科 ⇒ 必然落空、白等一个来回，
 * 更糟的是可能命中一个**看起来像答案的错条目**。
 * 中日韩一个字就是一个语素，术语极少超过 12 字（「冯·诺依曼体系结构」才 9）；
 * 西文按空格分词，`event loop`、`B+ tree` 这类词组轻易就十几个字符，所以放宽到 40。
 */
export const LOOKUP_TERM_MAX = 40;
export const LOOKUP_TERM_MAX_CJK = 12;

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 句末 / 句中标点：出现它们基本说明这是一句话而不是一个词 */
const SENTENCE_MARKS = /[。！？；，、,.;!?]/;

/**
 * 这段划选**值不值得去查百科**。判据只看形状，不猜语义：
 *  - 太长（中日韩 >12 字 / 西文 >40 字，见 `LOOKUP_TERM_MAX*`）：是句子或段落，不是词；
 *  - 含句读：是句子不是词；
 *  - 空白：没东西可查。
 *
 * ★ 判错的代价不对称：误判成「不是词」只是少一次免费查询（仍可点 AI 讲解），
 *   误判成「是词」则会拿一整句去搜百科、必然落空、还让用户多等一个来回。
 *   所以这里**偏保守**。
 */
export function looksLikeTerm(s: string): boolean {
  const t = squash(s);
  if (t === '' || SENTENCE_MARKS.test(t)) return false;
  const cap = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t) ? LOOKUP_TERM_MAX_CJK : LOOKUP_TERM_MAX;
  return t.length <= cap;
}

/**
 * 从划选里取出要查的词。
 *  - 本来就是个词 ⇒ 原样；
 *  - 是一句话 ⇒ 不猜，返回空串让调用方跳过百科（猜错会给出一个**看起来像答案的错条目**，
 *    比没有答案更糟——这正是「先查百科」这条捷径唯一的风险，所以这里宁可不猜）。
 */
export function pickLookupTerm(selection: string): string {
  const t = squash(selection);
  return looksLikeTerm(t) ? t : '';
}

/**
 * 查哪个语种的百科：含 CJK 字符走中文站，否则英文站。
 * 命中失败时由服务端再回落到另一个语种（见 `server/lookup/wiki.ts`）。
 */
export function wikiLangFor(term: string): 'zh' | 'en' {
  return /[\u4e00-\u9fff\u3040-\u30ff]/.test(term) ? 'zh' : 'en';
}

/** 另一个语种，用于服务端回落 */
export function otherWikiLang(lang: string): 'zh' | 'en' {
  return lang === 'zh' ? 'en' : 'zh';
}

/** 百科摘要上限：小窗装得下就行，超了截断并给「看完整条目」 */
export const WIKI_EXTRACT_MAX = 900;
