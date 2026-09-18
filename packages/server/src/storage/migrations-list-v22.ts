/**
 * storage/migrations-list-v22 — 迁移清单数据 **v22 及之后**（多租户归属 + 复习期 + 长期画像归主）。
 *
 * 2026-09-18 四次拆分：v24（长期画像归主，契约 docs/TENANCY-SPEC.md §7）加完后 `-v18.ts` 涨到 413 行，
 * 触 AGENTS.md「.ts ≤400 行」红线。照本仓既有规矩（**按版本区间再切，不要用压注释换行数**）
 * 把 v22~v28 切到本文件——分片注释记的是每张表**为什么这么建**，价值远高于行数。
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
  // ── v26 词条提及流水（契约 docs/MEMORY-TREND-SPEC.md §1，2026-09-18）────────────
  //
  // 背景：词条库此前只有一个**累加器** `usage_count`（`learning/terms.ts` 的 `countUsage`）。
  // 累加值能答「一共提了多少次」，**答不了「什么时候提的」**——而老板点单的四件事里
  // 有三件是时间维度的（近期趋势、领域近期提及、趋势图），没有逐次记录就**算不出来**。
  //
  // ★ 为什么 `domain` 直接落在流水上（**冗余快照**，不是外键）：词条可以被改领域
  //   （`tidy.renameDomain` / 手动编辑）、也可以被删除。若只存 `term_id` 再 JOIN 取领域，
  //   那么"三个月前属于算法、今天被挪到网络"的词条会让**历史趋势整体漂移**——
  //   同一张图昨天看是"算法涨了"、今天变成"网络涨了"，而用户什么都没做。
  //   流水是历史事实，事实必须当场冻结（同 `evolution_event` 的冗余快照手法）。
  //
  // ★ `owner_id` **可空且不设 DEFAULT ''**：沿用 v25 `coach_messages` 的口径
  //   （null ＝ 未登录的单人本地模式）。与 v24 `user_memory` 的 `''` **刻意相反**——
  //   那里用 `''` 是被 `ON CONFLICT` 的冲突目标必须匹配唯一索引**列**这一点强制的；
  //   本表没有唯一键，就该让 null 保持"无主"语义，不把两者混成一个值。
  //
  // ★ `mentioned_day` 冗余落库（同 v23 `term_review_log.reviewed_day`）：与"派生值一律现算"
  //   （v23 拒绝落 `next_review_at`）**不矛盾**——那条针对的是**业务口径会变**的派生值
  //   （间隔序列一改就得洗全表）；日历日是**稳定口径**，且按天聚合是最高频查询，
  //   `date(mentioned_at)` 这种函数表达式走不了索引。
  //   ⚠️ 该列由应用层用 `localDayKey(now)` 填（**本地**日历日），**不靠 `date('now')`**
  //   ——那是 UTC 日，在 +8 区晚上会错一天（日期段批已吃过一次）。
  //
  // ★ 本表**只增不删**，且**不做历史回填**：历史 `usage_count` 没有任何时间信息，
  //   按当前时间批量补行＝**造假数据**（趋势图会显示一批用户根本没发生过的"提及"）
  //   ⇒ 宁可从零开始积累。故「总提及数」（走 usage_count，含历史）与
  //   「近期提及数」（走本表，只有建表之后）**是两个不可互相校验的口径**（契约 §1.5）。
  {
    version: 26,
    statements: [
      `CREATE TABLE IF NOT EXISTS term_mention_log (
        id            TEXT PRIMARY KEY,
        term_id       TEXT NOT NULL,
        domain        TEXT NOT NULL,
        owner_id      TEXT,
        mentioned_at  TEXT NOT NULL DEFAULT (datetime('now')),
        mentioned_day TEXT NOT NULL DEFAULT (date('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_term_mention_term ON term_mention_log(term_id)`,
      `CREATE INDEX IF NOT EXISTS idx_term_mention_day ON term_mention_log(mentioned_day)`,
      `CREATE INDEX IF NOT EXISTS idx_term_mention_lookup ON term_mention_log(owner_id, domain, mentioned_day)`,
    ],
  },

  // ── v27 邮箱验证码（契约 docs/AUTH-SPEC.md §1 `auth_codes` / §4.5，2026-09-18 M1.5）──
  //
  // 背景：v21 的登录只认密码 ⇒ **忘密码 = 账号永久失联**（SPEC §6 第 3 条，此前唯一的
  //   「账号丢失无出路」缺口），且注册不验证邮箱归属。本表是「证明你是这个邮箱的主人」
  //   的唯一载体，同时给 `purpose: 'register'`（邮箱验证）与 `'reset'`（找回密码）留位。
  //
  // ★ 主键刻意用自增 `id`，**不是 `email`**：同一邮箱会**多次**请求验证码——
  //   以 email 为主键就只能覆盖，旧码无法保留（重放审计失去依据）；更糟的是并发请求下
  //   `INSERT OR REPLACE` 会**静默吞掉正在校验的那一条**（用户手里是新码、库里的行已换，
  //   表现为「码明明是对的却总说不对」，且不可复现）。
  //
  // ★ 只存 `code_hash`（SHA-256 十六进制）不存明文，同 `auth_sessions.token_hash` 的取向：
  //   拖库拿到的是一堆哈希，不能直接拿去登录。
  //   ⚠️ **但哈希本身不是防线**——6 位数字只有 10^6 空间，离线爆破是秒级的事。
  //   真正的防线是 `attempts` 上限 + 发送侧三道限流（§4.5）；哈希只是第二道。
  //
  // ★ `attempts` / `consumed_at` 是**状态列**，不是派生值（不适用「派生值一律现算」）：
  //   `attempts` 每次校验失败自增，达 `AUTH_CODE_MAX_ATTEMPTS` 即作废——**不靠过期兜底**，
  //   因为 5 分钟窗口对一个脚本足够试几百次；`consumed_at` 非空 = 已用过，
  //   校验成功**立刻**写入 ⇒ 重放同一个码必失败（一次性）。
  //
  // ★ `purpose` 按用途隔离（login / register / reset）：**登录的码不能拿去改密码**，
  //   否则「为登录而发」的码泄露一次就等于密码重置权泄露一次。
  //   不在库层写 CHECK：用途集合还会长（本批只接线了 `login` 一个消费端点），
  //   加 CHECK 就得为每个新用途配一次迁移；脏值由域层归一
  //   （`shared/auth.ts#normalizePurpose`，同 v25 `coach_messages.kind` 的取舍）。
  //
  // ★ `email` **不设外键**：验证码可以**先于注册**存在（`register` 态就是给还没有的账号发码）。
  //
  // ★ 索引取 `(email, purpose)` 而非单列：取「最新一条未消费码」与「发新码时作废同用途旧码」
  //   是仅有的两个高频查询，两者都按这两个维度定位。
  //
  // ★ 本迁移是**纯建表**（`CREATE TABLE IF NOT EXISTS`），与 v18/v19/v21/v25/v26 同属
  //   幂等型 ⇒ 回放迁移链**无需额外 DROP**（对比 v22/v23 的 `ADD COLUMN` 必须退列）。
  {
    version: 27,
    statements: [
      `CREATE TABLE IF NOT EXISTS auth_codes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        email       TEXT NOT NULL,
        code_hash   TEXT NOT NULL,
        purpose     TEXT NOT NULL,
        expires_at  INTEGER NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        consumed_at INTEGER,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_auth_codes_email_purpose ON auth_codes(email, purpose)`,
    ],
  },

  // ── v28 复习范围（契约 docs/EBBINGHAUS-SPEC.md §9，2026-09-18）──────────────────
  //
  // 背景：v23 给每个词条装了复习时钟，但**没给"谁该复习"这个开关**——`rowsAll()` 扫全表，
  //   278 条词条一律进池。而词条库是 AI 从**全部对话**里自动抽的，里面混着娱乐/闲聊词条
  //   （实测老板库 `general` 域 66 条里既有「阈值」「认知偏差」也有「谐音梗」「二创」「邪典片」）
  //   ⇒ 复习队列被稀释，真正要背的术语淹在里面。本迁移把复习改成**选择式**：
  //   只有用户点过的领域/词条才复习。
  //
  // ★ **两列，不是一列**（领域开关 + 词条覆盖，`NULL` = 继承领域）：
  //   只做词条级的话，AI 每轮对话都会往已选领域里加新词，**新词默认不进池且用户不会察觉**
  //   （复习池静默漏词，是那种几个月后才发现的功能性缺陷）；只做领域级的话，
  //   `general` 这种"正经词与娱乐词混装"的域只能整块砍掉，没法只留「阈值」砍「谐音梗」。
  //   两层并用才有"领域批量、词条微调"的效果，且新词自动跟随领域。
  //
  // ★ **为什么 `term_library.review_enabled` 可空**（`NULL` = 继承领域开关）：
  //   这是**唯一**能让"领域开关对新词条生效"与"词条可单独反选"同时成立的表示。
  //   若给它 `NOT NULL DEFAULT 0`，那么"新词条默认关闭"与"领域已开启"就冲突，
  //   只能靠写入侧回填（`saveTerms` 每次 INSERT 前查领域开关）——那是**第二份口径**，
  //   本仓在 `messages.user_id` / `auth_sessions.expires_at` 上为这类漂移付过两次学费。
  //   ⇒ 让"继承"在**读取侧**用 `COALESCE(t.review_enabled, d.review_enabled, 0)` 现算，
  //     写入侧一个字都不用改（新词条不写这一列，自然是 NULL = 跟随领域）。
  //
  // ★ **`term_domain.review_enabled` 的 `DEFAULT 0` = 默认全不选**（老板 2026-09-18 拍板）：
  //   词条库里娱乐内容占比不低，默认全选等于让用户先去"关掉一堆"，默认全不选则是"点自己
  //   要背的"。老库升级后**复习池为空**——已有进度（`review_stage`/`last_reviewed_at`）**不丢**，
  //   只是暂时不被催；重新纳入范围时按拍板口径**清零重来**（见 learning/term-review.ts）。
  //   孤儿域（词条 domain 不在登记册）取不到 `d.review_enabled` ⇒ `COALESCE` 落到 0，同样默认不复习。
  //
  // ⚠️ `ALTER TABLE ADD COLUMN` **不幂等**：回放迁移链的测试必须退版本时删掉这两列
  //   （本仓 v16/v17/v22/v23 已四次踩过 `duplicate column name`），见 `storage/db.test.ts`。
  // ⚠️ 回放**先删索引再删列**：`idx_term_library_review_enabled` 建在新列上，
  //   SQLite 不留悬空索引，直接 `DROP COLUMN` 会报 "error in index ... after drop column"。
  {
    version: 28,
    statements: [
      `ALTER TABLE term_domain ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE term_library ADD COLUMN review_enabled INTEGER`,
      `CREATE INDEX IF NOT EXISTS idx_term_library_review_enabled ON term_library(review_enabled)`,
    ],
  },
];
