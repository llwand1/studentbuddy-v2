/**
 * storage/migrations-list-v43 — **v43 及之后**的迁移分片（2026-09-24，契约 `docs/PK-SPEC.md` §16）。
 *
 * **为什么又切一片（不是按规矩追加到 `-v41.ts` 尾部）**：`migrations-list-v41.ts` 此刻正被
 * 同仓另一个会话的施工占用（v42 `growth_action_day.source` 尚未提交）。追加进去等于踩进
 * 别人的工作面，且两批的提交顺序会变成隐式耦合。⇒ 照仓规**拆文件**，各自一片，
 * 聚合出口 `migrations-list.ts` 两行各挂各的。等 v41 片空下来再由后人并片（纯搬运、零行为改动）。
 *
 * ⚠️ **发版顺序拦路牌（本批最容易埋进生产的一条，必读）**：执行器 `migrations.ts` 的判据是
 *   `if (m.version <= current) continue`，而 `current = MAX(schema_version.version)`。
 *   ⇒ **若某库先应用了 v43、此后 v42 才进仓，那条 v42 会被永久静默跳过**（42 ≤ 43），
 *   表现为「他的列莫名缺失」且没有任何报错。本地共享库实测已跑到 42（2026-09-24 现查），
 *   风险只在**线上发版**：v43 所在批次**不得早于 v42 进 main** 就发版。
 *   本注释是唯一常驻的拦路牌——发版前照例逐条点名确认。
 *
 * ⚠️ 回放迁移链的测试必须把**建表与索引**一并 DROP（`CREATE TABLE IF NOT EXISTS` 幂等，
 *   但残留行会让「新建库该有几行」的断言假绿；加列型迁移更是每次都踩过 `duplicate column name`，
 *   见 `storage/migrations-v43.test.ts`）。
 */

/**
 * ── v43：AI 主动发起对战的邀请（契约 `docs/PK-SPEC.md` §16，2026-09-24 老板点单）──
 *
 * 背景：对战（PK）此前只有**人找局**一条路（大厅建房 / 输房号 / 邀请链接）。老板点单要反过来：
 * **AI 在讲完一段内容后主动邀请学习者来一局相关话题的对战**，他点「接受」或「拒绝」。
 *
 * ★ 为什么必须落库、不能像房间那样留在内存：这张卡要活过三件内存态挡不住的事——
 *   ① **刷新/重连**要把未答复的卡捞回来（`ask_choices` 的同一条先例：SSE 缓冲 60s 无订阅即回收，
 *      不查库就会「界面空闲、邀请石沉大海」）；
 *   ② **频率闸门**要数「同一会话近 5 分钟发过几张、同一人今天发过几张」，那是跨进程重启
 *      才成立的东西，进程内 Map 一重启就归零 ⇒ 刷成骚扰；
 *   ③ 「接受」的**双点裁决**（同一张卡两端各点一次，或用户连点两下）靠 `UPDATE ... WHERE
 *      status='pending'` 的 `changes` 判定，与 `choice.ts:markAnswered` 同一写法。
 *   房间本身**仍不落库**（§4 的划界不因本批改变：重启丢局仍是有意接受项）——本表只存邀请，
 *   `room_id` 只是指向一间内存房的引用，重启后它指不到东西，这是**已知代价**而非新 bug。
 *
 * ★ 为什么不复用 `ask_choices`（那是仓里现成的「AI 问、人答」表）：
 *   它没有承载结构化上下文的列——`topic`／`room_id` 都得有地方放，而 `grillPhase` 那次
 *   「刻意不落库、只活在内存与 SSE 里」的取舍（`chat/choice.ts` 的 `AskChoiceInput.grillPhase` 注释）
 *   说明往它身上加语义是有代价的。另起一张表还换来一件事：**邀请能被对战域自己查**
 *   （`pk/` 不 import `chat/`，跨域读别人的表是第二份事实源）。
 *
 * ★ `status` **不写 CHECK 约束**（沿用 v25 `coach_messages.kind` 的同一取向）：状态集还可能长
 *   （例如将来加「已过期未答复」），每加一值配一次迁移不值当；脏值由域层归一（`pk/invite.ts`）。
 * ★ `owner_id` 可空：与全站「无主＝本地单人形态」的既有语义一致（`ownerIdOf → null`）。
 *   ⚠️ 于是「每人每天 ≤ N 张」这条闸门**只在有主时数得准**；无主的本地形态由会话维度那条兜住
 *   （本地只有一名使用者，会话即人）。
 * ★ `topic` 存的是**已截断**的值（≤ shared `TOPIC_MAX`＝20 字）：截断必须发生在发邀请那一刻，
 *   留到点「接受」时才校验，报错就出现在用户已经做完决定的时候——那是最坏的时机（§16 风险条）。
 * ★ 时刻列只有 `created_at` 一个（UTC 文本 `datetime('now')`，与 `coach_messages` 同族——
 *   闸门查询直接用 `datetime('now','-5 minutes')` 比，无需换算）。**没有 `decided_at`**：
 *   目前没有任何读者（卡片只显示状态，闸门只数发出时间）。
 *   照仓规「不提前造用不到的东西」；将来要就加一条迁移。
 */
export const MIGRATIONS_V43: Array<{ version: number; statements: string[] }> = [
  {
    version: 43,
    statements: [
      `CREATE TABLE IF NOT EXISTS pk_invites (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        owner_id   TEXT,
        topic      TEXT NOT NULL,
        reason     TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'pending',
        room_id    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      // 会话维度两条读法共用：捞未答复的卡（`session_id` + `status` 残余过滤）、
      // 数「本会话近 N 分钟发过几张」（`session_id` + `created_at`）——`created_at` 放第二列
      // 让范围扫描顺着时间走，不把 status 塞进索引（那等于为一个残余条件多养一条路径）。
      `CREATE INDEX IF NOT EXISTS idx_pk_invites_session ON pk_invites(session_id, created_at)`,
      // 人维度：「同一人今天已发几张」——cloud 形态下每个真实学习者都在这条上被限流。
      `CREATE INDEX IF NOT EXISTS idx_pk_invites_owner ON pk_invites(owner_id, created_at)`,
    ],
  },
];
