/**
 * @sb/shared — 全站全文搜索（FTS）契约（契约 `docs/FTS-SPEC.md` §3.1）。
 *
 * 本文件承担**两件事**，都是「放错地方就会分叉」的那类：
 *
 * ① **`tokenizeForFts` 是索引侧与查询侧的同一个函数**。它在 2026-09-20 从
 *    `server/src/learning/doc-retrieve.ts` 的 `tokenizeDoc` **逐字平移**过来（那边改为
 *    re-export，调用行为一字未变）。★ 为什么必须只有一份：索引时把原文切成 bigram 存进
 *    fts5 的 `tokens` 列，查询时把用户输入切成同样的 bigram 去 MATCH——**两侧的切法只要
 *    差一个字符，结果就是「明明库里有、就是搜不到」**，而且不报错、不崩溃，只是召回静默
 *    变空。这类「同一规则写两遍」的坑本仓已付过学费（`doc-rag.ts` 常量双写）。
 *
 * ② **常量集中在这里**：shared 不吃行数门禁（`tools/gates/check.mjs` 只量 server/web），
 *    而 server 的 `search/fts-index.ts` 与 web 的搜索组件都要读同一批取值。
 *
 * ⚠️ 分词是**中文 bigram**（不是词、不是 trigram）：见 `docs/FTS-SPEC.md` §1 的选型论证——
 *    trigram 内置零维护但硬性要求查询词元 ≥3 字，中文双字词（"概率""函数"）直接不可查，
 *    对学习类产品是硬伤，故排除。**已知代价**：单字查询查不到多字连续串（"牛"搜不到
 *    "牛顿"），这是原理性限制，已按 FTS-SPEC §6 登记为「已接受限制」而非 bug。
 */

/**
 * 结果摘要的字数上限（`snippet` 列）。
 *
 * ★ 摘要**不是**用 fts5 的 `snippet()` 函数生成的：那个函数的输出落在**分词后的 tokens**
 *   上（bigram 拼接），给不了可读原文。故摘要由写侧从原文切「命中处附近」的一段，
 *   高亮交给前端 `indexOf` 做（FTS-SPEC §3.2）。
 */
export const FTS_SNIPPET_CHARS = 80;

/** 单次查询返回条数上限（`GET /api/search?limit=` 的默认值与钳制上限，FTS-SPEC §3.4）。 */
export const FTS_TOP_K = 20;

/**
 * 查询串长度上限。超长输入在分词前就截断——bigram 会让词元数线性膨胀
 * （n 字 → n-1 个词元），不设闸等于让一个 10 万字的粘贴件构造出 10 万个 MATCH 词元。
 */
export const FTS_MAX_QUERY_CHARS = 80;

/**
 * 前端触发搜索的最小字数（FTS-SPEC §3.4：会话侧栏输入 ≥2 字才追加服务器结果）。
 * 1 个字在 bigram 下只能匹配单字串，召回噪声大且意义有限，故不触发。
 */
export const FTS_MIN_QUERY_CHARS = 2;

/**
 * `title` 列的字数上限（结果列表展示用的原文截断，**非分词**）。
 * 与 `FTS_SNIPPET_CHARS` 分开：title 是「这条是什么」，snippet 是「哪里命中了」。
 */
export const FTS_TITLE_CHARS = 400;

/**
 * 索引可承载的数据类别（FTS-SPEC §3.2 的 `kind` 列取值）。
 * P2 计划加 `'quiz'`（题库）/`'doc'`（跨会话资料）。
 * ★ 做成常量数组而不是裸字符串字面量：路由参数解析、前端分区渲染、测试遍历都要用它。
 * ★ 原第三类 `'note'`（错题笔记）随刷题笔记功能于 2026-09-25 下线；库里可能残留
 *   `kind='note'` 的旧索引行，本清单就是它的过滤器（查询侧 `kind IN (...)` 挡掉）。
 */
export const FTS_KINDS = ['message', 'term'] as const;

export type FtsKind = (typeof FTS_KINDS)[number];

/** 一条搜索命中（`GET /api/search` 的响应元素，前后端共用一份形状）。 */
export interface FtsHit {
  kind: FtsKind;
  /** 源表主键：`messages.id` / `term_library.id` */
  refId: string;
  /** 结果主标题（原文截断，非分词；前端直接显示） */
  title: string;
  /** 命中处附近的原文片段（≤ `FTS_SNIPPET_CHARS`；前端用 `indexOf` 做高亮） */
  snippet: string;
  /** 源表 `updated_at`（无该列时落空串） */
  updatedAt: string;
  /**
   * bm25 分数。★ fts5 的 bm25 **越小越相关**（它是负的成本值），
   * 故服务端按升序取前 K 条后**原样透传**，前端不要自己重排。
   */
  score: number;
  /**
   * 跳转所需的定位信息（可选，按 kind 语义不同）：
   * · `message` → 所属会话 id（点结果要跳进那个会话）
   * 无跳转语义的 kind 不带此字段。
   */
  parentId?: string;
}

/** CJK 基本区 + 扩展 A + 兼容表意区；单字级匹配，交给 bigram 组合成词 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/** 英文词与数字（含小数、带点的版本号）——与 `terms.ts` 的 tokens() 同源思路 */
const LATIN_NUM = /[a-z][a-z0-9.+-]*|\d+(?:\.\d+)?/g;

/**
 * 中英混排分词：英文/数字按词切，中文按连续串切 **bigram**（长度为 1 的串保留单字）。
 *
 * ★ 中文不做真正的分词是刻意的：引分词器就是引依赖（本仓硬约束「零新依赖」），
 *   且 bigram 对「一个字之差就换词」的学习类文本召回更稳——代价是词元数膨胀，
 *   由 fts5 的倒排索引 + 查询侧词元去重消化。
 *
 * ⚠️ 两个正则带 `g` 标志（有 `lastIndex` 状态），但这里走 `String.prototype.match`：
 *   带 `g` 时 match 会**重置 lastIndex 并返回全部匹配**，不跨调用残留状态。
 *   若日后有人把它改成 `re.exec()` 循环，必须自己管 `lastIndex`——否则第二次调用会漏。
 */
export function tokenizeForFts(s: string): string[] {
  const low = s.toLowerCase();
  const toks: string[] = low.match(LATIN_NUM) ?? [];
  const cn: string[] = [];
  for (const run of low.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      cn.push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) cn.push(run.slice(i, i + 2));
  }
  return cn.length ? toks.concat(cn) : toks;
}

/**
 * 把词元数组编成 **fts5 MATCH 表达式**（多词元 `AND` 连接）。
 *
 * ★★ **必须转义，这不是可选项**：fts5 的查询语法里 `+ - . : " ( ) * ^` 等都有含义。
 *    而 `tokenizeForFts` 产出的词元**真的会带这些字符**——`c++`、`v0.2.1`、`node.js`
 *    都会被 `LATIN_NUM` 原样切出来，用户手输的 `-牛顿` 同样如此。
 *
 * ★ **不转义的后果是「语法错误 ⇒ 500」，不是「静默语义漂移」**（2026-09-20 实测纠正，
 *    见 `tools/probes/fts-capability.mjs` §5）。实测三种形态：
 *      · `MATCH 'c++'`   → `SqliteError: fts5: syntax error near "+"`
 *      · `MATCH '-牛顿'` → `SqliteError: no such column: 牛顿`
 *      · `MATCH ''`      → `SqliteError: fts5: syntax error near ""`
 *    ★ 注意 fts5 的 `NOT` **只能做二元运算符**（`a NOT b` 可跑），**没有 fts3/4 那种
 *    `-term` 前缀简写**——所以 `-牛顿` 不会静默变成「不含牛顿的」，它是直接报错。
 *    本函数此前把后果写成「语义反转且不报错」，那个说法**是错的**，已按实测订正。
 *    ⇒ 转义仍必须做，理由改为**用户输入一个 `+` 就能把接口打成 500**（不需要任何"更坏"的场景）。
 *
 *    故每个词元一律用双引号包裹成**字符串字面量**（fts5 里 `"..."` 内部的一切都按字面
 *    处理），内部的 `"` 按 fts5 规则翻倍转义。
 *
 * ★ 多词元用 `AND` 而不是 `OR`（FTS-SPEC §3.4）：召回不足时才在 P2 讨论放宽。
 * ★ 空词元数组返回**空串**，调用方据此**直接短路不发 SQL**。★ 短路的真实理由
 *   （2026-09-20 实测，见 `tools/probes/fts-capability.mjs` §5）：`MATCH ''` 与
 *   `MATCH '   '` 都会抛 `SqliteError: fts5: syntax error near ""` ⇒ 不短路的话，
 *   用户在搜索框里敲几个空格就把接口打成 **500**。
 *   （注：`MATCH '""'`——空字符串字面量——实测返回 0 行，不报错也不匹配全表。
 *    本函数刻意不产出 `""`，宁可在调用方短路：空查询本就该 0 成本返回。）
 */
export function buildFtsMatch(tokens: string[]): string {
  const uniq = [...new Set(tokens.filter((t) => t.length > 0))];
  if (uniq.length === 0) return '';
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}
