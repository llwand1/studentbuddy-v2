/**
 * storage/migrations-list-v46 — **v46** 的迁移分片（2026-09-27，聊天题卡答题留痕，契约 issue #56）。
 *
 * ★ 为什么又另开一片（同 `-v43/-v44/-v45` 三次沿用的那条理由，第四次）：
 *   `-v45.ts` 是同伴批次（词条卡牌／宝箱）当天落地、当天合入 main 的文件，
 *   追加进去会把两批的提交顺序变成隐式耦合、并把别人的文件拉进本批 diff。并片随时可做（纯搬运）。
 *
 * ★ **零 ALTER**：本批不给任何既有表加列，只建两张新表 ⇒ 回放迁移链天然幂等
 *   （`ALTER TABLE ADD COLUMN` 不幂等是本仓踩过六次的坑，见聚合出口文件头 ⚠️ 那一条）。
 *
 * ★★ 这两张表合起来解决的是 issue #56 的原始症状：`quiz_answered` 事件类型**自诞生起就没有发布者**
 *   （声明在 `events/bus.ts:25`、XP=3 的消费在 `learning/activity.ts:188`，两处都由 `fc55b7e`
 *   「M4 反馈环」引入；`git log -S "type: 'quiz_answered'"` 全仓只命中那一条 ⇒ 发布者**从来没有过**，
 *   不是 09-26 被删掉的）。⇒ 聊天里答的题一行痕迹都不留，XP 里「答题」这一档永远是 0；
 *   而随 `a087e67` 下线的 `/stats/record` 写的是另一张表（`quiz_stats`）、发的也不是这个事件，
 *   所以那条链断线**不是**本症状的成因，两件事只是在同一批文档里被混说过一次
 *   （更正记在 `docs/metrics-product.md` §5 与 PR #57，与本批是两回事）。
 *   `quiz_block` 提供**答案钥匙**（服务端复判的前提），`quiz_answer_log` 提供**痕迹**。
 *   两张缺一不可：只有 log 就没法复判（前端报的对错不可信，老板 2026-09-27 拍板），
 *   只有 block 就还是没痕迹。
 */

// 形状照聚合出口 `migrations-list.ts` 自己声明的那一份（各分片都内联这个类型）。
export const MIGRATIONS_V46: Array<{ version: number; statements: string[] }> = [
  {
    version: 46,
    statements: [
      // ── 答案钥匙：出卡那一刻把**整道题**（含 `answer`）另存一行 ──────────────────
      // ★ 为什么要复制一份——`messages.content` 里那行 `[QUIZ]…[/QUIZ]` **本来就带着答案**
      //   （`quiz-announce.ts::quizRowContent` 写的是 `{...quiz, quizId}`），所以这张表
      //   **没有增加任何新的泄露面**，它只是把"服务端要按题号取答案"这件事从
      //   「正则抠一行文本再 JSON.parse」变成「主键查一行」。
      //   ⚠️ 不复用 messages 的理由是脆：那条路径的解析阶梯有五级（坏转义／截断救援，
      //   见 `parseQuizBlock`），且消息可被会话清理改写——判分依据不能建在一个"尽力解析"上，
      //   错了就表现为"这道题系统说你答错了但其实答案没解析出来"。
      // ★ `session_id` 是这张表**唯一的归属来源**，log 表不重复存（见下）。
      //   与 `term_review_log` 同一条判据：归属只有一处可表达（v45 分片头注把这条写得很清楚），
      //   两处都存就会出现「词条换了主人、旧流水跟不跟」这种无解的账。
      //   ⇒ 按人聚合时先按 `sessions.user_id` 选会话集，流水经 `quiz_id → quiz_block` 连接归属。
      // ★ 未登录（单人本地模式）时 `sessions.user_id` 是 NULL，归属自然为 null，
      //   与 `ownerOfSession()` 的既有口径一致，本表不为此加特判列。
      `CREATE TABLE IF NOT EXISTS quiz_block (
        quiz_id    TEXT    NOT NULL PRIMARY KEY,
        session_id TEXT    NOT NULL,
        questions  TEXT    NOT NULL,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      )`,
      // 会话删除时的反查（本批不做级联删除，但读形状「这个会话出过哪些卡」现在就定下来）
      `CREATE INDEX IF NOT EXISTS ix_quiz_block_session ON quiz_block(session_id, created_at)`,

      // ── 答题流水：一次**可判分**的作答一行，只追加不更新（照 `term_review_log` 的形状）──
      // ★★ `correct` 由服务端复判写入（`shared/quiz-judge.ts`），**不是前端报的那个布尔**。
      //   前端仍调同一个纯函数做即时反馈，但最终落库以服务端为准——这正是"服务端复判"
      //   这条拍板在表结构上的落点：如果这里存的是前端回报，列名就该叫 `reported_correct`。
      // ★ `qtype` 是**快照**不是派生列（照 `chest_open.source_kind` 的判据）：
      //   出题模型下次可能把同一道题出成别的题型、题面也可能被改写，而「三个月里判断题的
      //   正确率」必须能在**当时的题型**下解释。用 `type` 这个列名会和 JOIN 侧的
      //   `term_library.type` / `models.type` 混读，故带 `q` 前缀标明它是题目的类型。
      // ★ `answered_day` 由**应用层**用 `localDayKey(now)` 填，不靠 `date('now')`：
      //   那是 UTC 日，在 +8 区晚上会错一天（`term_review_log.reviewed_day` 为同一件事写过注释）。
      //   ⚠️ 这里**故意不给 DEFAULT**：给了兜底就等于允许写手忘了填而静默落 UTC 日，
      //   而这张表唯一的用途就是按日聚合——错一天的行是脏数据而不是缺数据，缺数据反而诚实。
      // ★★ 刻意**不存** `latency_ms`／`hint_used`（老板 2026-09-27 选「最小可用集」）：
      //   前者没有诚实的起算点（翻解析的时机在 React state 里，跨刷新就断了），
      //   后者本批没有数据源（题卡上没有"提示"这个动作）。
      //   留 NULL 列占位在语义上就是"等着灌假数"，而这两列一旦进表就会被下游当成真读引用。
      `CREATE TABLE IF NOT EXISTS quiz_answer_log (
        id             TEXT    NOT NULL PRIMARY KEY,
        quiz_id        TEXT    NOT NULL,
        question_index INTEGER NOT NULL,
        qtype          TEXT    NOT NULL,
        correct        INTEGER NOT NULL,
        answered_day   TEXT    NOT NULL,
        answered_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      )`,
      // ★★★ 一道题**只记第一次作答**：`(quiz_id, question_index)` 唯一。
      //   这不是防刷的附加保险，是这张表能不能被解释的前提——`quiz_answered` 事件给 XP=3，
      //   不去重 ⇒ 刷新页面重答同一题就能无限刷分。⚠️ 被删的旧链**没有**这个问题，
      //   因为它根本不发事件：`quiz_stats` 的写手 `recordAnswer` 是每次作答 `attempts+1`
      //   的累加器（`git show a087e67^:packages/server/src/learning/quiz-record.ts`），
      //   刷新确实会放大它的读数，但放大的是没人据此发 XP 的一张统计表。
      //   ⇒ 本批把"计数"换成"事件"，就必须同时把"可重复"换成"首答唯一"，不能只搬一半。
      //   同时它也定义了"正确率"的口径：**首答正确率**。重答不覆盖首答（表只追加），
      //   所以"后来答对了几次"这个数本批**量不出来**——要量就得再加一列尝试序号，
      //   那是下一批的事，不在这里暗示一个不存在的读数。
      //   ★ 冲突时写手走 `ON CONFLICT DO NOTHING`（见 `learning/quiz-answer.ts`），
      //     不靠 catch 唯一约束异常——异常路径会把"已记过"和"库锁了"混成同一种失败。
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_quiz_answer_once ON quiz_answer_log(quiz_id, question_index)`,
      // 按日聚合（指标账 §2 那张表要的就是这个形状）
      `CREATE INDEX IF NOT EXISTS ix_quiz_answer_day ON quiz_answer_log(answered_day)`,
    ],
  },
];
