/**
 * v54（2026-10-02 番茄钟流水：`pomodoro_log`，契约 docs/POMODORO-SPEC.md §10）
 *
 * 一行 = 「这个人完成了一个工作段」。此前番茄钟只存**当前状态**（`app_settings` 键 `pomodoro`），结束即清——
 * 于是「今天专注了几轮 / 这周哪个方向最多」无从得知，而督促小窗的学习可视化恰恰要回答这类问题。
 * - 只记**完成**的工作段（翻到休息 / 再来一轮 / 提前休息都算完成；中途「结束番茄钟」的那半轮不记）。
 * - `day` 用与 `growth_action_day` / `user_activity_day` 同一把 `localDayKey`（服务器本地日）。
 * - `owner_id` 与 `app_settings` 同口径：`''` ＝ 本地单人无主行。
 * ★ 新表 + CREATE IF NOT EXISTS（不 ALTER 旧表，理由同 v47–v53）。
 */
export const MIGRATIONS_V54: Array<{ version: number; statements: string[] }> = [
  {
    version: 54,
    statements: [
      `CREATE TABLE IF NOT EXISTS pomodoro_log (
        id        TEXT PRIMARY KEY,
        owner_id  TEXT NOT NULL DEFAULT '',
        subject   TEXT NOT NULL,
        work_min  INTEGER NOT NULL,
        round     INTEGER NOT NULL,
        day       TEXT NOT NULL,
        ended_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pomodoro_log_owner_day ON pomodoro_log(owner_id, day)`,
    ],
  },
  /**
   * v55（2026-10-05 应试模式范围联动：词条的**真来源**，契约 docs/EXAM-MODE-SPEC.md §11）
   *
   * `term_source` ＝ 「这个词条是从哪个网址长出来的」。**旁表而不是给 `term_library` 加列**，
   * 理由与 v47 那条一字不差：`ALTER TABLE ADD COLUMN` 不幂等，`db.test.ts` 那批
   * 「退版本重放迁移链」的锁会撞 duplicate column，而 `term_library` 在 v31 被整表重建过、
   * 加列还得同步改那边的列清单。旁表 `CREATE IF NOT EXISTS` 天然可重放。
   *
   * 为什么要这张表：应试模式要把词条（以及由词条派生的卡牌、知识大陆地块与怪、刷词队列）
   * 按用户圈定的考试范围过滤，而**范围是按站点定义的**。此前全仓没有任何一处把词条与来源网址
   * 连起来——`term_library` 18 列里只有 `source_session_id`（会话粒度、N:M、手输/宝箱/开拓/刷词
   * 四条路径为 NULL），2026-10-05 现查本机库：331 条词条、`message_source` 0 行 ⇒ 借会话反推
   * 只能给出「这个会话读过哪些站」，给不出「这个词来自哪一站」。
   *
   * ★ 三条设计取舍：
   *  - **一个词条可以有多行**（同词在不同轮次被不同页面喂出来），故 `(term_id, url)` 唯一而不是
   *    `term_id` 唯一。范围判定取「任一来源命中即算在范围内」，宁可少滤不可错杀。
   *  - `host` 与 `url` **同时存**：过滤是每条读路径都要做的、按 host 判，若每次现 `new URL()`
   *    就等于把解析成本摊到每个列表接口上。写入时归一化一次，读侧只做字符串比较。
   *  - **没有外键**：删词条走 `learning/terms.ts` 的既有删除口，那边同步清这张表
   *    （`deleteTermSources`）；孤儿行只会让范围判定偏松（多算一个来源），不会崩，故不上 FK。
   *  - `origin` 记「哪条路带来的」：`chat`（对话后抽词）/ `tool`（`upsert_term` 存词）/
   *    未来若有网页资料导入再扩值。老库升级后这张表是**空的**——范围过滤对历史词条的效果就是
   *    「看不见」，这是空态引导要解释的那件事，不是 bug。
   */
  {
    version: 55,
    statements: [
      `CREATE TABLE IF NOT EXISTS term_source (
        id         TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL DEFAULT '',
        term_id    TEXT NOT NULL,
        url        TEXT NOT NULL,
        host       TEXT NOT NULL,
        origin     TEXT NOT NULL DEFAULT 'chat',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_term_source_term_url ON term_source(term_id, url)`,
      `CREATE INDEX IF NOT EXISTS idx_term_source_owner ON term_source(owner_id)`,
    ],
  },
];
