# 全站全文搜索（FTS）功能契约

> 版本：**v1.0.1（已实现 · 2026-09-20 交付；v1.0.1＝2026-09-25 索引三类收成两类；原 v0.1 草案的批复＝老板「你去接手然后开始实现」）** | 日期：2026-09-20
> ⚠️ **2026-09-26 题库整族下线对本契约的影响**：
>   老板判决逐字「studentbuddy的题库功能也去删了,现在只要剩下内核和对战以及词条」（档 B，issue #32）。已落地的两族索引（`message`／`term`）不受影响。
>   · §2「范围分期」里 **P2 的「题库（`quiz_bank`）+ 会话资料/标题」中，题库那半边计划作废**——
>     没有题库页可搜了；`FTS_KINDS` 原预留的 `'quiz'` 一类同批在 `shared/fts.ts` 注释里标作废。
>   · §1 起点段那句「六类用户数据全部没有文本搜索」与 §3 表里 `quiz_notes`／`quiz_bank` 那行，
>     自此是**立约时的现状**：`quiz_notes` 那族（`kind='note'`）已于 2026-09-25 随刷题笔记下线收成两类，
>     `quiz_bank` 则整族失去了读侧 ⇒ 两处都不再是待补的洞，而是随宿主一起消失的靶子。
> 起因：搜索策略盘点（2026-09-20 会话）确认：联网搜索与文档 BM25 两条线已成型，但
> **应用内六类用户数据（messages / 词条 / 错题本 / 题库 / 会话标题 / 会话资料）全部没有文本搜索**，
> 全仓唯一一条 SQL LIKE 还是前缀匹配（`learning/terms.ts:268`）。本契约补这个洞。
> 关联：`DOC-RAG-SPEC.md`（词法检索范式与 tokenizeDoc 同源复用）、`TENANCY-SPEC.md` §8（归属可见性判据）、
> `MEMORY-SPEC.md` §5.2（记忆仍恒注入，本契约**不**碰）、`dev/test-plan.md`（测试登记门禁）。
> **本文的 SQLite 能力结论来自 §8 实跑，不是文档推断。**
>
> ⚠️ **v1.0.1（2026-09-25，刷题笔记下线批 / issue #21）：三类索引收成两类**——`'note'`（错题笔记）随「刷题笔记」
> 功能下线，`FTS_KINDS` 现为 `['message', 'term']`。★ **一个不会自己消失的坑留在这里**：`search_index` 是虚表，
> 功能删了**不等于**索引行删了，库里那些 `kind='note'` 的旧行仍在表中；挡住它们的**只有查询侧的 `kind IN (...)` 白名单**
> （就是那份 `FTS_KINDS`）⇒ **这份常量从此兼任过滤器**，谁把它"补回三类"，旧笔记就会带着已删功能的标题重新出现在搜索结果里。
> v45 的 `DROP TABLE quiz_notes` 那一批要**连带** `DELETE FROM search_index WHERE kind='note'`（契约见 `QUIZ-NOTES-SPEC.md` 墓碑）。
> 该回归由 `src/search/fts-index.test.ts` 的一条反向锁钉住（手插一条 owner 非空的 `kind='note'` 残留行，断言它不进结果）。
>
> ★ **实现记录与偏离登记见 §10**——本版把 v0.1 里**两处写错的行为描述**按实测订正
> （§3.4 的空 MATCH、§3.4 的 `-` 前缀），并逐条列出实现与草案的偏离。**读本文请以 §10 为准。**

---

## 0. 问题陈述

| 数据 | 今天怎么"搜" | 后果 |
|---|---|---|
| `messages.content` | 无任何搜索（会话列表全量返回，前端 `App.tsx:150` 只按 title `includes`） | 「哪次对话讲过X」不可答 |
| `term_library` | 前缀 LIKE（`terms.ts:268-269`），中文按字面前缀、ASCII 大小写不敏感 | 输"牛顿"搜不到"第二定律"，definition 完全不搜 |
| `quiz_notes` / `quiz_bank` | 无文本搜索，只有 `quizId`/`wrong` 过滤 | 错题本找不到旧题 |
| `sessions.title` / `doc_text` | title 前端过滤；doc_text 只有单会话内 BM25 | 跨会话资料不可定位 |
| SQLite FTS | migrations v1–v36 **无**任何 virtual table / fts5 / MATCH | — |

## 1. 老板拍板（待批复，三选一栏已给推荐）

| 决策点 | 推荐 | 排除项与理由 |
|---|---|---|
| 中文分词进 FTS5 的方式 | **A1 写侧 bigram 预处理**（§3.1） | A2 trigram 分词器：内置零维护，但 SQLite 硬性要求查询词元 **≥3 字**，中文双字词（"概率""函数"）直接不可查——对学习类产品是硬伤，排除；A3 自建 JS 索引：重复造 doc-retrieve 的轮子且放弃持久化，排除 |
| 索引同步方式 | **写侧显式维护**（与 A1 绑定） | SQL 触发器**调不到 JS 分词函数**（better-sqlite3 不暴露 FTS5 自定义 tokenizer 注册），触发器只与 A2 兼容——分词选型已经锁死同步方式，见 §3.3 |
| 范围分期 | **P1：messages + 词条 + 错题本；P2：题库 + 会话资料/标题** | P1 不做 quiz_bank 是因其正文在 `data` JSON 里，tokenize 原始 JSON 会把选项/解析全部灌进索引，需要先定"索引哪些字段"的产品口径 |

## 2. 三条硬约束（决定方案形状）

1. **零新依赖**：只用 better-sqlite3 自带 SQLite（§8 实测 FTS5 已编译，3.49.2）。禁引分词器/spellchecker/向量库 npm 包。
2. **派生索引，真相在源表**：`search_index` 是影子表，可随时全量重建；**任何查询路径不得从索引表读业务字段**，索引坏了功能降级为"搜不到"而不是"搜错"。
3. **鉴权关闭时行为不变**（TENANCY-SPEC §9 第 5 条）：本地单人模式下搜索结果必须与今天"全量列表"可见性一致。★ 注意 landmine：`ownerFilter(null)` 返回空条件 = 看全部，本契约在**认证态**下逐表按 §4 可见性矩阵过滤，未认证态按矩阵的"本地"列。

## 3. 设计

### 3.1 新文件与归属

| 文件 | 内容 | 为什么 |
|---|---|---|
| `packages/shared/src/fts.ts` | 契约常量（`FTS_SNIPPET_CHARS`、`FTS_TOP_K`、kind 枚举）+ `tokenizeForFts()` | shared 不吃行数门禁；把 doc-retrieve 的 bigram 规则升为双端契约件 |
| `packages/server/src/search/fts-index.ts` | `upsertSearchRow` / `deleteSearchRow` / `rebuildSearchIndex` / `searchAll`（纯 SQL + 分词胶水） | 新目录新文件，不挤 `doc-retrieve.ts`（当前行数余量见动码时复核） |
| `packages/server/src/routes/search.ts` | `GET /api/search?q=&kinds=&limit=` | 与既有 `settings/search-keys` 路由并列，不混入 |

`tokenizeForFts` 直接平移 `doc-retrieve.ts:59 tokenizeDoc` 的实现并在原文件改为 re-export——**索引侧与查询侧必须是同一函数**，两侧不一致是这类方案的第一大坑。doc-retrieve 的调用行为逐字不变。

### 3.2 表结构（v37 落点：`migrations-list-v31.ts` 尾追加）

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  tokens,                    -- 唯一可检索列：tokenizeForFts(原文) 空格拼接
  kind, ref_id UNINDEXED,    -- 'message'|'term'（★ v1.0.1：原第三类 'note' 随刷题笔记于 2026-09-25 下线；P2 加 'quiz'|'doc'）
  owner,                     -- 归属冗余列，见 §4；'' = 无主
  title UNINDEXED,           -- 结果展示用，400 字截断原文（非分词）
  snippet UNINDEXED,         -- 命中处附近原文 ≤FTS_SNIPPET_CHARS 字，高亮由前端 indexOf 做
  updated_at UNINDEXED
);
```

- **独立内容表**（不玩 external content / contentless）：查询单表出结果、owner 过滤直接在索引列上做、DROP 重建干净。空间代价 = 原文冗余一份，本地库可接受。
- ★ **实现偏离（v1.0）**：实际 DDL 把 **`kind` 与 `owner` 也标了 `UNINDEXED`**（上面的草案只标了 `ref_id`/`title`/`snippet`/`updated_at`）。理由是本节注释那句「tokens 是唯一可检索列」——不标的话 kind/owner 也会进倒排表，既污染 bm25 打分、又可能产生「按 kind 名当词搜出东西」的假阳性。偏离已同时登记在 `migrations-list-v31.ts` 的 v37 注释里。
- **不用 `snippet()` 函数**：它的输出落在分词后的 tokens 上，给不了可读高亮。
- 排序用 fts5 内置 `bm25(search_index)`，不自己实现打分。★ **bm25 越小越相关**（负的成本值），故 `ORDER BY score` **升序、不加 DESC**。
- ★ **实现补充（v1.0）**：`snippet` 列在写侧存的是**原文前段**，**真正展示的摘要由查询期现算**（`makeSnippet(源表原文, q, FTS_SNIPPET_CHARS)`）。草案把它当成"存好的命中片段"，但写侧拿不到查询词，直接透传会得到「摘要里没有查询词」⇒ 前端 `indexOf` 高亮整条不亮。

### 3.3 同步：写侧显式维护

- 各源表的**全部写点**（insert/update/delete）末尾调 `upsertSearchRow`/`deleteSearchRow`。动码前必须 grep 出逐表写点清单贴在 PR 说明里，漏一个写点 = 该记录永久搜不到。
- 与源表写入**同事务**（better-sqlite3 默认单连接串行，成本为零，换掉"最终一致"的复杂度）。
- 配套 `rebuildSearchIndex()`：v37 迁移内首建 + 服务端暴露给 dev 工具（P1 不做用户可见的重建按钮，YAGNI）。
- 明确接受：`tools/` 或 `_probe/` 里绕过 server 直接写库的脚本（如 `claim-legacy.mjs`）不会同步索引 → 这正是留全量重建函数的原因，写进本节注释。

### 3.4 路由与前端

- `GET /api/search?q=…&kinds=message,term&limit=20`（★ v1.0.1：原清单里的 `note` 随刷题笔记下线，传它会被 `FTS_KINDS` 白名单挡成空结果）：查询词过 `tokenizeForFts`，产出多词元用 `AND` 连接（召回不足时才在 P2 讨论 OR）；空 token 结果直接返回空，不发 SQL。
  ★ **订正（v1.0，实测）**：v0.1 此处写「fts5 空 MATCH 会全表扫」，**这个说法是错的**——实测 `MATCH ''` 与纯空白串都抛 `SqliteError: fts5: syntax error near ""`。短路仍然必须做，但理由是**防 500**（用户敲几个空格就把接口打挂），不是防"返回全站内容"。证据见 `tools/probes/fts-capability.mjs` §5。
  ★ **订正（v1.0，实测）**：v0.1 §3.3 未提转义，实现时按「不转义 ⇒ 语法错误 ⇒ 500」加了双引号包裹。另一条常见说法「裸拼 `-牛顿` 会被读成 NOT、静默返回不含牛顿的结果」**同样不成立**——实测报 `no such column: 牛顿`；fts5 的 `NOT` **只能做二元运算符**（`a NOT b` 可跑），**没有 fts3/4 那种 `-term` 前缀简写**。
- 前端 P1 只做一件事：会话侧栏搜索框输入 ≥2 字时**追加**一路服务器结果（分区：词条 / 消息 / ~~错题~~，★ v1.0.1 起两区），点消息结果跳转会话。既有纯前端 title 过滤**保留不动**，两路并存。
  ★ **范围缩减（v1.0 诚实记账）**：v0.1 写「跳转会话**并滚动定位**」——实现只做到**跳到会话**，**未做精确滚动定位**（`FtsHit.parentId` 已带会话 id，滚动定位需要目标消息的 DOM 锚点，属 P2）。

## 4. 可见性矩阵（逐表，动码前对照 TENANCY-SPEC 复核）

| kind | 源表 owner 现实 | 索引 `owner` 列取值 | 认证请求 | 未认证（本地单人） |
|---|---|---|---|---|
| message | messages 全局，锚在 `sessions.user_id`（NULL=孤儿） | 建行时 join sessions 快照 `user_id ?? ''` | `owner = 当前用户` | 不过滤（等价今天全量列表） |
| term | `term_library.owner_id`（'' = 无主） | 直接冗余 | `ownerForWrite` 口径：`owner = ?`，无主行谁都不泄露 | `owner = ''` |
| ~~note~~ | ~~`quiz_notes.owner_id` 同上~~ | ⚰️ **v1.0.1（2026-09-25）随刷题笔记下线**：写点没了，但**库里残留的旧索引行仍在这张虚表里**（v45 才连带清）⇒ 靠 `kind IN (FTS_KINDS)` 挡住，别靠归属过滤 | — | — |

★ message 行若会话改主/删除，索引按快照冗余处理：改主走 rebuild 兜底，**会话删除时必须级联删索引行**（写点在 `canAccessSession` 域的删除函数里）。
★ **实现偏离（v1.0）**：实际落点不在 `canAccessSession` 域，而在 **`routes.ts` 的 `DELETE /sessions/:id`**——因为 `sessions` 是**软删**（只置 `deleted_at`，messages 行保留），域层没有"删除函数"可挂。故级联动作 `dropSessionMessages(sessionId)` 放在软删之后，且 **`rebuildSearchIndex()` 同样要过滤 `deleted_at IS NULL`**（否则全量重建会把已删会话的消息**复活**——这条已单独作用例锁住）。

## 5. 明确不做（本契约范围外）

- 向量/embedding 检索：维持 DOC-RAG-SPEC §8.3 立场——`/v1/embeddings` 至今未实测，先等 FTS 上线后出现真实"词法召不回语义"的案例。
- 记忆相似度检索、`user_memory` 入索引：MEMORY-SPEC §5.2 恒注入设计不动。
- 拼音/Levenshtein 容错：等 miss 案例（防"预防性工程"红线）。
- `lookup_terms` 工具改接 FTS：P2 与 quiz_bank 一起评，P1 保持"只按词查词条"的既有工具契约。
- SSE、跨会话资料 doc_text 全文入索引（doc_text 可到几百 KB，单行 fts 列撑得住但 snippet 语义要先设计）→ P2。

## 6. 测试与门禁（按本仓四连 + gates 规矩预先登记）

| 测试 | 文件 | 锁什么 |
|---|---|---|
| 分词两侧一致 | `packages/server/src/search/fts-index.test.ts` | 索引/查询共用 `tokenizeForFts`；双字词命中；单汉字查多字连续串**必 miss**（登记为已接受限制，不是 bug） |
| 回放 | 既有 migrations 回放测试追加 v37 | **DROP `search_index` 及其 fts5 影子表 + term 等列**（"duplicate/ghost" 已咬过六次，影子表名是 `search_index_*`，回放清理要带通配检查） |
| 写点全覆盖 | `fts-index.test.ts` | 对每类源表：insert→update→delete 走真实写函数后 `searchAll` 结果一致性 |
| 可见性 | `routes/search.test.ts` | 矩阵三行的认证/未认证各断言一轮 |
| 注册 | `docs/dev/test-plan.md` | 两个新 test 文件按反引号行登记，否则 gates 红 |

★ **实现状态（v1.0）**：上表五行**全部落地**，但第 5 行实际是**三个**新测试文件（`search/fts-index.test.ts` **29** ＋ `routes/search.test.ts` **9** ＋ `web/src/features/search/global-search.test.ts` **10**），另在 `storage/db.test.ts` 追加 v37 三例（影子表齐全 / MATCH+bm25 真能跑 / 退到 v36 重放）。gates 报 `✓ 测试基线登记：156 个测试文件全部在 test-plan.md 成行`。

## 7. 验收预言（动码前先写，跑完对账）

1. v37 在真实库副本上首建耗时 **< 2 s**（行数上限量级 ~10⁴，72ms/716k 字的 doc-retrieve 实测外推）。
2. 中文双字词在 ≥100 条消息的库中召回 **= 前缀 LIKE 方案的超集**（LIKE 命中集 ⊆ FTS 命中集）；单字查询命中率 **< 双字**（bigram 原理性限制，量化它）。
3. 写点清单若漏任一表任一写函数，第 3 行写点测试在**首跑即红**——它比人工 grep 可靠，PR 说明里的清单以它为权威。

### 对账（2026-09-20 交付时）

| 预言 | 结论 |
|---|---|
| 1 | ★ **未跑**（诚实记账）。只跑了合成数据量级参考：1 万行建索引 **82 ms**、单次查询 1 ms（`tools/probes/fts-capability.mjs` §4，**非真实库副本**）。按量级外推 < 2 s 应当成立，但**这不是实测**。 |
| 2 | ★ **未跑**。LIKE 超集关系需要真实库上的对照脚本，本批未做。**已实现的等价物**：单字 vs 双字的差异被 `fts-index.test.ts` 的「已接受限制」用例锁住（双字命中、单字 miss），但**没有量化命中率**。 |
| 3 | ✅ **达成**。写点清单先 grep 穷尽（messages 8 / term_library 8 / quiz_notes 3 / sessions 软删 1），再由 `fts-index.test.ts` 逐表走真实写函数复验；非空转已按 §7 纪律取证（故意改坏两处关键锁 → **恰好 5 例红** → 恢复 38/38 绿）。 |

## 8. 实测记录（2026-09-20，本机仓库自带 better-sqlite3）

```
sqlite 3.49.2；compile_options 含 ENABLE_FTS5（无独立 TRIGRAM 选项，trigram 是 fts5 内置分词器）
CREATE VIRTUAL TABLE … tokenize='unicode61'  → OK
CREATE VIRTUAL TABLE … tokenize='trigram'    → OK
```

⇒ FTS5 可用性**已证实**；trigram 的"≥3 字查询"限制来自 SQLite 官方文档语义，A2 排除理由中的中文双字词不可查一条**尚未在本机实跑验证**（把握度 中；若要复核，建一张 trigram 表插"牛顿第二定律"查"概率"级双字词即可，30 秒探针，建议动码批顺跑并归档进 `tools/probes/`）。

### ★ 复核完成（v1.0，2026-09-20 交付批顺跑）

上面那句「尚未在本机实跑验证」**已作废**——探针 `tools/probes/fts-capability.mjs`（结果存档 `fts-capability.result.txt`，**18 条断言全 ✓**）跑完了，并且**顺带证伪了本文两处行为描述**：

| 项 | 实测结论 |
|---|---|
| **A2 trigram 排除理由** | ✅ **坐实**。trigram 表插「牛顿第二定律」：`MATCH '定律'`（双字）→ **0 行**、`MATCH '熵'`（单字）→ **0 行**、`MATCH '第二定'`（三字）→ **1 行**。A2 的排除从「文档推断」升级为「实测结论」。 |
| **裸 unicode61 的粒度** | ★ **与常见说法不同**：它把**整段连续汉字当成一个词元**（`MATCH '牛顿第二定律'` → 1，任何子串 → 0）——**不是**"按单字切"。⇒ A1 的必要性比草案写的更强：原生分词器连"子串可查"都做不到。 |
| **空 MATCH** | ★ **v0.1 §3.4 的说法是错的**。`MATCH ''` / `MATCH '   '` → `SqliteError: fts5: syntax error near ""`（**语法错误**，不是"匹配全表"）；`MATCH '""'` → 0 行。⇒ 短路是为了**防 500**。 |
| **`-` 前缀** | ★ **另一条流传的错说法**：`MATCH '-牛顿'` → `SqliteError: no such column: 牛顿`（**报错**，不是"被读成 NOT 后静默反转语义"）。fts5 的 `NOT` **只能做二元运算符**（`牛顿 NOT 闭包` 可跑），**没有 fts3/4 的 `-term` 前缀简写**。 |
| **转义的定位** | ★ 细节：**转义只防语法错误、不改变分词结果**——`MATCH '"-牛顿"'` 仍命中（引号内的 `-` 被分词器当分隔符丢掉）。⇒ `buildFtsMatch` 是**护栏**，真正决定"查什么"的是 `tokenizeForFts`。 |
| **建索引量级** | 合成 1 万行（每行约 40 词元）：建索引 **82 ms**、单次查询 **1 ms**。★ 合成数据，非真实库副本。 |

⚠️ 探针归档纪律：`_probe/doc-rag-bm25.mjs` 已从磁盘与 git 历史双双失踪——本契约的一切验证脚本一律落在 **`tools/probes/`（随库提交）**，`_probe/` 只放一次性临时物。
★ **更正（v1.0）**：这条注记**已过期**——`tools/probes/doc-rag-bm25.mjs` 与同名 `.result.txt` **在库且已跟踪**（`git ls-files` 可见）。本批新增的 `fts-capability.mjs` 也照同一条纪律放在 `tools/probes/`。

## 9. 变更影响面预估

- 迁移：仅 v37 一条（建表 + 首建 rebuild 在 server 启动路径做，**不放迁移 SQL 里**——迁移 statements 是纯 SQL，调不了 JS 分词）。
- 既有文件改动：`tokenizeDoc` 平移出 shared（doc-retrieve 改 import 一行）+ 各源表写函数各加 1–3 行同步调用。server 400 行门禁的涉事文件：`terms.ts`、`notes.ts` 余量动码时复核，破线则拆。
- 不动：SSE、chat 工具面、app_settings、鉴权中间件。

★ **实际影响面（v1.0 对账）**：
- **本文 §3.1 与 §9 都只复核了 server 侧余量，漏了三处 web 门禁点**：`chat/flow.ts` **399/400**、`web/src/app/App.tsx` **294/300**、`web/src/lib/api.ts` **392/400**（后者在本仓已有先例 `api-terms-domain.ts`）。三处分别用「把 INSERT+建索引封成 `chat/persist.ts` 的导出函数（调用点反而省行）」与「拆独立文件」处置。
- **文件数比草案多 4 个**：`search/fts-source.ts`（`fts-index.ts` 涨到 410 行时按 400 红线拆出的**索引口径唯一实现**：`flatten`/`makeSnippet`/`readSource`；主文件回落到 244）+ 前端 `lib/api-search.ts`、`features/search/use-global-search.ts`、`features/search/GlobalSearch.tsx`、`features/search/global-search.css`。
- **函数命名偏离**：草案写 `upsertSearchRow`/`deleteSearchRow`，实际导出 `indexRow`/`dropRow`（+ 草案未列的 `dropSessionMessages`/`countIndexRows`/`rebuildSearchIndex`/`ensureSearchIndex`/`searchAll`）。★ 注意 fts5 虚表**无主键**，`indexRow` 内部必须是「先按 `(kind, ref_id)` DELETE 再 INSERT」——直接 INSERT 会留下多条同 ref 的行。
- **索引范围比草案收紧**：`role='tool'` 行、流式空占位（`content = ''`）、`[QUIZ]`/`[SCENARIO]` 协议消息（机读 JSON，题库归 P2）**一律不入索引**——草案 §3.2 未提，是实现时按 §5「题库归 P2」的推论补的。
- **首建时机**：草案 §3.3 说「v37 迁移内首建」、§9 说「server 启动路径做」——两处自相矛盾。实际按 **§9**：迁移只建表，首建由 `index.ts` 启动链的 `ensureSearchIndex()` 完成（**仅当索引为空**才灌，重启不重灌）。
- **另一处实现发现（值得记）**：`learning/notes.ts` 的 `upsertNoteFromAnswer` 走 `ON CONFLICT` 分支时**不更新 `id` 列** ⇒ 索引必须挂**回读到的真实 id**，不能拿新生成的 uuid（否则索引指向不存在的 id，**表现是搜不到且不报错**）。已作用例锁住。

## 10. 实现记录与偏离登记（v1.0 索引）

> 本节是**单一入口**：上面各节散落的偏离在此汇总，读契约只看这一节也能掌握"实现跟草案差在哪"。

### 10.1 交付面

| 类型 | 文件 |
|---|---|
| 契约件（shared） | `packages/shared/src/fts.ts`（常量 + `tokenizeForFts` + `buildFtsMatch`；`shared/src/index.ts` 加一行 re-export） |
| 索引层（server） | `packages/server/src/search/fts-index.ts`（**244** 行）+ `packages/server/src/search/fts-source.ts`（**187** 行，拆出的索引口径唯一实现） |
| 路由（server） | `packages/server/src/routes/search.ts`（`GET /api/search`） |
| 迁移 | `packages/server/src/storage/migrations-list-v31.ts` 追加 **v37** |
| 前端 | `packages/web/src/lib/api-search.ts` + `features/search/{use-global-search.ts, GlobalSearch.tsx, global-search.css}` |
| 测试 | `search/fts-index.test.ts` **29** + `routes/search.test.ts` **9** + `features/search/global-search.test.ts` **10** + `storage/db.test.ts` **+3** |
| 探针 | `tools/probes/fts-capability.mjs` + `.result.txt`（18 条断言全 ✓） |

本批 **+3 文件 / +51 例**；基线 shared **189**（不变）／server 1361→**1402**／web 546→**556**。

### 10.2 偏离清单（逐条）

| # | 草案写的 | 实现做的 | 为什么 |
|---|---|---|---|
| 1 | §3.2 DDL：`kind`/`owner` 未标 `UNINDEXED` | 两者**都标了** `UNINDEXED` | 落实本节注释「tokens 是唯一可检索列」；不标会污染 bm25 并可能产生按 kind 名命中的假阳性 |
| 2 | §3.1：`upsertSearchRow`/`deleteSearchRow` | `indexRow`/`dropRow`（+ 4 个草案未列的导出） | 命名对齐"索引行"语义；fts5 无主键 ⇒ `indexRow` 必须 DELETE+INSERT |
| 3 | §3.2：`snippet` 是"命中处附近原文"（存好的） | 写侧存**原文前段**，**查询期现算**真摘要 | 写侧拿不到查询词；透传会导致摘要不含查询词 ⇒ 前端整条不高亮 |
| 4 | §3.1 文件表（3 个文件） | 多 4 个文件（`fts-source.ts` + 前端 4 件） | `fts-index.ts` 撞 400 行红线拆文件；前端按 300/400 红线拆独立文件 |
| 5 | §4：级联删索引挂在 `canAccessSession` 域 | 挂在 `routes.ts` 的 `DELETE /sessions/:id`（软删后） | `sessions` 是**软删**、域层无"删除函数"；且 `rebuild` 必须同时过滤 `deleted_at IS NULL` |
| 6 | §3.3：v37 **迁移内**首建（§9 却说启动路径做，自相矛盾） | 迁移只建表；首建由 `index.ts` 启动链 `ensureSearchIndex()` 完成 | 迁移 statements 是纯 SQL、调不了 JS 分词；按 §9 |
| 7 | §3.4：跳转**并滚动定位** | 只跳到会话，**不做滚动定位** | `parentId` 已带会话 id；滚动定位需要目标消息 DOM 锚点 ⇒ P2 |
| 8 | §3.4：空 MATCH「会全表扫」 | **实测是语法错误**（⇒ 防 500） | 探针 §5 证伪；草案说法已订正 |
| 9 | （草案未提转义） | 每个词元包双引号字面量 | 裸拼 ⇒ 语法错误 500；另一条「`-` 被读成 NOT 静默反转」**同样是错的**（实测报 `no such column`） |
| 10 | §3.2 未提索引范围 | 排除 `role='tool'` / 空占位 / `[QUIZ]` `[SCENARIO]` 协议消息 | 落实 §5「题库归 P2」；协议消息是机读 JSON，索引它等于把题库塞进来 |
| 11 | §9：只复核 server 侧行数余量 | 另发现 **3 处 web 门禁点**（`flow.ts` 399/400、`App.tsx` 294/300、`api.ts` 392/400） | 已分别用「封装函数省行」与「拆文件」处置 |

### 10.3 未做 / 未验（诚实记账）

1. **§7 预言 1 未跑**：真实库副本首建耗时只有合成数据量级参考（1 万行 82 ms）。
2. **§7 预言 2 未跑**：LIKE 超集关系与单字/双字命中率**未量化**。
3. **真机端到端未跑**：浏览器里敲搜索词看三族结果与跳转，待目检。
4. **P2 全部未动**：题库（`quiz_bank`）、会话标题、跨会话资料 `doc_text`。
5. **已知未处置**：`indexRow`/`rebuildSearchIndex` 对 `makeSnippet`/`tokenizeForFts` 是**直接镜像**（各调两遍），有单点漂移风险，本批未抽公共 helper——留待 P2 一并处理。
