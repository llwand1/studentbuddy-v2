/**
 * @sb/shared — 实时检索（WEB-RAG）契约常量（契约 docs/WEB-RAG-SPEC.md §3）。
 *
 * 与 doc-rag.ts 同一存放理由：常量是前后端共同事实源，shared 不受行数门禁。
 * ★ 刻意**不另造**切块/Top-K/预算常量：直接复用 DOC-RAG 那组探针实测值
 *   （DOC_CHUNK_CHARS=800 / DOC_TOP_K=12 / DOC_INJECT_BUDGET_CHARS=12000），
 *   两套数字并存 = 下次调参只调一边 = 同仓两把尺子。
 */

/** 一次研究式检索抓几页正文。对齐 `learning/collect.ts` 既有「一次搜集只抓 3 页」先例。 */
export const WEB_RAG_FETCH_PAGES = 3;

/**
 * 单页抓取超时（毫秒），与 `chat/tools/fetch-page.ts` 的 FETCH_TIMEOUT_MS 同值：
 * 抓单页 15s 足够，失败要失败得快。★ 并行抓 ⇒ 总时延 ≈ 单页，不是 3×15s。
 */
export const WEB_RAG_FETCH_TIMEOUT_MS = 15_000;

/**
 * 摘要块（浅路语料）的单块上限：搜索摘要本身 ≤500 字，整条摘要就是一块，
 * 此常量只兜「摘要异常超长」的极端值，不是常规路径。
 */
export const WEB_RAG_SNIPPET_CHUNK_CAP = 600;

/** L1 注入正文的总字数天花板（复用 DOC_INJECT_BUDGET_CHARS，见文件头注释）。 */
export const WEB_RAG_INJECT_BUDGET_CHARS = 12_000;

/**
 * L3 精排的候选池大小：BM25 先取**更宽**一池，精排后再截到最终 `DOC_TOP_K`。
 * ★ 池 = K 时精排只能重排、不能"把 BM25 漏掉的捞回来"，收益受限；24 ≈ 2×K，
 *   在不显著加大 embedding 输入量的前提下给精排留出纠错空间。
 */
export const WEB_RAG_RERANK_POOL = 24;

/**
 * embedding 请求**总超时**（毫秒）。精排是锦上添花：超时就退回 BM25 序，
 * 绝不让它把主线的研究式检索拖慢（学习者等的是答案，不是排序最优）。
 */
export const WEB_RAG_EMBED_TIMEOUT_MS = 8_000;

/**
 * 喂 embedding 的单块字数上限。块目标长度是 `DOC_CHUNK_CHARS`(800)，此值只兜**异常超长块**
 * （单段落定长硬切后仍可能贴到上限）；向量模型有输入长度上限，超长必须先截，
 * 否则整批请求可能被上游拒（一次拒 = 整轮精排降级）。
 */
export const WEB_RAG_RERANK_CHARS = 1_200;
