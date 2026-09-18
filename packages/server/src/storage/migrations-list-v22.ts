/**
 * storage/migrations-list-v22 — 迁移清单数据 **v22 及之后**（多租户归属 + 复习期 + 长期画像归主）。
 *
 * 2026-09-18 四次拆分：v24（长期画像归主，契约 docs/TENANCY-SPEC.md §7）加完后 `-v18.ts` 涨到 413 行，
 * 触 AGENTS.md「.ts ≤400 行」红线。照本仓既有规矩（**按版本区间再切，不要用压注释换行数**）
 * 把 v22~v25 切到本文件——分片注释记的是每张表**为什么这么建**，价值远高于行数。
 * ★ 本文件是**追加新迁移的唯一落点**（v22 及之后）；v18~v21 在 `-v18.ts`，v10~v17 在 `-v10.ts`。
 *
 * ⚠️ 回放迁移链的测试必须把**加列**也 DROP 掉（`ALTER TABLE ADD COLUMN` 不幂等，
 * 本仓实测踩过 `duplicate column name: summary` / `: images`，见 `storage/db.test.ts`）。
 * ⚠️ 迁移里的**建表重建**（v24 的 `user_memory`）在回放时是安全的：它先建新表再 DROP 旧表，
 * 不依赖旧表已有该列，故退版本重放无需额外 DROP。
 */
export const MIGRATIONS_V22: Array<{ version: number; statements: string[] }> = [
  // ── v22（2026-09-17，多租户隔离 M2a：会话归属，契约 docs/TENANCY-SPEC.md）──
  //
  // 背景：v21 有了账号，但 `sessions` 仍是一张**全局大表**——`GET /api/sessions` 返回
  // `WHERE deleted_at IS NULL` 的全部会话 ⇒ **所有访客互相看到对方的聊天记录**。这是数据泄露，
  // 也是"能不能上线"的唯一开关（与登录方式正交：邮箱/微信/手机号都得做这一层）。
  //
  // ★ 为什么**只给 sessions 加 user_id**、不给 messages：归属必须有且只有一个事实源。
  //   给 `messages` 也加一列，就会同时存在 `sessions.user_id` 与 `messages.user_id`，
  //   二者漂移后"这条消息归谁"没有答案——本仓已在 register/me 的 `createdAt` 上为
  //   「两个事实源」付过一次学费。⇒ **子表随父表**（messages / ask_choices / flow_run 都不加列），
  //   读子表前统一断言父会话归属（auth/ownership.ts `canAccessSession`）。
  //
  // ★ 为什么 `user_id` **可空**：老库已有会话，迁移那一刻**无人知道它们属于谁**，
  //   强行回填成某个用户＝把别人的历史聊天判给他。故留 NULL，语义是"孤儿行"：
  //   登录用户的查询都带 `WHERE user_id = ?`，NULL 天然不匹配 ⇒ **不泄露**，
  //   代价是主人也暂时看不到，需显式认领（_probe/claim-legacy.mjs）。
  //   ★ 刻意不做"首个注册者自动认领"——并发注册时归属不确定且无法撤销。
  //
  // ⚠️ `ALTER TABLE ADD COLUMN` **不幂等**：只回滚版本号重放会报 `duplicate column name`
  //   （本仓 v18 踩过）。回放迁移链的测试须整表 DROP 重建，见 `storage/db.test.ts`。
  {
    version: 22,
    statements: [
      `ALTER TABLE sessions ADD COLUMN user_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    ],
  },

  // ── v23（2026-09-17，艾宾浩斯遗忘曲线复习，契约 docs/EBBINGHAUS-SPEC.md）──
  //
  // 背景：词条库（`term_library`）此前是「只进不出」的仓库——AI 抽进去就算完，
  // 用户没有任何机制回到旧词条 ⇒ 入库越勤、欠账越多，这恰恰违背「忆」这一环。
  // 本迁移给每个词条装上**复习时钟**，复习计划由 `shared/ebbinghaus.ts` 的经典节点
  // （1/2/4/7/15/30/60 天）推导，**库里不存「下次复习时间」**（见下）。
  //
  // ★ **为什么只存 `review_stage` + `last_reviewed_at`，不存 `next_review_at`**：
  //   `next_review_at` 是从这两个值**推导**出来的（基准日 + 本阶段间隔）。一旦落库，
  //   将来调整间隔序列（比如把 4 天改成 3 天）就必须洗一遍全表，否则新老行口径分裂
  //   ——本仓在 `sessions.summary_upto_rowid` 与 `auth_sessions.expires_at` 上已经两次
  //   吃过「派生值落库」的亏。**派生值一律现算**（同 `docMeta.truncated` 手法）。
  //
  // ★ **为什么 `last_reviewed_at` 可空**：语义是「**从未复习过**」，与「复习过但时间未知」
  //   必须区分——前者要退到 `created_at` 当起算点（否则新词条永远显示 0 天、永不进队列），
  //   后者是脏数据。用 NOT NULL + 哨兵值（如 1970）会让「没复习」看起来像「很久没复习」。
  //
  // ★ `term_review_log` 只追加不更新（**复习流水**，不是状态表）：状态在 `term_library` 两列上，
  //   流水只回答「哪天复习了几个、记住/忘了各多少」——那是督促 AI 与曲线图的输入。
  //   `reviewed_day` 由应用层用 `localDayKey(now)` 填（与 `computeReviewState` 同日历口径，
  //   **不靠 `date('now')`**——那是 UTC 日，在 +8 区晚上会错一天；列上的 DEFAULT 只是兜底）。
  //
  // ⚠️ `ALTER TABLE ADD COLUMN` **不幂等**：回放迁移链的测试必须整表 DROP 重建或退版本时
  //   删掉这两列（本仓 v16/v17/v22 三次踩过 `duplicate column name`），见 `storage/db.test.ts`。
  {
    version: 23,
    statements: [
      `ALTER TABLE term_library ADD COLUMN review_stage INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE term_library ADD COLUMN last_reviewed_at TEXT`,
      `CREATE TABLE IF NOT EXISTS term_review_log (
        id           TEXT PRIMARY KEY,
        term_id      TEXT NOT NULL,
        stage        INTEGER NOT NULL,
        remembered   INTEGER NOT NULL,
        reviewed_at  TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_day TEXT NOT NULL DEFAULT (date('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_term_review_log_term ON term_review_log(term_id)`,
      `CREATE INDEX IF NOT EXISTS idx_term_review_log_day ON term_review_log(reviewed_day)`,
      `CREATE INDEX IF NOT EXISTS idx_term_library_last_reviewed ON term_library(last_reviewed_at)`,
    ],
  },
  // v24：多租户 M2b —— 长期画像 `user_memory` 归主（契约 docs/TENANCY-SPEC.md §7）。
  //
  // ★ 为什么必须**重建表**而不是 `ADD COLUMN`：v13 建表时写了 `UNIQUE(kind, content)`，
  //   那是**全局**唯一键。多用户下两个人沉淀出同一句画像（「喜欢先看例子」这种极常见），
  //   B 的 `ON CONFLICT(kind, content) DO UPDATE` 会**改写 A 那一行**：
  //     · B 的记忆永远写不进去（写完再按 user_id 过滤，B 看不到）；
  //     · A 的 importance / updated_at 被陌生人刷新；
  //     · 更糟的是 B 的隐私内容**落进了 A 的行里**，A 打开记忆页就看见了。
  //   一条约束同时造成「串台 + 污染 + 泄露」，而 `ALTER TABLE` 改不了约束 ⇒ 只能重建。
  //
  // ★ 唯一键取 `UNIQUE(user_id, kind, content)` 而非 `UNIQUE(kind, content, user_id)`，
  //   且 `user_id` **NOT NULL DEFAULT ''**（`''`＝无主/遗留）——用列而不是
  //   `COALESCE(user_id,'')` 表达式索引，是因为 `ON CONFLICT` 的冲突目标必须匹配
  //   唯一索引的**列**，表达式索引在这里会退化成「无冲突目标」而直接报错。
  {
    version: 24,
    statements: [
      `CREATE TABLE user_memory_v24 (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL DEFAULT '',
        kind              TEXT NOT NULL,
        content           TEXT NOT NULL,
        source_session_id TEXT,
        importance        REAL NOT NULL DEFAULT 0.5,
        usage_count       INTEGER NOT NULL DEFAULT 0,
        last_used_at      TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, kind, content)
      )`,
      `INSERT INTO user_memory_v24 (id, user_id, kind, content, source_session_id, importance, usage_count, last_used_at, created_at, updated_at)
         SELECT id, '', kind, content, source_session_id, importance, usage_count, last_used_at, created_at, updated_at FROM user_memory`,
      `DROP TABLE user_memory`,
      `ALTER TABLE user_memory_v24 RENAME TO user_memory`,
      `CREATE INDEX IF NOT EXISTS idx_memory_kind ON user_memory(kind, importance DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_memory_owner ON user_memory(user_id)`,
    ],
  },
  // ── v25 督促小窗流水（契约 docs/COACH-SPEC.md，2026-09-18「B+C+E」批）────────────
  //
  // ★ 为什么单开一张表，而不是塞进 sessions/messages：督促小窗**不是一次对话**，它是
  //   一条长期的学习陪伴流水——`AI 说的话 / 我说的话 / 我复习打卡这个动作` 三种事实都记在这里。
  //   塞进 sessions 会让它出现在侧栏「历史对话」列表里（它不该出现在那儿），且 chat 的
  //   上下文压缩/截断会拿它当普通聊天处理；而它的上下文另有来源（复习快照，见 learning/coach.ts）。
  // ★ `owner_id` **可空且不设 DEFAULT ''**：与 `auth/ownership.ts` 的「未登录单人本地模式」
  //   同一语义（null＝不过滤）。给个 `''` 兜底会把「无主」与「空串用户」混成一个值，
  //   而这两者此后可能要分开处理（与 v24 user_memory 的取舍相反——那里 `''` 是为了
  //   匹配 UNIQUE 冲突目标的列，由 `ON CONFLICT` 的语义强制的）。
  // ★ `kind` 取值由契约 `shared/coach.ts` 的 `CoachCard` 决定：ai / me / nudge / review。
  //   不在库层写 CHECK —— 卡片形态还在长（老板明说"可开发点很多"），加 CHECK 就得为
  //   每种新卡配一次迁移；脏值由域层归一（`learning/coach.ts` 的 parseKind）。
  {
    version: 25,
    statements: [
      `CREATE TABLE IF NOT EXISTS coach_messages (
        id         TEXT PRIMARY KEY,
        owner_id   TEXT,
        kind       TEXT NOT NULL,
        content    TEXT NOT NULL,
        meta       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_coach_owner ON coach_messages(owner_id, created_at)`,
    ],
  },
];
