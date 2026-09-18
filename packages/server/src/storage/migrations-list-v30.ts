/**
 * storage/migrations-list-v30 — v30 及之后的迁移分片（契约 `docs/TENANCY-SPEC.md` §8.2，M2d）。
 *
 * **为什么又切一片**（2026-09-18 五次拆分）：`migrations-list-v22.ts` 加到 v29 后已 **346 行**，
 * 距 AGENTS.md「`.ts` ≤400 行」红线只剩 54 行；本批（M2d，多张表重建）光注释就装不下。
 * 分片文件里既有的规矩是「**按版本区间再切，不要用「压注释」换行数**」——那些注释记的是
 * 每张表**为什么这么建**，价值远高于行数，故本次严格照此办理（v18~v21 在 `-v18.ts`、
 * v22~v29 在 `-v22.ts`、**v30 及之后加到本片**）。
 *
 * ── v30（2026-09-18，M2d-1：**设置与反馈环归主**，契约 §8.2）────────────────────
 *
 * 背景：M2a~M2c 把「会话」「长期画像」「LLM 成本」三片归了主，但**用户自己的设置与学习记录**
 * 仍是**全局大表**——`app_settings` 是全局写口（A 改出题配比会改掉所有人的）、`user_stats`
 * 里存 `xp`（**A 和 B 的 XP 是同一个数**）、`daily_summaries` 的 `PK(day)`（**B 读到 A 的
 * 今日总结**，改前代码注释里已把这条记为"已知缺口"）、`daily_activity` 的 `PK(day,type)`
 * （A、B 同一天聊天直接撞主键）。与 `role_bindings` 属同一类隐患。
 *
 * ★ **本版只做「约束会跨用户撞键」的表，且再按消费面切了一刀**（判据不是习惯，是**约束本身**）：
 *   一张表若它的 PRIMARY KEY / UNIQUE **包含一个全局取值列**（`key` / `name` / `day` /
 *   `(term, domain)`），那它天然只允许「全站一条」⇒ 多用户必然互撞 ⇒ **必须重建**。
 *   ⇒ 本版四张：`app_settings`(key) · `daily_activity`(day,type) · `daily_summaries`(day)
 *     · `user_stats`(key)。
 *   ★ 同为「撞键类」的 `term_library`(UNIQUE term,domain) 与 `term_domain`(name) **拆到 v31**：
 *     那两张的消费面是 **12 个源文件 + 7 个测试文件 + 约 80 个 SQL 点**，而本版四张只有
 *     6 个源文件。**同类风险、不同爆炸半径** ⇒ 分开交付，好让每一批的"没有漏掉某个查询点"
 *     这个结论**真的能被验证**（本批要防的正是跨用户泄露，验证质量比批次整齐更重要）。
 *     ★ 中间态是安全的：`term_*` 的代码与表结构**一个字都没动**，登录用户仍能看见
 *       别人的词条——这是**改动前就有的状态**，不是本批新造的洞（`SB_REQUIRE_AUTH` 未开）。
 *   ★ 剩下的「加列即可」类（`quiz_*` / `flow_*` / `knowledge_*`）主键都是 uuid，属 **M2d-3**。
 *
 * ★★★ **归属值为什么是 `''` 而不是 `NULL`**（与 v29 的 `providers`/`role_bindings` **刻意相反**，
 *   改动前务必读完这条，这里最容易"统一一下"改坏）：
 *   · 本版四张表里，`''` = **无主行**（本地单人模式的历史数据），语义是「谁都看不见」——
 *     登录用户的查询带 `owner_id = ?`，而 `?` 恒为真实 user id，`''` 天然不匹配。
 *   · v29 那两张表里，`NULL` = **平台通道**，语义是「**所有人都看得见**」（免费额度是给
 *     全体用户用的，平台 provider 必须能被每个用户选中）。
 *   ⇒ 同一个「没有主人」的处境，在两组表里的**可见性相反**，故取值必须不同：
 *     若本版也用 `NULL`，那么「`owner_id IS NULL` 表示平台可见」这条判据一旦被跨表复用
 *     （例如某个通用 `ownerFilter`），就会把「孤儿不可见」静默变成「全站可见」——**反向泄露**。
 *   ⇒ 取值差异是**故意的**，不是历史遗留；改它之前先回答「这两组表的可见性是不是真的一样」。
 *   ★ 与 `sessions.user_id`（v22，可空 `NULL` = 孤儿）也**不同值**：那是既有事实（v22 先落），
 *     本批**不回头改 v22**，只在契约里写清两套口径的边界。
 *
 * ★★ **读写两侧同口径：都用 `ownerForWrite(ownerId)`**（`null` ⇒ `''` = 无主行）。
 *   ★ 这一条**不是"图省事"，是这些表的读形状决定的**，开工时实测踩到并纠正过一次初稿：
 *     本版四张表的读全是**单值或聚合**——`SELECT value … WHERE key/day = ?` 后 `.get()`
 *     （`app_settings` / `daily_summaries` / `user_stats`）、`SUM(count)`（`daily_activity`）。
 *     若读侧按 `ownerFilter(ownerId, 'owner_id')` 的"`null` 就不加条件"处理：
 *     · 库里一旦有多行（每用户一行），`.get()` 返回的是**任意一行** ⇒ 未登录请求读到
 *       **某个用户**的出题配比 / 回答方式偏好 / 搜索 key / **今日总结** / XP，**静默串台**；
 *     · `SUM(count)` 会把**所有人**的活动加在一起。
 *     ⇒ 故 `''` 在这里同时是"无主"与"未登录单人模式的归属值"：未登录只看无主行、
 *       登录只看自己的行。**契约 §9 第 5 条「鉴权关闭时旧行为不变」仍然成立**——
 *       未登录模式下写入的行本来就是无主行（同一把 helper），看到的就是自己的全部历史。
 *   ★ 判据一句话（写给后来者）：**读形状是"一批行"的用 `ownerFilter`（`sessions`/`user_memory`），
 *     是"一个值"的用 `ownerForWrite`（本版四张表 + M2d 其余表）。**
 *   ★ 与 `sessions.user_id`（v22，可空 `NULL` = 孤儿）也**不同值**：那是既有事实（v22 先落），
 *     本批**不回头改 v22**，只在契约里写清两套口径的边界。
 *
 * ⚠️ **连带必改，只改迁移不改那里 = 运行时 500**（同 v29 的 `ON CONFLICT(role)` 那处）：
 *   主键改复合后，**冲突目标不再是单列**，下列 upsert 语句会因「找不到匹配的唯一索引」直接报错：
 *   · `app_settings`：`ON CONFLICT(key)` —— `learning/quiz.ts` / `learning/quiz-image.ts` /
 *     `search/index.ts` / `storage/answer-style.ts` 四处；
 *   · `daily_activity`：`ON CONFLICT(day, type)` —— `learning/activity.ts`；
 *   · `daily_summaries`：`ON CONFLICT(day)` —— `learning/activity.ts`；
 *   · `user_stats`：`ON CONFLICT(key)` —— `learning/activity.ts`。
 *   ★ 这八处**没有任何编译期信号**（SQL 是字符串），只有真跑那条语句才会 500。
 *
 * ⚠️ **本版不做、但必须记账的一处口径不一致**（`learning/mention.ts`，留给 M2d-2 / v31）：
 *   `term_mention_log.owner_id`（v26 建的）走的是**另一套口径**——写入时直接落 `ownerId`
 *   （`null` ⇒ SQL `NULL`，不是 `''`），读侧 `mentionTrend` 用 `ownerFilter` 的"`null` 就不加条件"
 *   ⇒ 未登录时把**所有人**的提及量加在一起（`GROUP BY` 聚合，同本版 `daily_activity` 那条）。
 *   它属 `term_*` 家族（消费面与 `term_library` 同批），故与 `term_*` 一起在 **M2d-2** 收口；
 *   收口时**要么**迁一次 `NULL`→`''` 与本版对齐、**要么**明确声明它是 v22/v24 那套（`NULL`=孤儿）
 *   并同步改读侧——**两条路都可以，但不能不选**（原文件第 151 行的注释已把这件事记为待办）。
 *
 * ⚠️ **回放迁移链**（`storage/db.test.ts`）：本版四张表**全是重建**，没有加列，故退版本时
 *   要「DROP 掉新表 + 按旧形状建回」——**不能只 DROP**：`migrate()` 只跑 `version > current`
 *   的迁移，被跳过的 v1~v9 里的 `CREATE TABLE IF NOT EXISTS` **不会重跑**，只删不建会让
 *   整条链后面全报 `no such table`（v29 的 `revertV29` 已踩过这一条）。
 */
export const MIGRATIONS_V30: Array<{ version: number; statements: string[] }> = [
  // ── v30（2026-09-18，M2d-1：设置与反馈环四张表归主）──────────────────────────────
  //
  // 四张表的重建一律照 v24 `user_memory` / v29 `role_bindings` 的**六步先例**：
  //   ① 建新表（带 owner_id 与新约束）→ ② `INSERT … SELECT ''` 回填老行 → ③ `DROP` 旧表
  //   → ④ `RENAME` → ⑤ 重建独立索引 → ⑥ 老库的老行**一律是孤儿**（`''`），不是判给谁。
  // ★ 顺序不能变：**先 DROP 再 RENAME 再建索引**——若在 DROP 之前建索引，新表上的索引名
  //   会与旧表上同名的索引撞车（SQLite 的索引名是全库唯一的）。
  // ★ 回填值 `''` 是**唯一正确的选择**：迁移那一刻无人知道老行属于谁，判给任何用户都是
  //   把别人的数据送人；留 `''` ⇒ 谁都不泄露，主人自己认领（`_probe/claim-legacy.mjs`）。
  {
    version: 30,
    statements: [
      // ── ① app_settings：全局写口 → 每用户一份（老板 2026-09-18 拍板「变成每用户」）──
      //   老行（出题配比 / 配图 / 回答方式偏好 / 搜索 key）全部变孤儿；新用户从零开始。
      `CREATE TABLE app_settings_v30 (
        owner_id TEXT NOT NULL DEFAULT '',
        key      TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (owner_id, key)
      )`,
      `INSERT INTO app_settings_v30 (owner_id, key, value) SELECT '', key, value FROM app_settings`,
      `DROP TABLE app_settings`,
      `ALTER TABLE app_settings_v30 RENAME TO app_settings`,

      // ── ② daily_activity：`PK(day, type)` ⇒ A、B 同一天聊天直接撞主键 ──
      `CREATE TABLE daily_activity_v30 (
        owner_id TEXT NOT NULL DEFAULT '',
        day      TEXT NOT NULL,
        type     TEXT NOT NULL,
        count    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_id, day, type)
      )`,
      `INSERT INTO daily_activity_v30 (owner_id, day, type, count)
         SELECT '', day, type, count FROM daily_activity`,
      `DROP TABLE daily_activity`,
      `ALTER TABLE daily_activity_v30 RENAME TO daily_activity`,

      // ── ③ daily_summaries：`PK(day)` ⇒ B 读到 A 的今日总结（代码注释里已记账的泄露）──
      `CREATE TABLE daily_summaries_v30 (
        owner_id   TEXT NOT NULL DEFAULT '',
        day        TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (owner_id, day)
      )`,
      `INSERT INTO daily_summaries_v30 (owner_id, day, content, created_at)
         SELECT '', day, content, created_at FROM daily_summaries`,
      `DROP TABLE daily_summaries`,
      `ALTER TABLE daily_summaries_v30 RENAME TO daily_summaries`,

      // ── ④ user_stats：`PK(key)`，存的是 `xp` ⇒ A 和 B 的 XP / 等级 / 连签是同一个数 ──
      `CREATE TABLE user_stats_v30 (
        owner_id TEXT NOT NULL DEFAULT '',
        key      TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (owner_id, key)
      )`,
      `INSERT INTO user_stats_v30 (owner_id, key, value) SELECT '', key, value FROM user_stats`,
      `DROP TABLE user_stats`,
      `ALTER TABLE user_stats_v30 RENAME TO user_stats`,
    ],
  },
];
