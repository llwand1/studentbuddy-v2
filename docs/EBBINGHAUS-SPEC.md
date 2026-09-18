# EBBINGHAUS-SPEC — 词条复习（艾宾浩斯遗忘曲线）v1.0

> 契约落点：`packages/shared/src/ebbinghaus.ts`（判定唯一实现）／`packages/server/src/learning/term-review.ts`（域层）／
> `packages/server/src/routes/terms.ts`（三个端点）／`packages/web/src/features/terms/ReviewPanel.tsx`（UI）。
> 迁移：**v23**（`term_library` 加两列 + 新建 `term_review_log`）。

## 1. 背景与范围

词条库此前是「只进不出」的仓库：AI 抽进去就算完，用户没有任何机制回到旧词条——**入库越勤、欠账越多**，
这与「忆」这一环的目标正好相反。本契约给每个词条装一个**复习时钟**：

- **在范围内**：复习计划（七个经典节点）、欠账统计、今日队列、打卡（记住了／忘了）、真实天数可见。
- **不在范围内（下一批，方案待老板选）**：AI 督促（悬浮小窗对话）、自动安排到学习流、跨设备同步。

## 2. 复习计划：七个经典节点

| stage | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|-------|---|---|---|---|---|---|---|---|
| 间隔（天） | 1 | 2 | 4 | 7 | 15 | 30 | 60 | — 毕业 |

- 来源：艾宾浩斯原始复查点为 20 分钟／1 小时／9 小时／1 天／2 天／6 天／31 天。
  **前三个是当天内的**，而本功能以天为最小单位（见 §4.1），故合并成「第 1 天」；后面的 2/6/31 取整为 2/7/30，
  再补 60 天作收尾档。**数值不改，只做「天」这个粒度下的投影**。
- `stage = 7` 即毕业（长期记忆）：仍记录天数，但**不再进队列**——催它等于让毕业失效。

## 3. 数据模型（迁移 v23）

```
term_library.review_stage      INTEGER NOT NULL DEFAULT 0   -- 当前阶段
term_library.last_reviewed_at  TEXT                          -- NULL = 从未复习
term_review_log(id, term_id, stage, remembered, reviewed_at, reviewed_day)  -- 只追加的流水
```

★ **不落 `next_review_at`**：下次复习时间 = 基准日 + 本阶段间隔，是**派生值**。落库则将来调整间隔序列
（如 4 天改 3 天）必须洗全表，否则新老行口径分裂（本仓在 `sessions.summary_upto_rowid`、
`auth_sessions.expires_at` 上已两次付过这个学费）。

★ `last_reviewed_at` **可空**的语义是「从未复习」，与「复习过但时间未知」必须区分：前者退到
`created_at` 当起算点（否则新词条永远 0 天、永不进队列），后者是脏数据。哨兵值（如 1970）会让
「没复习」看起来像「很久没复习」。

★ `term_review_log.stage` 记的是**复习前**的阶段：记复习后的话，流水永远算不出「这次是从哪个间隔来的」，
曲线图就丢了横坐标的语义。`reviewed_day` 由应用层用 `localDayKey(now)` 填（**不用 SQL 的 `date('now')`**，
那是 UTC 日，在 +8 区晚上会记到前一天）。

## 4. 判定口径（`shared/ebbinghaus.ts`，前后端唯一实现）

1. **以天为最小单位**：不做小时级倒计时。用户能看见的最小刻度就是「日期」，且小时级提醒会让同一天反复弹。
   天数按**本地日历日**算（`localDayIndex`），不是「满 24 小时算一天」——差一小时跨日也算一天。
2. **存储按 UTC 读、日历按本地判**：SQLite 的 `datetime('now')` 是无时区标记的 UTC 文本，解析时显式补 Z；
   取「哪一天」时回到本地日历日（用户在 +8 区，晚上复习不该被算成前一天）。两者混用 = 差一天，
   而「差一天」在复习场景里就是「今天该不该背」这种可见错误。
3. **到期 = 保持率掉到 70%**：间隔与曲线是同一件事的两面——`R(t) = 0.7^(t / 间隔)`。
   复习当天 100%、到期那天恰好 70%、两倍间隔 49%。长期不复习钳在 5%（不显示 0% 这种吓人的数）。

| status | 判据 | 含义 |
|--------|------|------|
| `upcoming` | `daysSince < 间隔` | 还没到，还剩 `dueInDays` 天 |
| `due` | `daysSince === 间隔` | 今天该复习 |
| `overdue` | `daysSince > 间隔` | 逾期 `overdueDays` 天 |
| `mastered` | `stage === 7` | 已入长期记忆 |

★ **忘了就归零**（经典重来）。刻意不做「退一级」这类折中：折中会让「下次什么时候来」不可预期，
而本功能全部价值就在**可预期**；归零是用户听得懂的一句话。

## 5. 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/terms/review/overview` | 概览：`total/due/overdue/fresh/todayDone/mastered/maxOverdueDays/stages/recent`（近 7 天，缺天补 0） |
| GET | `/api/terms/review/queue?limit=&domain=` | 今日队列（`limit` 归一 1..100，默认 20） |
| POST | `/api/terms/:id/review` | 打卡：`{ remembered: boolean }`，**必须是布尔**（没有合理默认值，猜成记住会白丢一次复习） |

队列排序：**先还旧账**——按 `overdueDays` 降序，同欠账按 `importance` 降序。若按到期时间排，
用户会永远在刷今天的新账，老账越滚越多，等于没做这个功能。

## 6. 前端呈现

- 词条页顶部 `ReviewPanel`：欠账统计 + 近 7 天柱状 + 今日队列（**先翻牌再看释义**，默认盖住释义——
  一上来摊开等于把复习降级成阅读）。
- 列表每行「N 天没复习」徽标：默认灰，逾期才上色（告警色只用一次，否则逾期不再是最显眼的信号）。
- **不做乐观切态**：打卡以服务端返回为准再更新队列（同 `useChoiceQueue` 手法）。

## 7. 未做（登记不欠账）

- **AI 督促**：单独悬浮小窗（可折叠）与督促 AI 对话——方案待老板从 demo 中选定，未落码。
- 复习提醒的**时机与频控**（节流/免打扰时段）随 AI 督促同批设计。
- 复习与「学习流」「知识图」的打通（把逾期词条自动排进学习流）未做。

## 8. 验收

- `packages/shared/src/ebbinghaus.test.ts`（15 例）：间隔序列、日历日口径、四种状态、保持率、阶段推进、文案。
- `packages/server/src/routes/term-review.test.ts`（8 例）：到期判定、先还旧账、打卡推进与归零、
  今日去重计数、入参校验与 404、跨源闸门。
- `packages/server/src/storage/db.test.ts`（+3 例）：v23 列/表/索引就位、**不含 `next_review_at`**、老库升级后既有词条为 `stage=0` 且 `last_reviewed_at IS NULL`。
