# QUIZ-NOTES-SPEC — 刷题笔记契约 v1.0（2026-09-13）

> ## ⚰️ 状态：**已下线（墓碑）** — 2026-09-25 功能整族删除，本文件不再描述现役能力
>
> ★ **一句话**：「刷题笔记」这个 tab、`/api/notes` 路由、`quiz_notes` 的读写与自动落稿、
>   shared 的 `QuizNote`/`QuizNoteSummary` 类型、搜索的 `note` 一类**全部从仓里删掉了**。
>   本文件保留全文只作沿革（§2 的数据模型、§4 的自动落稿语义仍是"当初为什么这么做"的凭据），
>   ⚠️ 但**文中任何"已落地/现役/待办"的字样都不再是事实**——引用前先读本段。
>
> **为什么删（老板原话，2026-09-25）**：「studentbuddy 的今日总结和笔记功能全部砍掉，不要留，
> 原因就是没有人使用」；追问删到哪一层时拍板「**连表一起删，分析降级认了**」
> ⇒ 本批先把代码与表断开，`DROP TABLE quiz_notes` 留到 **v45** 迁移单独一批做（不可逆，需逐次授权发版）。
>
> ★ **同日晚些时候老板把这句理由补全了（2026-09-25 深夜，逐字）**：「**线上实测用户对这些功能不感兴趣，并且这些是依赖于对话核而存在和设计的，一个功能完全没有人想使用，那么他就很难有存在的意义**」
> —— 三个层次依次是**实测观察**（线上没人用）／**结构判断**（它们不是独立功能，是长在对话核上的派生物，
> 所以"没人单独来用"不会因改版而改变）／**存废准则**（完全没人想用的功能难以有存在意义）。
> ⚠️ **一条口径要写准，免得后人误读**：仓内**从来没有**页面级访问计数能证明「有没有人打开过今日总结页／写过笔记」
> （`daily_activity`／`user_stats` 两本账数的不是这个；库里那两张表里确实留着三个注册用户写过的行）。
> ⇒ 这句理由是**老板基于线上观察下的判断**，权威落点在此，**不是某台机器量出来的读数值**；
>   本仓的纪律是不替他补一个不存在的证据数字，也不拿"无法量化"去消解他的判决。第三层那条准则是**通用的**，
>   今后凡"依附对话核的派生功能"要不要留，先过这一问（同批登记见 `GAMIFIED-AGENT-SPEC.md` §9）。
>
> **已知代价（同批登记，别当成没发生）**：`quiz_notes.my_answer` 是「薄弱点分析」唯一的错因素材，
> 随之下线后分析只剩题干/选项/正确答案/历史正确率 ⇒ 产出会退化成"按考查点归因"的通用建议。
> 细节与提示词的相应改写见 `docs/QUIZ-WEAK-SPEC.md` §4。要恢复这条洞察，需要给作答内容找一个**新的**存储位。
>
> **被这条牵连的其他契约/资产（同批改）**：
>  · `docs/FTS-SPEC.md`：`FTS_KINDS` 三类减两类，库里残留的 `kind='note'` 旧索引行由查询侧白名单挡掉
>  · `docs/TENANCY-SPEC.md` §8.2：M2d-1/M2d-3 的 `quiz_notes` 归主段作废（做完又整族删除）
>  · `docs/dev/test-plan.md`：`learning/notes` · `routes/notes` · `features/notes/note-format` 三行登记删除
>  · 对外面：README 功能表与视图清单、落地页「九宫格」第 05 格、`docs/dev/manual-test.md` MT-32/MT-33
>
> ---
>
> 版本：v1.0 | 状态：~~[活跃]~~ **已下线**（2026-09-13 立；2026-09-25 整体删除，见上方墓碑） | ★ **v1.0.1＝2026-09-25 22:2x 仅在墓碑里补登老板理由的逐字全文**（简称「原因就是没有人使用」→全句，另加"无页面级计数"的口径一句）；**零代码、零删除动作变化**，正文其余一字未动

> 每道题对应一篇笔记：**提交答案即自动落草稿**（题目 / 我的作答 / 对错 / 解析为快照），
> 心得由用户手写补全。本契约钉数据模型、API、自动落稿语义与 UI 边界。
> ⚠️ 以下为删除前的原始契约全文，保留不回改（回标不回改）。

## 1. 背景与目标

- 练环（`quiz_bank` / `quiz_stats`）已有出题与逐题统计，但作答完没有沉淀物——对在哪、错在哪、当时怎么想的，关掉页面即丢。
- 刷题笔记把「每道题的作答瞬间」固化为可回顾的学习资产：草稿零操作自动生成，心得按需补写。
- 定位：练环的**产物沉淀**，不是新学习环。不做 SRS 排程（那是忆域的活）、不做 AI 错因分析（v1.1 预留，见 §8）。

## 2. 数据模型（迁移 v12）

```sql
CREATE TABLE quiz_notes (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL,
  question_index INTEGER NOT NULL,
  quiz_title TEXT NOT NULL DEFAULT '',   -- 快照，冗余
  question_data TEXT NOT NULL,           -- 整题 JSON 快照（QuizQuestion，svg 含在内）
  my_answer TEXT,                        -- 作答快照 JSON：number[]（选择）/ string（填空）/ NULL
  correct INTEGER NOT NULL DEFAULT 0,    -- 最近一次作答对错
  body TEXT NOT NULL DEFAULT '',         -- 用户手写心得（Markdown）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(quiz_id, question_index)
);
CREATE INDEX idx_quiz_notes_updated ON quiz_notes(updated_at);
```

决策点：

1. **快照自洽，不设外键**：`quiz_title` / `question_data` 冗余入库，题库删除后笔记仍可读——用户的学习成果不随题库生命周期（与 `evolution_event` 冗余 `term_text` 是同一手法的镜像决策）。`deleteQuiz` 也不级联删笔记。
2. **每题一篇**：`UNIQUE(quiz_id, question_index)` 既是幂等 upsert 的落点，也是「一道题一篇笔记」的产品语义。
3. **心得只属于用户**：`body` 只有 PUT /api/notes/:id 一条写路径，自动流程（重复作答）永不触碰。

## 3. 自动落稿语义（upsertNoteFromAnswer）

挂在 `POST /api/quiz/stats/record` 之后，`learning/notes.ts` 实现，stats/record 的所有调用方（题库页、聊天页 quiz block）一条龙生效，UI 无需单独触发：

- 首次作答：建草稿，快照取自 `quiz_bank.data` 的对应题。
- 重复作答：`ON CONFLICT` 只刷新 `correct` / `my_answer` / `updated_at`；`my_answer` 用 `COALESCE` 保留旧值（本次没传不清洗成 null）；**`body` / `created_at` / 题目快照不动**。
- 题库或题目下标不存在：静默跳过（统计主流程不受影响，笔记失败不阻塞答题）。
- `answer` 入参白名单：仅收「全数字数组」（选择）与「字符串」（填空，截 2000 字）；其余形状丢弃——不可信输入不进快照。essay 不产作答快照（null）。

## 4. API 契约（/api/notes，薄路由 ADR-3）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/notes?quizId=&wrong=1` | 列表（`QuizNoteSummary[]`），`updated_at` 倒序；`wrong=1` 只看错题 |
| GET | `/api/notes/:id` | 详情（`QuizNote`，含 `questionData` 快照与 `myAnswer`）；404 = 不存在 |
| PUT | `/api/notes/:id` | `{ body: string }` 写心得；≤ 20,000 字（业务闸，独立于 express.json 总闸）；400 非字符串 / 超长，404 不存在 |
| DELETE | `/api/notes/:id` | 删除单篇（用户显式操作，快照随之丢弃） |

- 写操作吃全局 `originCheck` 跨源闸门（挂 /api 下自动生效）。
- 快照字段不经任何 API 可改——它们是自动流程的地盘。

## 5. UI（features/notes）

- **独立一级页**：侧栏「笔记」（自绘 NoteIcon line-icon）；题库练习视图有「本套笔记」入口，带 `quizId` 过滤直达（导航点「笔记」则清除该过滤）。
- **列表**：对/错圆标 + 题干 + 「套题 · 第 N 题 · 日期 · 草稿/已写心得」；筛选 chips：全部 / 只看错题。
- **详情**：结构化快照区（题型标签、题干、svg 配图走 `SvgPreviewCard` 净化、选项标正确与误选、我的作答 / 正确答案 / 解析）+ 手写心得区（textarea + 保存 + Markdown 预览复用 `chat/Markdown.tsx`）+ 删除。
- 展示格式化收拢在 `note-format.ts` 纯函数（导出供单测，签名不变约定同 Markdown.tsx）。

## 6. shared 类型（domain.ts）

`QuizNoteSummary`（列表行）／`QuizNote`（详情，`questionData: QuizQuestion`、`myAnswer: number[] | string | null`）。type-only 引用 `content-blocks.js`，无运行时环。

## 7. 测试基线（test-plan §3，2026-09-13 实测）

- `learning/notes.test.ts` 10 例：落稿/幂等/心得不被覆盖/COALESCE/静默跳过/快照自洽/过滤/截断/坏快照容错。
- `routes/notes.test.ts` 6 例：一条龙落稿、过滤、快照与 hasBody、400/404、Origin 闸门。
- `features/notes/note-format.test.ts` 5 例；`storage/db.test.ts` v12 迁移 1 例（UNIQUE + 索引）。

## 8. 边界与预留

- **v1.0 不做**：AI 错因分析段（预留：可挂 analyzer 角色追加进 body 或独立列）、跨套题按考点聚合、导出。
- PK 对战答题不落笔记（对战快节奏，作答语义不同）；如需，P1 单议。
- 笔记随题库删除而保留是**特性不是泄漏**：题干快照本来就是用户答过的内容。
