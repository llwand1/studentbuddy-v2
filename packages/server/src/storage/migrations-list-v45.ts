/**
 * storage/migrations-list-v45 — **v45** 的迁移分片（2026-09-25，词条卡牌／宝箱／任务清单，
 * 契约 `docs/TERM-CARDS-SPEC.md`）。
 *
 * **为什么又另开一片、不追加进 `-v44.ts` 尾部**（聚合出口文件头写明的默认做法是"往最新片尾部追加"）：
 * `-v44.ts` 是同伴批次（学习流下线）**当天**刚落地的文件，且同仓此刻仍有会话在途施工 ⇒
 * 追加进去会把两批的提交顺序变成隐式耦合、并把别人的文件拉进本批 diff。
 * 这条理由与 `-v43.ts`、`-v44.ts` 自己当初立项的理由**同一条**，照此办理。
 * ★ 若本分支落地时 `-v44.ts` 已空闲，可把本项并回那片（纯搬运、零行为改动），并删掉本文件。
 *
 * ★ **零 ALTER**：本批**不给任何既有表加列**。卡牌数一律从 `term_mention_log` / `term_review_log`
 *   两张既有流水派生（契约 §1）。这不是省事，是为了绕开一条本仓踩过六次的坑——
 *   `ALTER TABLE ADD COLUMN` **不幂等**，而回放迁移链的测试必须先 DROP 掉加过的列
 *   （`duplicate column name: summary` / `: images` 两次实测）。只建新表 ⇒ 回放链天然幂等。
 *
 * ⚠️ **`term_review_log` 没有 `owner_id` 列**（v22 建、v31 全量归主时**刻意没给它加**，
 *   见 `learning/term-review.ts` 文件头：归属由 `term_id → term_library` 的连接带出来，
 *   "归属只有一处可表达"）。⇒ 本批卡牌侧那条按词条聚合复习日的语句**不写 owner 条件不是遗漏**：
 *   上层读口一律先按 `t.owner_id` 选出词条集，流水行再通过连接归属到同一批词条。
 */

// 形状照聚合出口 `migrations-list.ts` 自己声明的那一份（本仓各分片都内联这个类型，
// `migrations.ts` 不导出 `Migration` —— 别在这里发明第三个写法）。
export const MIGRATIONS_V45: Array<{ version: number; statements: string[] }> = [
  {
    version: 45,
    statements: [
      // ── 宝箱钥匙：每 owner 一行，读时按本地日历日判免费次数与今日已开是否该归零 ──
      // ★ 不用 SQL `date('now')`（UTC 日）：+8 区晚上会提前一天，与 `localDayKey` 口径冲突
      //   （`term-review.ts` 为同一件事写过注释，`free_day` 由应用层填）。
      // ★★ `free_used` 与 `opened_today` 是**两个不同的数**，别合并：前者只数免费那 3 次
      //   （跨日清零后重新从 0 涨），后者数**今天总共开了几次**（免费的 + 赚来的都算，
      //   用来对 `DAILY_OPEN_CAP` 这道日上限）。合成一个数就有两种坏法：只留免费计数则
      //   日上限形同虚设（一天用赚来的钥匙开 20 次没人拦）；只留总计数则免费额度算不出来
      //   （今天已开 5 次，其中几次是免费的？回不去了）。两列同经 `free_day` 一次归零。
      // ★ 刻意**不存** `total_keys`：可得数 = 3 − `free_used` + `earned_keys` 是派生值，
      //   落库就会出现「加过钥匙的记录没记录、扣过的没痕迹」这种无源可查的账（契约 §3 边界①）。
      // ★★★ `ready_day` 是「今天已经提醒过没有」这一件事的**唯一**存放处，别急着说"内存里记一下就行"：
      //   提醒是 6 小时 tick 发的，而 tick 在**重启后会立刻再跑一次** ⇒ 内存标记活不过重启，
      //   用户一天能收到三四条「宝箱可以开了」。日级去重只有两个诚实位置：库里的列，或
      //   从既有流水反推（`chest_open` 里今天有没有行——但那表达的是"开过"，不是"提醒过"，
      //   两者在"提醒了却没去开"这个最常见的分支上正好分开）。⇒ 存列。
      //   ★ 与 `free_day` 同为应用层填的**本地日历日**，同一个跨日归零口径，不引第二套时钟。
      `CREATE TABLE IF NOT EXISTS chest_keys (
        owner_id      TEXT    NOT NULL DEFAULT '',
        free_used     INTEGER NOT NULL DEFAULT 0,
        earned_keys   INTEGER NOT NULL DEFAULT 0,
        opened_today  INTEGER NOT NULL DEFAULT 0,
        free_day      TEXT    NOT NULL DEFAULT '',
        ready_day     TEXT    NOT NULL DEFAULT '',
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (owner_id)
      )`,

      // ── 开盒流水：一次开盒一行，存**当时冻结**的词条快照 ────────────────────────
      // ★ `term_id` 可空且**不设外键**：宝箱抽的是**词池里的条目**（`shared/chest-pool.ts` 的
      //   底座 ∪ 人工点过通过的候选），用户可能直接"不收下"
      //   （契约 §3：抽中 ≠ 进复习池，也 ≠ 进库）。收下才回填 `term_id`。
      //   如果强制非空外键，"抽到但没要"这个真实结果就没地方表达，而它恰恰是本功能最该被
      //   查到的数（每天多少人抽完就走）。
      // ★ `source_kind` 是**快照**不是外键（照 `term_mention_log.domain` 的判据）：池子条目会被
      //   改写、候选词条会被删除，若只存指针则"三个月前抽到什么"会随今天的编辑而漂移。
      // ★★ `pool_definition` 同一条理由**必须一起存**：拟稿时这里只留了 `pool_slug`，"收下"就要
      //   按 slug 回查池子——而候选可能在你刷新页面之前被人删掉/驳回，那时那张已经抽到的卡
      //   就**收不下**了（快照存一半 = 快照不成立，这是同一件事的第二次论证）。
      `CREATE TABLE IF NOT EXISTS chest_open (
        id             TEXT    NOT NULL PRIMARY KEY,
        owner_id       TEXT    NOT NULL DEFAULT '',
        opened_day     TEXT    NOT NULL,
        opened_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        source_kind    TEXT    NOT NULL,
        pool_slug      TEXT,
        pool_term      TEXT    NOT NULL,
        pool_domain    TEXT    NOT NULL DEFAULT '',
        pool_definition TEXT   NOT NULL DEFAULT '',
        term_id        TEXT,
        accepted       INTEGER NOT NULL DEFAULT 0,
        in_scope       INTEGER
      )`,
      // 防重复抽同一条：同一 owner 对同一 pool_slug 只留一次（重抽要换别人才算新词，契约 §3）
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_chest_open_pool
         ON chest_open(owner_id, pool_slug) WHERE pool_slug IS NOT NULL`,
      // 已收下 / 已入库的读形：`term_id IS NOT NULL` 时它是 `chest_open` 上唯一的归属反查路径
      `CREATE INDEX IF NOT EXISTS ix_chest_open_term ON chest_open(owner_id, term_id)
         WHERE term_id IS NOT NULL`,

      // ── 学习清单（用户向名称见契约 §9「任务清单」）：AI 每 6 小时派单，完成一单 +1 把钥匙 ──
      // ★★ 表名刻意叫 `study_task` 而**不叫** `task_item`：仓里已有 `shared/src/task-list.ts`
      //   导出 `interface TaskItem`，它是**聊天流里 AI 思考链的进度面板**（`chat-meta.ts:16` 把
      //   工具 `update_tasks` 标成「任务清单」）——两件事毫无关系，同名会在 barrel 导出与
      //   日常沟通两处同时踩坑。用户向名称的冲突处理见契约 §9。
      // ★★ `ux(owner_id, dedupe_key)` 是本表的**核心约束**，`dedupe_key` 里**不得含会变的数字**
      //   （进度百分比、剩余张数都不行）。教训直接来自 `chat/memory-digest.ts`：`user_memory` 的
      //   UNIQUE 是 `(user_id, kind, content)`，把会变的数写进 content ⇒ 数每变一次新增一行、
      //   旧行永不消失 ⇒ 两条记录互相打脸。⇒ 键取「意图」（`advance:<termId>:<目标星>`），
      //   进度数字只进 `why`（给人读的那句，不参与去重）。
      // ★ `kind` 用 ASCII 词而不是中文：与 `ModelRole` 同一条判据——**存库的是键，显示的是名**。
      //   本批同时把「学习督促」改名「任务清单」（只改显示 label 与用户向文档），
      //   若这里存中文，将来再改一次措辞就得洗一次表。
      // ★ `ref_id`：`review_pool` 那一类任务指向的是**候选行的 id**，不是词条 id。
      //   没有这一列，完成判据就只能从标题里正则抠词条名（第一版就是这么写的，测试一跑就红），
      //   或把候选 id 塞进 `term_id`（那会让 `term_id IS NOT NULL` 这个"已入库"的判据变成假话）。
      `CREATE TABLE IF NOT EXISTS study_task (
        id           TEXT    NOT NULL PRIMARY KEY,
        owner_id     TEXT    NOT NULL DEFAULT '',
        kind         TEXT    NOT NULL,
        dedupe_key   TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        why          TEXT    NOT NULL DEFAULT '',
        term_id      TEXT,
        ref_id       TEXT,
        target_star  INTEGER,
        status       TEXT    NOT NULL DEFAULT 'open',
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        done_at      TEXT,
        dispatched_at TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_study_task_dedupe ON study_task(owner_id, dedupe_key)`,
      // 列表读形：「这个人还有哪几单没做完」，`status` 参与键因为 open 集永远远小于全量
      `CREATE INDEX IF NOT EXISTS ix_study_task_owner_status ON study_task(owner_id, status, created_at)`,

      // ── 词池候选：AI 生成的新词在这里排队，逐条点通过才可抽 ─────────────────────
      // ★ `UNIQUE(owner_id, term, domain)` **故意照抄 `term_library` 的弱约束**：
      //   它**不防别名重复**（`term-corpus.ts` 里「主动回忆」的 alias 原文就写「也叫提取练习」）。
      //   这里不修是因为别名感知**归抽卡逻辑**（服务端 SQL 表达不了跨列集合判据，见 `chest.ts`），
      //   本表只保证「同一条不会被生成两遍」。★ 不要误以为这张表防住了别名撞车。
      // ★ `status` 三态而非布尔：`rejected` 必须留行不能删——删了下次生成同一个词又会回来，
      //   用户会看到自己明确否过的建议反复出现（这是"AI 主动"类功能最常见的反向体验）。
      `CREATE TABLE IF NOT EXISTS term_pool_candidate (
        id           TEXT    NOT NULL PRIMARY KEY,
        owner_id     TEXT    NOT NULL DEFAULT '',
        term         TEXT    NOT NULL,
        domain       TEXT    NOT NULL DEFAULT '',
        definition   TEXT    NOT NULL DEFAULT '',
        aliases      TEXT    NOT NULL DEFAULT '[]',
        status       TEXT    NOT NULL DEFAULT 'pending',
        source       TEXT    NOT NULL DEFAULT 'ai',
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        decided_at   TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_pool_candidate ON term_pool_candidate(owner_id, term, domain)`,
      `CREATE INDEX IF NOT EXISTS ix_pool_candidate_status ON term_pool_candidate(owner_id, status, created_at)`,
    ],
  },
];
