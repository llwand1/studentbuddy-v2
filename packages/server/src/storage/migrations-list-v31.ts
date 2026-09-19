/**
 * storage/migrations-list-v31 — v31 及之后的迁移分片（契约 `docs/TENANCY-SPEC.md` §8.2，M2d-2）。
 *
 * ── v31（2026-09-18，M2d-2：**词条库与领域归主**，契约 §8.2）──────────────────────
 *
 * 背景：`term_library` 与 `term_domain` 是本仓**最老的用户数据表**（v1 就在），却一直是
 * **全局表**——`term_library` 的 `UNIQUE(term, domain)`、`term_domain` 的 `name` 单列主键，
 * 两者都**只允许"全站一条"**，于是多用户必然互撞：
 *   · A 建了「物理」领域，B 就**建不了**同名领域（`name` 单列 PK 直接撞）；
 *   · A、B 各有「牛顿第二定律 / 物理」，第二个人的词条**并进了第一个人的**（`UNIQUE(term,domain)`）；
 *   · `countTerms` / `domainStats` 把**所有人**的词条数加在一起；
 *   · `listTerms` 一次列出**全站**词条（`SELECT * FROM term_library ORDER BY updated_at DESC`）。
 * 与 v30 那四张表属同一类（约束含全局取值列 ⇒ 必须重建），只是**爆炸半径大得多**：
 * 消费面 **12 个源文件 + ~80 个 SQL 点**（v30 只有 6 个文件）——这也是 v30 里把本片单独拆出来的原因。
 *
 * ★★★ **归属值取 `''`（无主 = 谁都看不见），与 v30 同口径、与 v29 的 `NULL` 刻意相反**：
 *   · 本版三张表：`''` = 无主行（本地单人模式的历史数据）⇒ 登录用户的 `owner_id = ?` 天然不匹配；
 *   · v29 `providers`/`role_bindings`：`NULL` = 平台通道 ⇒ **所有人都看得见**（免费额度给全体用）；
 *   · v22 `sessions.user_id` / v24 `user_memory.user_id`：`NULL` = 孤儿（既有事实，**本版不回头改**）。
 *   ⇒ 三套口径并存是**故意的**，不是历史遗留；改任一处之前先回答「这组表的可见性是不是真的一样」。
 *
 * ★★ **读写两侧同口径：都用 `ownerForWrite(ownerId)`**（`null` ⇒ `''`）。
 *   ★ 这一条在本版**与 v30 的理由不完全相同，值得写清**（`auth/ownership.ts` 的原注释只说了
 *     v30 那半边，容易被后来者读成"只有单值读才这样"，从而在 `term_library` 上误用
 *     `ownerFilter` 的"`null` 就豁免过滤"）：
 *   · v30 四张表（+ `countTerms`/`domainStats` 这类聚合读）：读形状是**单值或聚合**，
 *     豁免过滤后 `.get()` 返回**任意一行**、`SUM` 把所有人加在一起 ⇒ 必须同口径。
 *   · 本版 `term_library` / `term_domain` 的**主读形状是"一批行"**（`.all()`）。这里若用
 *     `ownerFilter(ownerId,'owner_id')`，未登录（`null`）会**不加条件** ⇒ 列出**全站**词条
 *     —— 那是"鉴权关闭时旧行为不变"的字面实现，但在**过渡期**（`SB_REQUIRE_AUTH` 未开、
 *     库里已有多个用户的数据）它就是一处**跨用户泄露**。
 *   ⇒ 判据不是"读形状"这一条，而是**"无主行该不该可见"**：本族表的答案是**不该**
 *     （无主 = 谁都不泄露，主人自己用 `_probe/claim-legacy.mjs` 认领）。
 *     判据写成两句话：**① 无主行不该可见 ⇒ 读写都用 `ownerForWrite`；**
 *     **② 只有 `sessions`/`user_memory` 例外**（`NULL`=孤儿 + 按 id 取行的既有形态）。
 *   ★ 本地单人模式的行为仍然不变：未登录写入的行**本来就是无主行**（同一把 helper），
 *     故"看到的就是自己全部历史"这条成立，契约 §9 第 5 条没有被违反。
 *
 * ★★ **`term_mention_log` 的 `NULL` → `''` 一并迁**（v30 头注把这条记为待办，此处兑现）：
 *   它（v26 建的）此前走**另一套口径**——写入直接落 `ownerId`（`null` ⇒ SQL `NULL`），
 *   读侧 `mentionTrend` 用 `ownerFilter` 的"`null` 就不加条件" ⇒ 未登录时把**所有人**的
 *   提及量 `GROUP BY` 加在一起。契约 §8.2 给了两条路（迁 `''` 对齐 / 声明走 v22 那套并改读侧），
 *   **本版选"对齐"**：理由是同族表共用同一套读侧 helper（`mention.ts` 与 `terms.ts` 互相引用），
 *   两套口径并存的代价（每个读点都要先问"这张表是哪一套"）**高于**一次 `UPDATE` 的成本。
 *   ⇒ 老行的 `NULL` 一律 `UPDATE` 成 `''`（仍是"无主"，**不是**判给某个用户）。
 *
 * ⚠️ **连带必改，只改迁移不改那里 = 运行时 500 或静默串台**：
 *   · `UNIQUE(term, domain)` → `UNIQUE(owner_id, term, domain)`：`terms.ts` 的 upsert
 *     冲突目标、`tidy.ts` 的归并去重判据都要跟着改；
 *   · `term_domain.name` 单列 PK → `PK(owner_id, name)`：`domains.ts` 的 `INSERT OR IGNORE`
 *     幂等性、`UPDATE … SET name = ?`（改名）的冲突判据、`terms.ts` 的
 *     `INSERT OR IGNORE INTO term_domain (name) VALUES (?)`（落词条前登记领域）全部要带归属；
 *   · 这些**没有任何编译期信号**（SQL 是字符串），只有真跑那条语句才会错。
 *
 * ⚠️ **不变式 `term_library.domain ⊆ term_domain.name` 现在必须"按用户各自成立"**：
 *   落词条前的领域登记（`terms.ts`）、`domains.ts` 的 `UNION ALL` 孤儿域兜底、删域迁 `general`
 *   三处都要带归属——否则 A 的词条会"挂在 B 的领域下"，而 `domainStats` 的
 *   `LEFT JOIN … ON t.domain = d.name` 会把它们**配到一起**（跨用户串台且不报错）。
 *
 * ⚠️ **回放迁移链**（`storage/db.test.ts`）：本版三张表**全是重建**，没有加列，故退版本时
 *   要「DROP 掉新表 + 按旧形状建回」——**不能只 DROP**：`migrate()` 只跑 `version > current`
 *   的迁移，被跳过的 v1~v9 里的 `CREATE TABLE IF NOT EXISTS` **不会重跑**，只删不建会让
 *   整条链后面全报 `no such table`（v29/v30 的 revert 已各踩过一次）。
 *   ★ `term_library` 的旧形状**不是最初那一版**：v1~v9 之后被 ALTER 加过 6 列
 *     （`aliases` / `evo_level` / `best_level` / `evo_updated_at` / `review_stage` /
 *     `last_reviewed_at` / `review_enabled`，其中 `review_enabled` **可空**）
 *     ⇒ `revertV31` 必须**逐列还原**，漏一列会让后续迁移的 `UPDATE` 报 `no such column`
 *     （比"少一列数据"更早暴露，但一样要修）。同理**新表定义必须包含全部 17 列**，
 *     漏列 = 静默丢数据（`INSERT … SELECT` 不报错，只是那一列不回填）。
 */
export const MIGRATIONS_V31: Array<{ version: number; statements: string[] }> = [
  // ── v31（2026-09-18，M2d-2：词条库 / 领域 / 提及流水 三张表归主）──────────────────
  //
  // 重建一律照 v24 `user_memory` / v29 `role_bindings` / v30 四张表的**六步先例**：
  //   ① 建新表（带 owner_id 与新约束）→ ② `INSERT … SELECT ''` 回填老行 → ③ `DROP` 旧表
  //   → ④ `RENAME` → ⑤ 重建独立索引 → ⑥ 老库的老行**一律是孤儿**（`''`），不是判给谁。
  // ★ 顺序不能变：**先 DROP 再 RENAME 再建索引**——若在 DROP 之前建索引，新表上的索引名
  //   会与旧表上同名的索引撞车（SQLite 的索引名是全库唯一的）。
  {
    version: 31,
    statements: [
      // ── ① term_library：`UNIQUE(term, domain)` ⇒ A、B 同名词条互相并入 ──
      //   ★ 列顺序照**当前真实形状**（含历次 ALTER 加进来的 6 列），一个不漏；
      //     新列 `owner_id` 放最前，与 v30 四张表同风格。
      //   ★★ **主键仍是 `id` 单列（不改成 `(owner_id, id)`）**——三条理由，改之前先读：
      //     ① `id` 是 uuid，本就全局唯一，`(owner_id, id)` 不会多拦任何东西；
      //     ② **别处按 `id` 引用它**：`term_review_log.term_id`、`term_mention_log.term_id`、
      //        `knowledge_node.ref_id`（"节点只存引用不复制正文"）——复合主键会让这些
      //        "只知道 id"的引用**失去索引前缀** ⇒ 全表扫；
      //     ③ 代码里大量 `WHERE id = ?`（`term-review.ts` 的 `UPDATE … WHERE id = ?` 等）
      //        走的就是这个主键索引；换成复合主键后它们**能跑但会慢**（静默降级）。
      //     ⇒ 本表要改的是 **UNIQUE**，不是主键。别"顺手统一"。
      `CREATE TABLE term_library_v31 (
        owner_id         TEXT NOT NULL DEFAULT '',
        id               TEXT PRIMARY KEY,
        term             TEXT NOT NULL,
        definition       TEXT NOT NULL,
        domain           TEXT NOT NULL DEFAULT 'general',
        source_session_id TEXT,
        importance       REAL NOT NULL DEFAULT 0.5,
        usage_count      INTEGER NOT NULL DEFAULT 0,
        last_used_at     TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        aliases          TEXT NOT NULL DEFAULT '[]',
        evo_level        INTEGER NOT NULL DEFAULT 0,
        best_level       INTEGER NOT NULL DEFAULT 0,
        evo_updated_at   TEXT,
        review_stage     INTEGER NOT NULL DEFAULT 0,
        last_reviewed_at TEXT,
        review_enabled   INTEGER,
        UNIQUE (owner_id, term, domain)
      )`,
      `INSERT INTO term_library_v31 (owner_id, id, term, definition, domain, source_session_id,
         importance, usage_count, last_used_at, created_at, updated_at, aliases, evo_level,
         best_level, evo_updated_at, review_stage, last_reviewed_at, review_enabled)
         SELECT '', id, term, definition, domain, source_session_id,
                importance, usage_count, last_used_at, created_at, updated_at, aliases, evo_level,
                best_level, evo_updated_at, review_stage, last_reviewed_at, review_enabled
           FROM term_library`,
      `DROP TABLE term_library`,
      `ALTER TABLE term_library_v31 RENAME TO term_library`,
      // ⑤ 重建索引：三个都改成 **`owner_id` 打头**——所有读都是"先按人筛、再按域/复习条件筛"
      //   （若保持原样，SQLite 会用不上前缀 ⇒ 全表扫，用户一多就慢）。
      `CREATE INDEX IF NOT EXISTS idx_term_domain ON term_library(owner_id, domain)`,
      `CREATE INDEX IF NOT EXISTS idx_term_library_last_reviewed ON term_library(owner_id, last_reviewed_at)`,
      `CREATE INDEX IF NOT EXISTS idx_term_library_review_enabled ON term_library(owner_id, review_enabled)`,

      // ── ② term_domain：`name` 单列 PK ⇒ A 建了「物理」B 就建不了 ──
      `CREATE TABLE term_domain_v31 (
        owner_id       TEXT NOT NULL DEFAULT '',
        name           TEXT NOT NULL,
        note           TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        review_enabled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_id, name)
      )`,
      `INSERT INTO term_domain_v31 (owner_id, name, note, created_at, updated_at, review_enabled)
         SELECT '', name, note, created_at, updated_at, review_enabled FROM term_domain`,
      `DROP TABLE term_domain`,
      `ALTER TABLE term_domain_v31 RENAME TO term_domain`,

      // ── ③ term_mention_log：口径从 `NULL`（=孤儿）对齐到 `''`（=无主）──
      //   ★ 表结构本身只是把 `owner_id` 由「可空」改成「NOT NULL DEFAULT ''」，
      //     重建是**为了改列定义**（SQLite 不能改列约束），不是为了加约束。
      //   ★ 主键同样保持 `id` 单列（理由同 ①：`term_id` 是外部引用、`WHERE id = ?` 要索引）。
      `CREATE TABLE term_mention_log_v31 (
        owner_id      TEXT NOT NULL DEFAULT '',
        id            TEXT PRIMARY KEY,
        term_id       TEXT NOT NULL,
        domain        TEXT NOT NULL,
        mentioned_at  TEXT NOT NULL DEFAULT (datetime('now')),
        mentioned_day TEXT NOT NULL DEFAULT (date('now'))
      )`,
      // ★ 老行的 `NULL` 一律落 `''`（仍是"无主"，不是判给谁）；`COALESCE` 让"已经是空串"的行原样保留。
      `INSERT INTO term_mention_log_v31 (owner_id, id, term_id, domain, mentioned_at, mentioned_day)
         SELECT COALESCE(owner_id, ''), id, term_id, domain, mentioned_at, mentioned_day
           FROM term_mention_log`,
      `DROP TABLE term_mention_log`,
      `ALTER TABLE term_mention_log_v31 RENAME TO term_mention_log`,
      // ⑤ 重建索引：lookup 本来就是 `(owner_id, domain, mentioned_day)`，保持；
      //   另两个补 `owner_id` 前缀（同 ①）。
      `CREATE INDEX IF NOT EXISTS idx_term_mention_day ON term_mention_log(owner_id, mentioned_day)`,
      `CREATE INDEX IF NOT EXISTS idx_term_mention_lookup ON term_mention_log(owner_id, domain, mentioned_day)`,
      `CREATE INDEX IF NOT EXISTS idx_term_mention_term ON term_mention_log(owner_id, term_id)`,
    ],
  },
  // ── v32（2026-09-19，P1 计时呈现线：耗时随消息落库，契约 TOOL-ECOSYSTEM-SPEC §4.7）──
  // `ADD COLUMN` 型（老行留 NULL = 「没有实测耗时」，展示层据此退「已深度思考」而非 0 秒——
  // 这正是 §4.7 判据「provider 未回耗时的老消息不许显示 0 秒」的存储侧一半）。
  // ⚠ 回放纪律同 v28：本迁移不幂等，测试里回放整条迁移链时撤销要先 DROP（SQLite 3.35+ 支持
  //   `ALTER TABLE ... DROP COLUMN`），且**只撤销本批加的两列**，别顺手 DROP 别的。
  {
    version: 32,
    statements: [
      // assistant 回答行：本轮思考耗时（ms），与 `reasoning` 同批落库
      `ALTER TABLE messages ADD COLUMN thinking_ms INTEGER`,
      // tool 结果行：该次工具调用实测耗时（ms）——1:1 跟 call，历史回放卡片同值
      `ALTER TABLE messages ADD COLUMN duration_ms INTEGER`,
    ],
  },
  // ── v33（2026-09-19，M2d-3 其余表归主：quiz_* / flow_* / knowledge_* 八处加列，契约 TENANCY-SPEC §8.2）──
  // ★ 这组表的主键全是**全局唯一 uuid**（不跨用户撞键）⇒ **加列即可**（判据见 §8.2 表头，不是重建）。
  // ★ 归属值口径照抄 M2d-1/M2d-2：`NOT NULL DEFAULT ''`——`''` = 无主行 = **谁都看不见**（与 v29
  //   `providers` 的 NULL=平台可见**刻意相反**）；老行全部落 `''`（迁移那一刻无人知道老数据属于谁，
  //   判给任何用户都是把别人的题库/知识图谱送人），登录后由 `_probe/claim-legacy.mjs` 显式认领
  //   （该脚本 M2d-1 批已预置本批八张表，表或列不存在即跳过）。
  // ★ **收口一个已上线的旧洞**：`knowledge_node`/`knowledge_edge` 此前**无任何归属过滤**
  //   ⇒ A 的知识图谱 B 能看见（M2d-1 普查发现，挂账至今）。
  // ★ 子表不加列的判据：`flow_step`/`flow_edge` 恒经 `def_id` 触达（归属随 `flow_def` 传递，
  //   「子表随父表」同 `messages` 不加 user_id 的既定口径）；`quiz_notes`/`quiz_stats` 虽也有父键
  //   （quiz_id），但契约 §8.2 点名加列（统计/笔记有**不经父表的聚合与列表读**），照契约办。
  // ★ 不新建索引：本批只加归属条件，既有查询路径（id/quiz_id/def_id/run_id 主键或索引）先行，
  //   owner 过滤是等值附加条件；单机规模下不构成新瓶颈（v29 同判不加）。
  // ⚠ 回放纪律同 v28/v32：本迁移不幂等，回放链的撤销点要先 DROP 本批八列，别顺手 DROP 别的。
  {
    version: 33,
    statements: [
      `ALTER TABLE quiz_bank ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE quiz_stats ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE quiz_notes ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE flow_def ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE flow_run ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE flow_run_step ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE knowledge_node ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE knowledge_edge ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`,
    ],
  },
  // ── v34（2026-09-19，P3 确认门批：词条删除快照表，契约 TOOL-ECOSYSTEM-SPEC §4.5/§5.1）──
  // 「AI 能删词条」的授权前提＝**可撤销**（v1.2 拍板⑥）：删前逐条把整行 JSON 存进来，
  //   撤销＝按 `affected_batch` 整批 UPSERT 回 `term_library` 并删该批日志行（语义 §4.5）。
  // ★ **明确不做软删列 `deleted_at`**：那要给 listTerms/getRelevantTerms/countUsage/domainStats/
  //   planTidy/normalizeTidyPlan 全量加过滤（10+ 触点，漏一处即隐蔽 bug）；快照表零改动现有查询。
  // ★ `owner_id`（v1.4 堵归主洞，M2d 口径 `''`＝无主）：**没有这列，B 就能撤销 A 的删除批次**。
  //   撤销接口按批校验归属：不符按「批次不存在」回 404（不区分不存在/归属他人，不给探测面）。
  // ★ `actor`：`'ai_tool'`｜`'ui'`（v1.4 拍板⑯：UI 手动删也进表，同表同回滚码不加分支）。
  // 幂等：CREATE TABLE/INDEX 均 IF NOT EXISTS，回放链不需要撤销点（区别于 v32/v33 的 ADD COLUMN 型）。
  {
    version: 34,
    statements: [
      `CREATE TABLE IF NOT EXISTS term_delete_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL DEFAULT '',
        term_id TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        actor TEXT NOT NULL,
        tool TEXT,
        affected_batch TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tdl_batch ON term_delete_log(affected_batch, created_at)`,
    ],
  },
  // ── v35（2026-09-19，P3 确认门批：工具调用统计表，契约 §4.5；建表时点由拍板⑰自「S1」提前）──
  // 每工具 30 天调用数/失败率/p95 耗时＋「本会话 AI 累计改动 N 条」的数据源；
  // §4.6「已知绕过面」（拆小批量绕阈值，首版不拦）事后就靠 `affected` 列看见。
  // `affected` 只有写类工具有值，读/网络留 NULL（NULL≠0，与 v32 耗时列同口径）。
  // `owner_id` 同 v34 归主口径（统计与「累计改动 N 条」不许串主）。
  // `confirm`：allow_once|allow_session|deny|timeout，NULL=没经过门——§6.5-8「是否经确认」的落点，
  //   放行与拒绝都留痕（拒绝也是事实，只记放行等于把绕过面的另一半藏起来）。
  // `session_id` NOT NULL：调度器事件里可为 null（无会话调用），订阅侧落 `''`——`''`＝无主
  //   哨兵是本仓 M2d 既定口径（owner_id 同），不为此把列改可空再给查询加一层 IS NULL 分支。
  {
    version: 35,
    statements: [
      `CREATE TABLE IF NOT EXISTS tool_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        source TEXT NOT NULL,
        ok INTEGER NOT NULL,
        affected INTEGER,
        ms INTEGER NOT NULL,
        result_chars INTEGER NOT NULL DEFAULT 0,
        err TEXT,
        confirm TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tool_stats_tool ON tool_stats(tool, created_at)`,
    ],
  },
  // ── v36（2026-09-20，GitHub OAuth 登录，契约 AUTH-SPEC §2.8：users 加第三方身份列）──
  // `github_id` 存 GitHub 用户数字 id（字符串落库）：按邮箱归并后回填，登录时若列已对本 id
  // 归属其他账号可一眼定位撞号（契约 §2.8 第 4 条）。**可空 + 部分唯一索引**：邮箱注册的
  // 老账号此列为 NULL，普通唯一索引会把多个 NULL 当冲突（SQLite 默认 NULL≠NULL，
  // 普通索引其实也放行——但部分索引把「只有非空才唯一」的意图写成约束，不靠读者猜）。
  // ★ 只加列、不动 `password_hash NOT NULL`：GitHub 建号的账号写入**随机不可知口令的
  //   scrypt 哈希**（auth/github.ts），密码登录对它永远 CREDENTIALS_INVALID——
  //   改 NOT NULL 约束在 SQLite 要整表重建，为省一个空串哨兵不值当（ADR-2 简洁优先）。
  {
    version: 36,
    statements: [
      `ALTER TABLE users ADD COLUMN github_id TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id) WHERE github_id IS NOT NULL`,
    ],
  },
];
