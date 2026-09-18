/**
 * storage/migrations-list-v10 — 迁移清单数据 **v10~v17**（PK 域 + 过程回放 + 刷题笔记 +
 * 对话呈现形态 + 方案选择框 + 对战历史 + 长期记忆 + 看图）。
 *
 * 2026-09-16 二次拆分（同批：`-v1-9.ts`）；**2026-09-17 三次拆分**：v21 加完后本文件涨到 426 行、
 * 触 400 红线，照「按版本区间再切」的规矩把 **v18~v21 切去 `-v18.ts`**（增量落点现在在那边）。
 *
 * ⚠️ 回放迁移链的测试必须把**加列**也 DROP 掉（`ALTER TABLE ADD COLUMN` 不幂等，
 * 本仓实测踩过 `duplicate column name: summary` / `: images`，见 `storage/db.test.ts`）。
 */
export const MIGRATIONS_V10: Array<{ version: number; statements: string[] }> = [
  // v10：PK 登录（2026-09-09 契约 docs/PK-SPEC.md P0-1）——账号 = pk_users 一条记录。
  // openid 现为模拟值（mock_<id>），P1 换真微信授权时只改写入方，表结构与唯一约束已按真 openid 设计。
  {
    version: 10,
    statements: [
      `CREATE TABLE IF NOT EXISTS pk_users (
        id TEXT PRIMARY KEY,
        openid TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ],
  },
  // v11：过程回放（2026-09-12）——把「思考」与「任务清单」随消息一起落库。
  // 此前两者只活在 SSE 流里（flow.ts 原注释：「推理内容仅流式呈现（不落库）」），
  // 刷新或重开会话即永久丢失；主流（Claude / ChatGPT）把过程归属于那条回答并持久化回放。
  // 与 v1 的 tool_calls 同一口径：**过程属于消息，不属于页面**。
  // reasoning 存原文（思考链是学习场景的答案组成部分）；tasks 存 update_tasks 最后一次的全量 JSON。
  {
    version: 11,
    statements: [`ALTER TABLE messages ADD COLUMN reasoning TEXT`, `ALTER TABLE messages ADD COLUMN tasks TEXT`],
  },
  // v12：刷题笔记（2026-09-13 契约 docs/QUIZ-NOTES-SPEC.md）——每道题一篇结构化笔记。
  // 提交答案即落草稿：question_data/quiz_title 为快照、不设外键，题库删除后笔记仍自洽可读
  //（与 evolution_event 冗余 term_text 同一手法的镜像决策）。心得 body 由用户补写，
  // 重复作答只刷新对错与作答快照，绝不覆盖已写的心得。
  {
    version: 12,
    statements: [
      `CREATE TABLE IF NOT EXISTS quiz_notes (
        id TEXT PRIMARY KEY,
        quiz_id TEXT NOT NULL,
        question_index INTEGER NOT NULL,
        quiz_title TEXT NOT NULL DEFAULT '',
        question_data TEXT NOT NULL,
        my_answer TEXT,
        correct INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(quiz_id, question_index)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_quiz_notes_updated ON quiz_notes(updated_at)`,
    ],
  },
  // v13：对话体验升级（2026-09-13）——providers.stream_mode 决定一轮回答的呈现形态：
  // 'stream' = 逐字流式（原生 AI，含思考链 / 任务 / 工具全过程）；'once' = 一次性回答
  //（池中 AI：等待期只有「思考中」UI，答案整块上屏）。
  // 存量回填按 type 定位：anthropic（原生协议）保持 'stream'，openai 兼容（中转池）落 'once'
  //——中转池大量按非流式聚合转发，逐字流式体验本就残缺，一次性回答是它们的真实形态。
  {
    version: 13,
    statements: [
      `ALTER TABLE providers ADD COLUMN stream_mode TEXT NOT NULL DEFAULT 'stream'`,
      `UPDATE providers SET stream_mode = 'once' WHERE type = 'openai'`,
    ],
  },
  // v14：方案选择框（2026-09-14 契约 docs/ASK-CHOICE-SPEC.md）——AI 主动提问、用户点选、同轮继续。
  // 独立建表、不塞 messages：选择题是**一轮内的从属交互**，不是消息流的一员（浮层形态，老板拍板）。
  // 落库的唯一理由是「挂起的卡能被重新捞回来」：等待态在后端是内存 Promise，若前端刷新就再也
  // 看不到卡，而工具还在等——体验会断裂成「以为空闲、实则挂起」。故请求与答复都必须持久化。
  // 重启清理见 chat/choice.ts 的 sweepStaleChoices（内存 Promise 随进程消失，库里 pending 必作废）。
  {
    version: 14,
    statements: [
      `CREATE TABLE IF NOT EXISTS ask_choices (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        allow_custom INTEGER NOT NULL DEFAULT 1,
        multi INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        reply_option_id TEXT,
        reply_custom TEXT,
        reply_ts INTEGER,
        cancel_reason TEXT,
        answered_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ask_choices_pending ON ask_choices(session_id, status)`,
    ],
  },
  // v15：对战历史（2026-09-14 契约 docs/PK-SPEC.md §12.2，P0-8）——**P0 里第一处让对局落库**。
  // 房间状态机仍是全内存（room.ts 口径不变）：房间是**过程**（进程内活着就够），
  // 历史是**结果**（重启后还得能查）。只有「已经结束的一局」被摘成行写进来。
  //
  // ★ 视角行（每人一行）而非「一局一行 + 两个玩家字段」：历史永远是「按人查」的
  //   （WHERE user_id=? ORDER BY ended_at DESC），视角行让这条查询直接走索引、前端也不必自己算
  //   「我是哪一侧」。代价是 PVP 一局两行、快照 JSON 各存一份（一局几 KB）——
  //   与 quiz_notes 冗余 quiz_title 同一取向：**快照冗余换查询简单**。
  // ★ UNIQUE(room_id, user_id)：落库幂等由库保证，不靠调用方记得只调一次。
  // ★ opponent_nickname 存快照不设外键：对手改名后历史仍显示当时对战的名字。
  {
    version: 15,
    statements: [
      `CREATE TABLE IF NOT EXISTS pk_matches (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        opponent_id TEXT NOT NULL,
        opponent_nickname TEXT NOT NULL,
        mode TEXT NOT NULL,
        my_score INTEGER NOT NULL,
        opp_score INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        quiz_count INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        ended_at INTEGER NOT NULL,
        UNIQUE(room_id, user_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pk_matches_user ON pk_matches(user_id, ended_at)`,
    ],
  },
  // v16：长期记忆（2026-09-15 契约 docs/MEMORY-SPEC.md §3.1——机制照搬 Pi 的 Compaction
  // + AGENTS.md，不引向量库/新依赖）。第一层：sessions 加四列、**不建表**——一个会话一份
  // 摘要、滚动覆盖，生命周期随会话（同 v6 的 doc 两列）。★ `summary_upto_rowid` 用 rowid
  // 而非 created_at：后者只到秒、同秒多条无法区分先后，而 rowid 单调且删除后不复用；
  // 它同时是**幂等锚**（只摘 rowid > 它的部分，重复触发不重摘）。第二层：user_memory 独立
  // 建表（跨会话存活），UNIQUE(kind, content) 供 upsert 幂等（同 term_library 手法）；
  // 不设外键——会话删除后画像仍自洽可读（同 v8/v12/v15，第四次复用）。理由详见 SPEC §3.1。
  {
    version: 16,
    statements: [
      `ALTER TABLE sessions ADD COLUMN summary TEXT`,
      `ALTER TABLE sessions ADD COLUMN summary_upto_rowid INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE sessions ADD COLUMN summary_tokens INTEGER`,
      `ALTER TABLE sessions ADD COLUMN summary_updated_at TEXT`,
      `CREATE TABLE IF NOT EXISTS user_memory (
        id                TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        content           TEXT NOT NULL,
        source_session_id TEXT,
        importance        REAL NOT NULL DEFAULT 0.5,
        usage_count       INTEGER NOT NULL DEFAULT 0,
        last_used_at      TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(kind, content)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_memory_kind ON user_memory(kind, importance DESC)`,
    ],
  },
  // v17：看图功能（2026-09-16）——messages 加 images 列存用户上传图片（base64 dataURL，JSON 数组），
  // 仅用于历史回显缩略图；主模型看到的是 chat/vision.ts 蒸馏后的文字描述（持久化在 content 里），
  // 二者分离：图不进主模型上下文、历史回放也不再二次调视觉模型。单列表、不加新表，生命周期随消息。
  {
    version: 17,
    statements: [`ALTER TABLE messages ADD COLUMN images TEXT`],
  },
];
