# MEMORY-TREND-SPEC — 记忆联动：提及流水 · 领域提及数 · 督促趋势

> 版本 **v1.0** | 2026-09-18 | 状态：[进行中]
> 上游契约：`MEMORY-SPEC.md`（长期记忆）、`EBBINGHAUS-SPEC.md`（复习）、`COACH-SPEC.md`（督促）、`TENANCY-SPEC.md`（归属）

## §0 这份契约解决什么

老板点单原话（2026-09-18）：

> 「长期记忆要围绕词条库，长期记忆要根据词条库各词条的使用次数来改变，还要给领域加一个『该领域内词条总提及数』，
> 然后总提及数多的当然就是用户的偏好领域，然后还要加一个『趋势』的功能，这个『趋势』的功能就放进督促里，
> 然后他的效果就是记录用户近期的学习趋势，这个学习趋势也就是涉及到词条库里的词条的近期提及次数，
> 还要近期领域提及次数，然后这些被记录之后，督促功能本身就会自动调用模型，去生成一个 svg 近期学习趋势图，
> 然后汇报给用户……总的需求就是让 studentbuddyv2 的各种功能都具有联动性」

拆成四件事，**它们共用同一个数据源**（提及流水）：

| # | 能力 | 依赖 | 改造前现状（已读码取证） |
|---|------|------|--------------------------|
| ① | 提及流水 | — | **不存在**：只有 `usage_count` 累加值（`learning/terms.ts:376`） |
| ② | 领域总提及数 + 偏好领域 | ① | `domainStats()` 只给**词条数**（`learning/domains.ts:195`） |
| ③ | 长期记忆按提及次数加权 | ① | `user_memory` **只由压缩写入**，与词条库零数据往来（`chat/memory.ts:8`） |
| ④ | 督促趋势图 + 胶囊气泡 | ①②③ | 无该卡片形态；`pushNudge` 只落库**不发 SSE**（`learning/coach.ts:176`） |

**"联动性"的落点就是这张流水表**：一次提及同时喂给领域统计、长期记忆、督促趋势三处，
而不是三个功能各算各的（那是三份口径，迟早漂）。

---

## §1 提及流水（迁移 v26）

### §1.1 为什么必须新建一张表

`countUsage()` 现在只做一件事：把命中的词条 `usage_count + 1`。

**累加值能回答「一共提了多少次」，回答不了「什么时候提的」**。而上面四件事里有三件是**时间维度**的
（近期趋势、趋势图、按窗口统计）。没有逐次记录，这三件在当前数据模型下**算不出来**——
不是"实现难"，是**数据不存在**。故本表是整条链的地基，必须先落。

### §1.2 表结构

```sql
CREATE TABLE IF NOT EXISTS term_mention_log (
  id            TEXT PRIMARY KEY,
  term_id       TEXT NOT NULL,
  domain        TEXT NOT NULL,
  owner_id      TEXT,
  mentioned_at  TEXT NOT NULL DEFAULT (datetime('now')),
  mentioned_day TEXT NOT NULL DEFAULT (date('now'))
);
CREATE INDEX IF NOT EXISTS idx_term_mention_term   ON term_mention_log(term_id);
CREATE INDEX IF NOT EXISTS idx_term_mention_day    ON term_mention_log(mentioned_day);
CREATE INDEX IF NOT EXISTS idx_term_mention_lookup ON term_mention_log(owner_id, domain, mentioned_day);
```

### §1.3 三条刻意设计（每条都有具体要挡住的那个错）

**(a) `domain` 存**快照**，不是外键。**

词条可以被改领域、也可以被删除（`removeTerm`）。若流水只存 `term_id` 再 `JOIN term_library` 取领域，
那么三个月前属于「算法」的词条今天被挪到「计算机网络」之后，**历史趋势会整体漂移**
——同一张图昨天看是"算法涨了"、今天看变成"网络涨了"，而用户什么都没做。
**流水是历史事实，事实必须当场冻结**（同 `evolution_event` 的冗余快照手法）。

**(b) `owner_id` 可空、且**不设** `DEFAULT ''`。**

沿用 v25 `coach_messages` 的口径：`null` ＝ 未登录的单人本地模式（`ownerFilter(null)` 不过滤）。
★ 与 v24 `user_memory` 的 `''` **刻意相反**——那里用 `''` 是被 `ON CONFLICT` 的冲突目标必须匹配
唯一索引**列**这一点强制的；这里没有唯一键，就该让 `null` 保持"无主"语义，不要把两者混成一个值。

**(c) `mentioned_day` 冗余落库。**

与 v23 `term_review_log.reviewed_day` 同手法。与"派生值一律现算"（v23 拒绝落 `next_review_at`）**不矛盾**：
那条针对的是**业务口径会变**的派生值（间隔序列一改就得洗全表）；日历日是**稳定口径**，
且按天聚合是最高频查询——`date(mentioned_at)` 这种函数表达式走不了索引。
★ `mentioned_day` 由应用层用 `localDayKey(now)` 填（与 `computeReviewState` **同日历口径**），
**不靠 `date('now')`**——那是 UTC 日，在 +8 区晚上会错一天（本仓已在日期段批吃过一次）。

### §1.4 写入点：与计数**同一事务**

```ts
countUsage(replyText: string, ownerId?: string | null): number
```

在既有事务里，`UPDATE usage_count` 的同时 `INSERT` 一行流水。
**必须同事务**：否则会出现「计数加了、流水没落」的分叉，而这两处的差值此后再也无法对齐。

★ `ownerId` **可选、默认 null**（同 `MEMORY-SPEC` 与 `TENANCY-SPEC §7` 的纪律）：
不逼既有 3 个调用点改签名，且"漏传"的后果是**退回本地模式**（与现状一致），不是串台。

### §1.5 边界（诚实记账，必须写进 CHANGELOG 与 test-plan §6）

**流水只记录建表之后发生的提及。** 历史 `usage_count` 无法回溯成流水——那时没有任何时间信息，
按当前时间批量补一批行就是**造假数据**，会让趋势图显示一批用户根本没发生过的"提及"。

因此两个口径**永久并存、不可互相校验**：

| 口径 | 数据源 | 覆盖范围 |
|------|--------|----------|
| 总提及数（`mentionCount`） | `term_library.usage_count` 聚合 | **含全部历史** |
| 近期提及次数（趋势） | `term_mention_log` 流水 | **只有建表之后** |

⇒ UI 上趋势图标题必须写明窗口（「近 7 天」），不能写成"总趋势"。

---

## §2 领域总提及数与偏好领域

### §2.1 口径

- **`mentionCount`（该领域内词条总提及数）** ＝ 该领域下所有词条 `usage_count` 之和（含全部历史）。
- **`recentMentions`（近 N 天提及数）** ＝ 流水按 `domain` + 窗口聚合。
- **`preferredDomains`** ＝ 按 `mentionCount` 降序；同数按词条数降序；再同按领域名升序（**全序，保证稳定**）。

### §2.2 为什么不复用既有的 `count`

`domainStats().domains[].count` 是**词条数**（这个领域里有几个词），`mentionCount` 是**提及数**（提过几次）。
**两者都必要且不等价**：一个领域可以堆了 50 个词条却一次没被提及（说明它与用户真实关注无关），
也可以只有 3 个词条但反复提及（说明它就是当前的主战场）。
把它们合成一个字段会让「领域栏」彻底失去区分度——而"识别偏好领域"正是加这一列的**全部理由**。

### §2.3 排序的边界

`preferredDomains` **不设最小阈值**（不写"提及 ≥3 才算偏好"）：阈值是拍脑袋的数，
且会让小样本用户永远看到空列表。改为**如实返回全序**，由调用方（督促/画像）自己截取 top N，
并在文案里带上计数（「计算机网络（42 次）」）——**让用户看见依据，而不是看见一个结论**。

### §2.4 P2 落地形状（v0.2.51）

`GET /api/terms/domains`（`routes/terms.ts` 直通 `learning/domains.ts#domainStats`）响应扩为：

```
{ total, today,
  domains:   [{ domain, count, note, mentionCount }],   // mentionCount 新增
  preferred: [{ domain, mentionCount }] }               // 新增（已排全序、只含 >0）
```

**三个界面落点**（都只是「显示 + 跳转」，不引入任何新的写入口）：

| 落点 | 显示什么 | 为什么放这儿 |
|------|----------|--------------|
| 领域 Tab 的 `title` | `N 个词条 · 共提及 M 次` | Tab 是**筛选器**，塞两个无标签数字会变成读不懂的 `math 12·87`；悬停给全文 |
| 「管理领域」行的只读字段 | `N 词条 · 提及 M 次` | 这里才是**带标签的字段区**，数字有地方解释自己 |
| 词条库页「偏好领域」chip 行 | `领域名 + 提及数`（top 4，可点） | 结论必须能**一步跳到证据**（点一下即筛到该领域）；只展示不可点就退化成装饰 |

★ **口径单一实现**：`mentionCount` 只有 `learning/mention.ts#domainMentionTotals()` 一份 SQL。
`domains.ts` **刻意不自己写** `SUM(usage_count)`——两处一旦各写一遍，将来加归属过滤时必漏一边，
而「同一个数有两个出处」正是本仓反复付过学费的那类静默 bug。

---

## §3 长期记忆与词条库联动

### §3.1 现状与缺口

`chat/memory.ts:8` 的文件头写得很明确：「本层**只由压缩过程写入**」。
压缩是"聊完一轮顺手沉淀"的信号点，它沉淀的是**对话里说过的话**；
而**"用户真正反复在学的领域"这个事实，词条库比对话更权威**——它是被提及次数统计出来的行为证据，
不是模型从对话里总结出来的自我陈述。

两者互补、**并存不替代**：压缩路径照旧（画像的 `profile`/`goal` 仍来自对话），
新增一条**词条库驱动**的路径写 `preference`。

### §3.2 做法

新增 `chat/memory-digest.ts`（词条库 → 画像）：

- **输入**：`preferredDomains`（§2.1）+ 高频词条 top N。
- **输出**：`MemoryDraft[]`，`kind = 'preference'`，内容形如 `常学领域：计算机网络` /
  `高频术语：二分查找`。
  ⚠️ **不要把次数写进 content**——它与「唯一键含 content」直接冲突，理由与替代方案见 **§3.4**。
- **写入**：复用既有 `upsertMemoryItems`（幂等：同 `kind` + 同 `content` 只刷 `importance`/`updated_at`）。
- **`importance` 由提及数归一映射**（`mentionsToImportance`：单调·有界·饱和于 1），而不是恒定 0.5
  ——这正是老板说的"长期记忆要根据词条库各词条的使用次数来改变"的**可执行含义**。
  映射的具体取值与三条不变式见 **§3.4**。
- **触发时机**：挂在压缩之后（同一 fire-and-forget 链，不新增调度器），
  且**幂等**——重复触发只是刷新 `updated_at`，不会堆垃圾画像。

### §3.3 注入侧

`buildMemoryBlock()`（`memory.ts:153`）已按 `MEMORY_KINDS` 声明序分组输出。
新的 `preference` 条目**自动进入既有分组**，**不改注入结构**——这是刻意的：
画像注入是"恒注入不检索"，加字段不加机制，避免在 prompt 组装层再开一条分支。

★ 但要**硬限条数**：偏好领域最多写 top 3，否则每次压缩都往里塞，会挤掉对话沉淀出来的画像
（`MEMORY_MAX_ITEMS` 是**每人一份**的硬上限，塞满就把真正重要的挤出去了）。

### §3.4 P3 落地形状（v0.2.52）

新增 `server/src/chat/memory-digest.ts`，**两层分开**（规则可单测、IO 只管取数与落库）：

| 层 | 函数 | 职责 |
|----|------|------|
| 纯函数 | `buildPreferenceDrafts(input)` | 榜单 → `MemoryDraft[]`：领域与词条**各**取 top 3，按提及数降序（**内部自排序**，不信任调用方） |
| IO | `refreshTermDigest(ownerId?)` | 读库（`domainStats().preferred` + `topMentionedTerms()`）→ 建草稿 → 幂等入库 → 淘汰 |

**`importance` 映射**（`shared/src/memory.ts` 的 `mentionsToImportance`）：
`count ≤ 0 → 0`（**0 表示「不构成偏好」，调用方应丢弃该条**）；
否则 `0.5 + 0.5 × min(1, count / 30)`，保留 3 位小数。

三条不变式（**由 shared 层断言钉住**，改数前先读）：

1. **单调**——提及越多分越高；
2. **有界且饱和于 1**（30 次满分）——不饱和的话，重度用户的单条偏好会把整张画像的
   `importance` 尺度拉爆，结果不是「学霸的偏好更重要」，而是**所有人的其他画像都被压成噪声**；
3. **下限 ≥ 注入门槛**（`MEMORY_DIGEST_MIN_IMPORTANCE ≥ MEMORY_MIN_IMPORTANCE`）——
   低于门槛就**白写**：不注入、还占 `MEMORY_MAX_ITEMS` 的名额。

★★ **最关键的一条设计：`content` 里不许出现次数。**

`user_memory` 的唯一键是 `(user_id, kind, content)`，冲突时**只刷** `importance` 与 `updated_at`。
若把次数写进 content（`常学「数学」（累计提及 42 次）`），**次数每变一次就新增一行**，
而旧行**再也无法被更新、也永远不会消失** ⇒ 注入段里会同时出现「累计提及 3 次」与
「累计提及 42 次」两条**互相打脸**的记录。故拆成两件事：

- **身份**（学的是谁）→ `content`，**必须稳定**，如 `常学领域：math` / `高频术语：二分查找`；
- **强度**（学得多频）→ `importance`，次数本就该去那儿。

代价是记忆页看不到那个数字——但**领域栏已经显示了**（`GET /api/terms/domains` 的
`mentionCount`），两边都不缺它。真要把它搬进画像页，正确做法是给 `user_memory` 加一列指标
（属独立批次），**不是**把它塞进 `content`。

**`countUsage` 之外的两个上游**（都在 `learning/mention.ts`，与 §2 的**总**口径同源）：

- `topMentionedTerms(limit)` —— `usage_count DESC, term ASC`（**全序**；不做全序的话
  `LIMIT` 在并列处取谁不确定，偏好画像会变成**随机内容**），且 `WHERE usage_count > 0`；
- `domainStats().preferred` —— **刻意复用**而不在 digest 里重排：排序规则（提及数 → 词条数 → 名）
  只允许有一份实现。

**触发点**：`compact.ts` 压缩成功后（同一 fire-and-forget 链），失败**吞掉但记账**
（`event_log` 的 `digestError`）——它跑在链路尾部、而压缩此刻**已经成功了**，
让一个附加动作把整轮压缩标成失败，账就再也对不上（ADR-4/ADR-5）。
`digestAdded` **单独入账**、不并进 `memoryAdded`：两个来源的诊断含义完全不同。

---

## §4 督促趋势功能

### §4.1 卡片形态（`shared/coach.ts` 新增第 5 种 kind）

```ts
| {
    id: string;
    kind: 'trend';
    at: string;
    /** 窗口天数（UI 标题必须显示，见 §1.5） */
    windowDays: number;
    /** 横轴：本地日历日 MM-DD */
    labels: string[];
    /** 每天的总提及次数（与 labels 等长） */
    values: number[];
    topDomains: Array<{ domain: string; count: number }>;
    topTerms: Array<{ term: string; count: number }>;
    /** 一句话摘要 */
    summary: string;
    /** 摘要来源：ai＝模型写的；fallback＝确定性回退（§4.3） */
    summarySource: 'ai' | 'fallback';
  }
```

★ **为什么把结构化数据落库、而不是落一段 SVG 字符串**（老板拍板"模型出数据、代码出图"）：
一段 SVG 是**不可校验、不可复用、不可重绘**的像素级产物——
窗口改成 30 天、主题换成浅色、要导出数据表，任何一件事都得让模型重画一遍。
落结构化数据则三件事都免费，且**卡片能被单测**（web 侧 `.tsx` 无 jsdom，纯数据才上得了仪器）。

### §4.2 生成时机：服务端定时后台（老板拍板）

新增 `learning/trend.ts` + `index.ts` 里的调度（`setInterval`，**不引调度库**）：

- **窗口**：近 7 天（`TREND_WINDOW_DAYS`）。
- **频率**：每 6 小时检查一次（`TREND_TICK_MS`），但**每天最多生成一张**
  （按 `coach_messages` 里当日是否已有 `trend` 卡去重）——幂等，重启不重复。
- **不打扰**：生成**只落卡 + 推一条气泡**，不更新胶囊红点（胶囊红点的语义是"有欠账"，不是"有新图"）。
- **数据不足不生成**：窗口内总提及数 < `TREND_MIN_MENTIONS`（默认 3）则跳过——
  给一个全是 0 的图是**负价值**（用户会以为功能坏了）。

### §4.3 模型怎么参与，以及**失败必须能回退**

调用既有 `resolveCoachTarget()`（`coach` 角色，未绑定回退 `explain`），**只让它做两件事**：

1. 给这张图写一句摘要；
2. 从给定数据里**挑出它认为最值得说的 1~2 个信号**（可选）。

★ **图表的坐标轴、数值、标签一律不由模型产出**——数值来自 SQL。
模型一旦拿到"生成数字"的权力，就会写出好看但与事实不符的曲线，
而**趋势图的全部价值就在数字是真的**。

★ **回退是硬要求**：模型超时/未绑定/返回不可解析时，用确定性模板摘要
（`近期共提及 N 次，最活跃的是「X」（M 次）`），`summarySource = 'fallback'`，
卡片**照常生成**。理由：趋势图的**主产物是图，不是那句摘要**；
因为模型不可用就让整个功能消失，是"把功能绑死在可选依赖上"。

### §4.4 汇报路径：胶囊旁的气泡

链路（**复用既有 SSE 通道，不新造**）：

```
定时任务 → 算窗口 → 调模型(可失败) → appendCard(owner,'trend',…) → publish(coach:<owner>, {type:'coach-card', card})
```

- **SSE 事件**：`sse-events.ts` 新增 `coach-card`（按仓规"先登记再实现"，
  并同步 `docs/SSE-CONTRACT.md`）。频道键仍是 `coach:<owner>`，与会话 id、`pk:` 三向隔离。
- **前端**：`CoachDock` 收到该事件 → 若抽屉未开，在胶囊旁弹一个小气泡
  「你的近期学习趋势生成了！」→ 点击 → 打开抽屉并滚到该卡。
- ★ **气泡不是模态、不自动展开抽屉**：老板要的是"冒出来一个小的对话框"，
  自动弹开等于抢屏幕。与 `NUDGE` 的克制同一条纪律。
- ★ **气泡只对 `trend` 卡弹**：`nudge` 卡的红点语义已在胶囊上（§4.2），
  两者叠加会让胶囊同时"报数 + 报消息"，用户分不清哪个更急。
- ★ 落地形状见 **§4.6**（v0.2.55）：气泡与胶囊同舱（`.coach-dock-rail`）、"滚到那张卡"经
  `[data-card-id]` 锚点落到具体节点。

### §4.5 P4 落地形状（v0.2.54）

新增 `server/src/learning/trend.ts`，**纯函数与 IO 分层**（同 `memory-digest.ts` 的取舍）：

| 层 | 函数 | 职责 |
|----|------|------|
| 纯函数 | `toTrendData` | 窗口数据 → 卡片数据：横轴 `YYYY-MM-DD` → `MM-DD`（年份已由窗口表达，横轴塞不下年份），`values` 与 `labels` **严格等长** |
| 纯函数 | `trendFallbackSummary` | 模型不可用时的确定性模板，点名**真实数据的头名**并带次数 |
| IO | `generateTrendCard` | 三道闸门（今日已有 → 窗口不足 → 出卡）＋ 落卡 ＋ 广播；`now`/`summarize`/`broadcast` 可注入 |
| IO | `summarizeTrend` | 模型**只写一句话**（`streamMode:'once'`、`purpose:'background'`）；`resolveCoachTarget()` **也在 try 内** ⇒ 配置坏掉也不抛 |
| 调度 | `startTrendScheduler` | `setInterval`（**不引调度库**）；`intervalMs` 可注入 ⇒「定时器可注入」这条交付判据由签名本身保证 |

**落法**：摘要进 `content`（它是这张卡"说给用户的那句话"，与 AI 卡/提醒卡的 `text` 同语义——
将来要检索、要列流水都读得到），图表数据进 `meta`（只给前端渲染的机器字段，不重复存一份）。
读回时由 `learning/coach.ts#toCard` **唯一解释**：坏 meta 退空图但**绝不连正文一起吞**（同 review 卡的处理）。

**三个刻意的行为**（每条都挡住一个具体的错）：

1. **起服先跑一次**（不等一个完整 tick）：否则首张图要等 6 小时才可能出现，
   而"我刚聊了几轮、重启一下就该看到趋势"才是人的预期；
2. **一个 tick 做两件事**：刷**词条库驱动的偏好画像**（P3 挂在压缩之后，而轻度用户可能很久都不触发
   一次压缩 ⇒ 画像长期不刷新，`docs/dev/test-plan.md` §6 已挂此账）＋ 出当日趋势卡。两者都幂等；
3. **`null`（本地单人模式）那一份只在"库里没有任何具名归属"时才出**：`mentionTrend(days, null)` 的语义是
   **不过滤 = 全体聚合**（本地单人模式的既有口径，见 P1 的 §1.4），一旦已经有了登录用户再为 `null` 出卡，
   就是把这**所有人**的提及算成"这个匿名访客的趋势"。本地单人部署里两者等价（库里只有 `null` 行），
   故这条短路不损失任何真实场景，只挡住多租户下的错误聚合。

### §4.6 P5 落地形状（v0.2.55）

前端两半：**图**（`chart-utils` 出 SVG）与**气泡**（胶囊旁的一颗），`CoachDock` 只做接线。

| 层 | 位置 | 职责 |
|----|------|------|
| 纯函数 | `web/src/lib/chart-utils.ts#renderTrendSvg` | 卡片数据 → 紧凑折线 SVG（**320×112**，与 ```chart 的 680 宽**刻意不共用**——套过来只能等比压扁到字看不清） |
| 纯函数 | `web/src/features/coach/coach-cards.ts#trendBubble` | 气泡准入：**是趋势卡 且 抽屉关着** → `{cardId, text}`，否则 `null` |
| 接线 | `CoachDock.tsx` | 收 `coach-card` 事件 → **先并进流水、再决定冒不冒泡**；点气泡 → 开抽屉 + 滚到那张卡 |
| 接线 | `CoachFeed.tsx` | `focusCardId` → 在流区里找 `[data-card-id]` 并 `scrollIntoView`，滚完回调清位 |
| 结构 | `coach.css` 的 `.coach-dock-rail` | 胶囊与气泡**同舱**（flex 列），气泡天然排在胶囊正上方 |

**三个刻意的行为**（每条都挡住一个具体的错）：

1. **气泡与胶囊同舱**，而不是各自 `position: fixed` 各算 `bottom`。各算的话那个偏移量必须等于
   胶囊高度（由字号/内边距/文案换行共同决定），胶囊文案一长气泡就压上去了；交给 flex 列 + `gap`
   之后，重叠在**结构上**不可能发生。★ 舱体本身 `pointer-events: none`、只有两个控件可点
   （它是右下角一块空区域，不该吃点击）；**这一条有真命中测试盯着**——`el.click()` 是程序化调用、
   绕过命中测试，程序化点法永远发现不了"看得见点不着"。
2. **先并进流水，再判定气泡**：抽屉开着时不冒泡（§4.4），但**那张卡仍必须立刻上屏**；
   顺序反过来写，抽屉开着时这张卡会"丢一件"。
3. **`renderTrendSvg` 空数据返回 `''`**：坏 `meta` 被 `toCard` 退成空数组 ⇒ 图整块不渲染，
   而**摘要照常显示**——这是 §4.5「坏 meta 退空图但绝不吞正文」的前端一侧。图与榜都是
   **同一次取数的两个视图**，不另算一套口径。

★ **`summarySource` 只进 `title` 提示、不上卡面**：`fallback` 是"模型本次没参与"的**诊断**信息，
摊在卡面上会让用户以为图有问题——而图才是真的那一半。气泡同理：**与 `summarySource` 无关**，
模型不可用时卡片照常生成，气泡宣告的是"图出来了"，不是"模型说话了"；按摘要来源决定弹不弹，
等于把功能重新绑死在可选依赖上。

---

## §5 分期（每期独立可回滚，按依赖序）

| 期 | 内容 | 交付判据 | 状态 |
|----|------|----------|------|
| **P1** | §1 流水表 + 双写 + 窗口查询 | 迁移 v26 回放绿；提及一次即多一行流水；窗口查询有单测 | **已交付**（v0.2.49，`mention.test.ts` 13 例） |
| **P2** | §2 领域总提及数 + 偏好领域 | `GET /api/terms/domains` 带 `mentionCount`；领域栏显示 | **已交付**（v0.2.51，`domains.test.ts` 18→23 例；领域栏显示 + 偏好领域 chip） |
| **P3** | §3 长期记忆联动 | 提及后画像出现 `preference`；重复触发不堆行 | **已交付**（v0.2.52，`memory-digest.test.ts` 13 例 + shared 8 例 + mention 4 例） |
| **P4** | §4 趋势卡后端（定时 + 模型 + SSE） | 定时器可注入；模型失败仍出卡（`fallback`） | **已交付**（v0.2.54，`learning/trend.test.ts` 19 例；§4.5 记落地形状） |
| **P5** | §4.4 前端图 + 气泡 | `chart-utils` 出 SVG；气泡只在 `trend` 且抽屉关着时出现 | **已交付**（v0.2.55，`chart-utils` 9→16 例 + `coach-cards` 16→20 例；§4.6 记落地形状；新增真机探针 `tools/probes/coach-trend-cdp.mjs` **33 条**） |

★ 每期都要：代码 + 测试 + 文档登记**同批提交**（AGENTS.md「工程红线」）。

## §6 已知边界（本版未做，如实登记）

1. **历史提及不可回溯**（§1.5）——趋势图上线首日只有当天数据，会显示"数据不足"。
2. **流水只增不删**：本版不做归档/清理策略。词条被删除后其流水**保留**（历史事实），
   故按 `term_id` 关联时需容忍"流水里有、词条表里没有"的行。
3. **趋势的"趋势"只看总量**：本版不做同比/环比、不做按领域的多序列叠加图（单序列 + top 榜）。
4. **定时器是进程内的**：多实例部署会各跑一份（本仓是本地单实例应用，现状可接受；
   将来多实例需换成"抢占式落卡"，即靠 `coach_messages` 唯一约束去重）。
5. **气泡未接浏览器通知**：只在页面打开时可见（不做 Web Push）。
6. ~~P4 只有服务端那一半~~ → **P5 已补上图的另一半**（v0.2.55）：折线由 `chart-utils#renderTrendSvg`
   在**本地代码**里画（320×112 紧凑画布，数字全部来自 SQL），气泡由 `.coach-dock-rail` 托在胶囊正上方。
   ★ 但**气泡的触发链路仍未经真机端到端验证**——「服务端定时出卡 → SSE 推 → 气泡冒出 → 点开抽屉
   滚到那张卡」需要一条真的推送。本批锁到的是三段：准入判定（单测 4 例）、图形链与布局
   （真机探针 33 条）、老路径无回归（`coach-cdp.mjs` 38 条）。触发链路见第 8 条。
7. **卡片上的词条名来自全局词条库**：`term_mention_log.owner_id` 已**按人记**（数据基础就位），
   但 `term_library` 仍是**全局表**（无归属列）⇒ 多租户下榜单取自全库，须等 `term_library` 归主（M2d）。
8. **气泡只在"页面正开着"时才可能看到**：`coach-card` 是 SSE 推送，**只发给推送那一刻连着的客户端**。
   卡片本身照常落库 ⇒ 页面没开（或那一刻正好在重连）时，用户下次打开只能在抽屉流水里看到这张卡，
   而**不会补一个气泡**。这是"复用既有 SSE、不新造通道"的必然代价，也是刻意的：为一条天级通知
   上 Web Push 不值当（同 `COACH-SPEC` 的克制口径）。★ 因此**气泡的触发未做自动化验证**：
   真机复现要在页面开着时等到一次 6h tick（或重启后端，让调度器起服即跑一次），属"真机端到端"
   范畴，判定权在老板；已挂 `test-plan.md` §6。★ 另注：`scrollIntoView({behavior:'smooth'})`
   与 `prepareSvg` 的浏览器路径**只被仪器验到"能算对、排得对"**，真机上那一下"滚过去"的手感须目检。
