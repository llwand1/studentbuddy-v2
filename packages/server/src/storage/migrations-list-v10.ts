/**
 * storage/migrations-list-v10 — 迁移清单数据 **v10 及之后**（PK 域 + 过程回放 + 刷题笔记 +
 * 对话呈现形态 + 方案选择框 + 对战历史 + 长期记忆 + 看图 + **学习流**）。
 *
 * 2026-09-16 二次拆分（同批：`-v1-9.ts`）。本文件是**追加新迁移的唯一落点**。
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
  // v18：学习流（2026-09-16 契约 docs/STUDY-FLOW-SPEC.md）——**七张表，分三层，全新建**。
  //
  // 背景与设计依据（三者独立取材、交叉印证，非自创）：
  //  · LangGraph.js（读 `libs/langgraph-core/src/graph/state.ts` 源码）：图是**构建时静态定义**——
  //    `addNode`/`addEdge` 必须在 `compile()` 前写完，编译后拓扑固定，只有节点内部能靠
  //    `Command({goto})` 动态决定下一步（**逻辑动态，结构静态**）。⇒ 故本域**不把用户编排的流
  //    当成图结构**，而是当成**数据**（下面 flow_step/flow_edge 两张表）由固定运行器解释执行。
  //  · n8n（`packages/workflow/src/interfaces.ts`）：`INode{ id, name, type, typeVersion, position,
  //    parameters }`——节点类型是**注册表里的键**（非自由文本），且**每个节点类型自带版本号**。
  //    ⇒ 故 flow_step 有 `kind`（注册表键）+ `type_version`，参数走 `params` JSON、由 kind 的声明校验；
  //    并采其 `position` 一并落库（画布坐标属于定义，不是纯前端状态）。
  //  · Dify（`web/types/workflow.ts`）：`FetchWorkflowDraftResponse.graph = { nodes, edges, viewport }`
  //    + `version`；**`WorkflowRunHistory` 把当次运行的 `graph` 整份存下来**；`NodeTracing` 逐节点落
  //    执行轨迹；`workflow_paused` + `paused_nodes` 表达暂停等人；`NodesDefaultConfigs {type,config}[]`
  //    即节点类型注册表的默认配置。⇒ 故 flow_run **带 def_snapshot（定义快照）**、flow_run_step
  //    即 NodeTracing 的对应物、status 含 'paused'。
  //
  // ★★ 两条不可省的架构约束（改码前必读）：
  //  1. **run 必须存定义快照**（`flow_run.def_snapshot`）。用户改了流定义后，**已经跑过的 run
  //     必须保留当时的定义**，否则历史回放会按新定义去解释旧轨迹，张冠李戴。这与
  //     `evolution_event.term_text` / `quiz_notes.quiz_title` / `pk_matches.snapshot_json`
  //     是同一手法（**第五次复用**）：**快照冗余换查询简单 + 抗源数据变更**。
  //  2. **知识图的边必须区分出处**（`knowledge_edge.origin`）。AI 抽取的边（'ai'）与用户手搭的
  //     边（'user'）**不能平等对待**——模型幻觉出的关系若与用户确认的关系混作一谈，用户就再也
  //     纠不回来。结构推导的边（'derived'）单列，因为它可被规则重算、可被批量撤销。
  //
  // ★ 节点表只存**引用 + 抗删快照**，不复制内容：`knowledge_node.ref_id` 指向 term_library.id /
  //   quiz_notes.id / messages.id，正文仍在原表。删了源行，图仍自洽可读（同 v8/v12/v15/v16 手法）。
  //
  // ★ 幂等一律交给库约束（不靠调用方记得只调一次）：`flow_run_step UNIQUE(run_id, seq)`、
  //   `knowledge_node UNIQUE(kind, ref_id)`、`knowledge_edge UNIQUE(from_node_id, to_node_id, kind)`
  //   ——后者让「同一条边重复抽取」直接走 `INSERT OR IGNORE`。
  //
  // ★⚠️ 本迁移**纯加法**（只 CREATE TABLE/INDEX，不动既有表）⇒ 回放迁移链的测试**无需 DROP 新列**，
  //   但 `storage/db.test.ts` 若断言了表清单/版本号，需同步补 18。
  //
  // ★ 本批自测勘误（**就地修正、未另起版本号**）：`flow_step` 的主键由 `id` 单列改为 `(def_id, id)` 复合，
  //   理由见该表上方注释（全局主键会让「克隆一条流」直接撞唯一约束，本批实测踩到）。
  //   **之所以可以就地改 v18**：学习流是本批首次发布，v18 尚未应用于任何真实库（真实库停在 v17）。
  //   ⚠️ **若已发布则绝不可如此**——那时必须新增 v19 迁移，因为已应用的版本不会重跑，
  //   改了只会让新库与老库结构分叉（这正是「已应用的版本号是历史锚点」那条规矩的由来）。
  {
    version: 18,
    statements: [
      // ── 第一层：控制流·定义（用户编排的模板，可保存、可固定化复用）──
      `CREATE TABLE IF NOT EXISTS flow_def (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        version     INTEGER NOT NULL DEFAULT 1,          -- 定义自身的版本（Dify version 同款）
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      // 节点 = 一种「学习交互体验」的实例化。kind 是步骤注册表（learning/flow-registry.ts）
      // 的键，不是自由文本——用户能自定义的是**类型 + 参数**，不是交互本身（SPEC §1.3 范围红线）。
      //
      // ★ 主键是 **(def_id, id) 复合**，不是 id 单列：步骤 id 只在**所属流内**唯一
      //   （n8n 的节点 name 同为「工作流内唯一」口径）。若做成全局主键，两条不同的流
      //   就不能各有一个叫 `s1` 的节点——画布按本地序号生成 id 时必然撞车，
      //   连「克隆一条流」都会因 id 复制而约束失败（本批自测实测踩到）。
      `CREATE TABLE IF NOT EXISTS flow_step (
        id           TEXT NOT NULL,
        def_id       TEXT NOT NULL,
        kind         TEXT NOT NULL,                      -- 注册表键：explain|quiz|grade|review|digest|summary
        type_version INTEGER NOT NULL DEFAULT 1,          -- 该步骤类型自己的版本（对齐 n8n typeVersion）
        label        TEXT NOT NULL DEFAULT '',            -- 画布上显示的名字（用户可改）
        params       TEXT NOT NULL DEFAULT '{}',          -- JSON，按 kind 声明校验
        position_x   REAL NOT NULL DEFAULT 0,             -- 画布坐标（属定义，非纯前端状态）
        position_y   REAL NOT NULL DEFAULT 0,
        order_index  INTEGER NOT NULL DEFAULT 0,          -- 线性顺序；无边时运行器的兜底推进依据
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (def_id, id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_flow_step_def ON flow_step(def_id, order_index)`,
      // 边 = 执行顺序。from_port 为条件分支预留（对齐 Dify edge 的 sourceHandle）：
      // 'next' 无条件顺序；'correct'/'wrong' 让「答对走下一题、答错走复盘」这种流成为可能。
      // ★ 外键用 **id 而非 name**（n8n 用 name 作连接键，代价是改名即断链，不学它）。
      `CREATE TABLE IF NOT EXISTS flow_edge (
        id           TEXT PRIMARY KEY,
        def_id       TEXT NOT NULL,
        from_step_id TEXT NOT NULL,
        to_step_id   TEXT NOT NULL,
        from_port    TEXT NOT NULL DEFAULT 'next',        -- next | correct | wrong
        label        TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(def_id, from_step_id, from_port, to_step_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_flow_edge_def ON flow_edge(def_id, from_step_id)`,
      // ── 第二层：控制流·运行（实例）──
      // ★ def_snapshot：当次运行用的完整定义快照（Dify WorkflowRunHistory.graph 同款）。
      // 没有它，用户改完定义后所有历史 run 的回放都会错乱。
      `CREATE TABLE IF NOT EXISTS flow_run (
        id              TEXT PRIMARY KEY,
        def_id          TEXT NOT NULL,
        def_snapshot    TEXT NOT NULL,                    -- 定义快照 JSON（不可省，见上方注释 1）
        def_version     INTEGER NOT NULL DEFAULT 1,
        session_id      TEXT,                             -- 绑定会话；可空（纯编排试跑不落对话）
        status          TEXT NOT NULL DEFAULT 'running',  -- running|paused|done|failed|cancelled
        current_step_id TEXT,                             -- 暂停/中断时停在哪一步（恢复锚点）
        cursor          TEXT,                             -- 恢复时从哪个出口走（对齐 from_port）
        step_count      INTEGER NOT NULL DEFAULT 0,        -- 已执行步数（防死循环，对齐 recursionLimit）
        pause_reason    TEXT,                             -- 停等用户时给前端的说明（ADR-5 不静默）
        error           TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at     TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_flow_run_status ON flow_run(status, updated_at)`,
      `CREATE INDEX IF NOT EXISTS idx_flow_run_session ON flow_run(session_id, created_at)`,
      // 逐步骤执行轨迹（= Dify NodeTracing 的对应物）。seq 是 1 基步序号，
      // UNIQUE(run_id, seq) 让「同一步重复落库」被库挡住（幂等不靠调用方自觉）。
      `CREATE TABLE IF NOT EXISTS flow_run_step (
        id          TEXT PRIMARY KEY,
        run_id      TEXT NOT NULL,
        step_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        seq         INTEGER NOT NULL,                      -- 1 基
        status      TEXT NOT NULL DEFAULT 'running',        -- running|done|failed|skipped
        input       TEXT,                                  -- 该步实际入参（JSON）
        output      TEXT,                                  -- 该步产出摘要（JSON）
        error       TEXT,
        started_at  TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        UNIQUE(run_id, seq)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_flow_run_step_run ON flow_run_step(run_id, seq)`,
      // ── 第三层：知识数据图（学习产物）──
      // 只存引用 + 抗删快照，正文仍在 source 表（term_library / quiz_notes / messages）。
      // UNIQUE(kind, ref_id) 供 INSERT OR IGNORE 幂等；concept 类节点 ref_id 为 NULL
      // （SQLite 的 UNIQUE 允许多个 NULL，故此类节点可重复登记）。
      `CREATE TABLE IF NOT EXISTS knowledge_node (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,                     -- term | note | turn | concept
        ref_id         TEXT,                              -- 指向源表主键；concept 为 NULL
        ref_text       TEXT NOT NULL DEFAULT '',          -- 抗删快照（源行删除后图仍可读）
        source_run_id  TEXT,
        source_step_id TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(kind, ref_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_knowledge_node_kind ON knowledge_node(kind, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_knowledge_node_source ON knowledge_node(source_run_id)`,
      // 语义边。★ origin 三值刻意不平权：'user'（用户确认，最高可信）/ 'ai'（模型抽取，可幻觉）
      // / 'derived'（结构推导，可被规则重算与批量撤销）。weight 供邻域排序，不参与业务判定。
      `CREATE TABLE IF NOT EXISTS knowledge_edge (
        id           TEXT PRIMARY KEY,
        from_node_id TEXT NOT NULL,
        to_node_id   TEXT NOT NULL,
        kind         TEXT NOT NULL,                       -- prereq|relates|derived_from|contains
        origin       TEXT NOT NULL DEFAULT 'derived',     -- ai | user | derived
        weight       REAL NOT NULL DEFAULT 0.5,
        evidence     TEXT,                                -- 立这条边的依据（原话摘录 / 推导规则名）
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(from_node_id, to_node_id, kind)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_knowledge_edge_from ON knowledge_edge(from_node_id, kind)`,
      `CREATE INDEX IF NOT EXISTS idx_knowledge_edge_to ON knowledge_edge(to_node_id, kind)`,
    ],
  },
  // v19：领域升为一等实体（2026-09-17）——**建 term_domain 登记表 + 从既有词条回填**。
  //
  // 背景：领域此前**零存储**，只是 `term_library.domain` 这列的去重值（`domainStats` 靠
  // `GROUP BY domain` 现算）。后果是它做不了词条做得到的三件事，且都是结构性的：
  //  · **建不了空领域**——没有词条就不存在领域，「先把领域建好再往里放词」这个动作没有落点；
  //  · **改不了名**——`tidy.renameDomain` 明确要求旧领域下至少有一条词条（它拿词条行当存在性凭证）；
  //  · **删不掉**——连「这个领域存在过」都没记录，无从删起。
  //
  // 设计：**登记册 + 引用**两分。`term_library.domain` 仍是词条归属的事实（不动、不加外键），
  // `term_domain` 只登记「有哪些领域」及其元信息。改名的权威语义仍是**批量改写词条的 domain 值**
  // （幂等、可重跑），登记册随后同步——**词条侧是事实、登记册是索引**，这个方向不能反。
  //
  // ★ 不变式：`term_library.domain ⊆ term_domain.name`（词条引用的领域必须已登记）。
  //   靠**写入侧登记**维持：`saveTerms` / `saveOneTerm` 落新 domain 时同步 `INSERT OR IGNORE`
  //   进本表（同 v10 的 `UNIQUE(kind, content)` 手法：幂等交给库约束，不靠调用方记得）。
  //   为什么必须维持它：AI 抽取随时会吐出全新领域名（`extractTerms` 提示词只做「优先复用」的
  //   软引导，不做白名单硬拦——硬拦会把尚未归类的词条憋回去），登记册若靠人工同步就必然滞后
  //   ⇒ 领域 Tab 漏项（本表存在的意义就是让 Tab 与库一致）。
  //
  // ★ 本迁移**纯加法**（建表 + INSERT OR IGNORE 回填，两者皆幂等）⇒ 回放迁移链的测试无需 DROP；
  //   老库的既有 domain 值靠回填补齐，不会出现「老库有词条但登记册为空」的分叉。
  //
  // ⚠️ `note` 是**领域的说明**，与词条的 `definition` 对位（领域既然是「一种词条」，也该有它的释义）；
  //   留空合法——用户建领域只为分组时不必写说明（不强加必填，同 ADR-2 最小必要）。
  {
    version: 19,
    statements: [
      `CREATE TABLE IF NOT EXISTS term_domain (
        name       TEXT PRIMARY KEY,                      -- 领域名（小写、≤30 字符，与 term_library.domain 同口径）
        note       TEXT NOT NULL DEFAULT '',              -- 领域说明（对位词条的 definition；可空）
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      // 预置默认领域：它是词条未归类时的落点，也是删域时的迁移终点（`removeDomain` 拒绝删它）。
      // 不预置的话，删掉某个领域会把词条迁进一个**从未登记过**的 general ⇒ 变成孤儿域，
      // 直接破坏上面的不变式。note 留空——这是系统域，不替用户预设说明文字。
      `INSERT OR IGNORE INTO term_domain (name) VALUES ('general')`,
      // 回填：既有词条用过的领域全部登记（DISTINCT 去重；空库无行插入，安全）
      `INSERT OR IGNORE INTO term_domain (name) SELECT DISTINCT domain FROM term_library`,
    ],
  },
  // ── v20（2026-09-17，情景题，契约 docs/SCENARIO-SPEC.md）──
  //
  // scenario_demo：情景题的 demo HTML 持久存储。为什么必须新表而不能复用 routes/preview.ts 的
  // 内存暂存：预览是「可派生数据」（20 条、重启即丢），demo 是**题目本身**——丢了这道情景题
  // 就只剩评分点清单、再也玩不了，两者生命周期完全不同。
  //
  // ★ demo 与套题 1:1：quiz_bank 存 ScenarioPayload（评分点 + criteria），本表存 html，
  //   由 quiz_id 反查——题库 JSON 里**不存 demoId**，删 demo 行不破坏题库数据自洽。
  // ★ quiz_id 不设外键（题库删除时由域层连带清理，见 deleteQuiz 的 scenario 分支），
  //   与 quiz_notes 的「快照冗余、不设外键」同一手法。
  // ★ 本迁移纯加法（CREATE TABLE/INDEX 皆幂等）⇒ 回放迁移链的测试无需 DROP。
  {
    version: 20,
    statements: [
      `CREATE TABLE IF NOT EXISTS scenario_demo (
        id         TEXT PRIMARY KEY,                     -- demoId（出页 URL 与回传消息用的就是它）
        quiz_id    TEXT NOT NULL,                        -- 所属套题（quiz_bank.id）
        html       TEXT NOT NULL,                        -- demo 源码（出页时注入桥接脚本）
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_scenario_demo_quiz ON scenario_demo(quiz_id)`,
    ],
  },
];
