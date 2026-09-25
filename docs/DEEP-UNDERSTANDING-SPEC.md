# 深度理解（Deep Understanding）功能契约 v1.1

> 状态：**待评审**（写代码前的准备工作，尚未落任何实现代码）
> 日期：2026-09-02 立 v1 · **2026-09-06 修订 v1.1**（反馈加强：证据式判定 + 词条直达深度理解·出题评估，老板拍板，全量纪要见 §16）· **2026-09-16 改名 v1.1.2**（对外名称由「认知进化」改为「深度理解」，文件随改名 `DEEP-UNDERSTANDING-SPEC.md`；内部标识符未动，见 §16.4）· 适用仓库：`Desktop\studentbuddy-v2`（monorepo：server / shared / web）
> 铁律来源：`AGENTS.md`（六条 ADR + 工程红线）；本文是「先改契约再改码」（`AGENTS.md` §已知约束）要求的载体。

---

## 1. 目标与服务哪一环

**一句话**：把「用户对一个词条的理解」从通俗到准确做成可累积的等级链，由 AI 在对话中判定等级；等级升则复习/出题难度随之升档，理解链本身即复习材料。

- 服务闭环：**忆（M3 词条库）→ 析（判定缺口）→ 练（难度联动）→ 反馈（XP）** 的合环，不新建第六环。
- ADR-1 自检：不是「又一个功能」，而是让已有词条库从「存住」升级为「练准」。
- 形态（老板 2026-09-02 拍板）：**不做独立页面**，做**对话页的一个模式**——开启前必须先选 1..N 个词条，开启后正常与 AI 对话，AI 每轮给出理解度判定。
- 形态 v1.1 追加（老板 2026-09-06 拍板）：入口增加**词条直达**——词条行「深度理解」按钮一键就该词条开启深度理解对话，且**首轮 AI 直接对该词条出题**（`[QUIZ]` 单题水平探针）评估用户认知程度，答完转入追问；自由讲述方式照旧共存。仍不建第二个聊天壳（§16.2）。

---

## 2. 现状盘点与接入点（改哪里，精确到行）

| 文件:行 | 现状 | 本功能要动的地方 |
|---|---|---|
| `packages/server/src/storage/db.ts:150-180` | 迁移体系 v1..v6（v6 给 sessions 加 doc 两列；**v7 已被词条库 AI 整理占用，2026-09-03**） | **新增 v8**（三张/四列，见 §5） |
| `packages/server/src/chat/flow.ts:24-31` | `SYSTEM_PROMPT` 常量 | 深度理解模式下**替换**为教练版（不追加，见 §6.2） |
| `packages/server/src/chat/flow.ts:92-108` | 词条段 / 资料段注入 + `systemPromptTokens` 收口 | 新增深度理解模式段，**必须计入** `systemPromptTokens`（`AGENTS.md:35` 明确要求，否则又是 v1 老坑） |
| `packages/server/src/chat/flow.ts:164-178` | token 流累积 → `publish` | 插入**流式闸门**：`[VERDICT]` 段不上屏不落库（见 §6.3） |
| `packages/server/src/chat/flow.ts:225-232` | 收尾：抽词条 + `countUsage` | 深度理解模式下**跳过** `extractTerms`（训练内容不是新知识，避免脏词入库）；`countUsage` 保留 |
| `packages/server/src/index.ts:44-52` | 路由挂载 | 加 `app.use('/api/evolution', evolutionRouter)` |
| `packages/shared/src/content-blocks.ts:12-16` | `BlockKind` 登记 | 新增 `'verdict'`（先登记再实现，同步 `docs/SSE-CONTRACT.md`） |
| `packages/server/src/events/bus.ts:6-10` | `DomainEvent` 联合类型 | 新增 `evolution_levelup`（接入 XP 反馈环） |
| `packages/server/src/learning/activity.ts:9` | `XP_PER` 表 | 新增 `evolution_levelup: 6`（升级给最多 XP） |
| `packages/web/src/features/chat/ChatView.tsx:160-162` | composer 上方挂 `DocModeControl` | 并列挂 `EvolutionModeControl`（同一模式控件范式） |
| `packages/web/src/features/chat/ChatView.tsx:107-122` | `m.quizBlock` → `QuizCard` | 同构加 `m.verdictBlock` → `VerdictCard` |
| `packages/web/src/features/terms/TermsPage.tsx:132-177` | 词条项 | 词条项加「理解链」展开（复用 `evolution_event` 快照）；**v1.1** 加「深度理解」直达按钮（点击 → 新会话预开深度理解模式并选定该词条 + `probeFirst`，经 app 级跳转参数由 ChatView 消费）。⚠ 行数风险：两项叠进后 TermsPage 若逼近 web 组件 ≤300 行红线，按钮与链展开一并抽入 `TermEvolutionActions.tsx` 小组件 |
| `packages/web/src/lib/api.ts:86-106` | `api.terms` 分组 | 并列加 `api.evolution` 分组 |
| `packages/web/src/components/icons.tsx` | SVG line-icon 基座 | 加 `EvoIcon`（自绘，禁 emoji） |

**可复用的既有资产**：文档模式的「会话绑定 + 只回元信息」范式（`routes/document.ts` + `DocModeControl.tsx`）、`[TERMS]`/`[QUIZ]` 的容错解析写法（`learning/terms.ts:45-59`、`learning/quiz.ts:16-30`）。

---

## 3. 概念模型：5 级理解链（老板拍板）

| 级 | 名称 | 判定的正面证据（rubric） | 典型缺口 |
|:--:|---|---|---|
| L0 | 直觉 | 能打比方/说个大概，方向对 | 用词不准、与相近概念混淆 |
| L1 | 复述 | 能说清大意，要素基本齐 | 缺关键限定条件/前提 |
| L2 | 准确 | 定义准确、要素完整、术语用对 | 说不出适用边界 |
| L3 | 边界 | 讲清适用边界、反例、与相近概念的区别 | 换个情境就不会用 |
| L4 | 迁移 | 能在新情境应用、能教别人、能指出他人表述的错误 | ——（顶层） |

判定规则：
- `level` 是**本次判定后该词条应处的等级**（0..4，离散，不插值）。
- 允许**降级**（理解回退是真实信号，不粉饰），`term_library.evo_level` 存最新判定。
- 另存 `best_level` **只增不减**，用于难度档与成就展示（避免一次失手把复习难度打回原形）。

---

## 4. 交互流程

```
用户：点「深度理解」→ 选词面板（领域 Tab + 搜索，勾 1..N 个词条）→ 开启
          │  POST /api/evolution { sessionId, termIds }
          ▼
服务端：写 evolution_session（会话绑定）→ 返回 { active:true, terms:[{…level}] }
          │
用户：用自己的话讲（composer placeholder 引导：「用你自己的话说说 XX」）
          ▼
flow.ts：system 注入【深度理解模式段】→ 模型点评 + 追问（正常文字上屏）
          └─ 末尾输出 [VERDICT]{…}[/VERDICT] → 流式闸门吞掉（不上屏/不落 messages）
                  ▼
          解析 → 写 evolution_event（链）→ 更新 term.evo_level/best_level
                → SSE block 事件 kind='verdict' → 前端 VerdictCard
                → publishEvent(evolution_levelup) → activity 记 XP
                  ▼
用户继续答 → 下一轮判定 …… 词条页可展开完整理解链回顾
```

无自动开场白（不额外调 LLM）：开启模式后由 UI placeholder 引导，AI 在首轮回复里自然承担「提问 + 判定」双重角色（靠 system 注入实现）。

---

## 5. 数据模型（DB 迁移 v8；原 v7 已被词条库 AI 整理占用，2026-09-03 改号）

```sql
-- v8：深度理解（2026-09-02 契约；版本号 2026-09-03 顺延）
-- 1) 会话的深度理解模式绑定：一个会话一套选题（与文档模式「生命周期随会话」同构）
CREATE TABLE IF NOT EXISTS evolution_session (
  session_id TEXT PRIMARY KEY,
  term_ids   TEXT NOT NULL,                        -- JSON string[]（term_library.id）
  probe_first INTEGER NOT NULL DEFAULT 0,          -- v1.1.1 勘误补列：直达提问式开场标志（§8 probeFirst 随会话持久化，刷新复原不丢）
  status     TEXT NOT NULL DEFAULT 'active',       -- active | closed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2) 理解链：每次判定一条 append-only 记录（链 = 按 created_at 排序）
--    term 被删也要能回顾，故冗余 term_text 快照，不加外键。
CREATE TABLE IF NOT EXISTS evolution_event (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  term_id    TEXT NOT NULL,
  term_text  TEXT NOT NULL,
  from_level INTEGER NOT NULL,
  to_level   INTEGER NOT NULL,
  verdict    TEXT NOT NULL,      -- AI 评语（面向用户）
  gaps       TEXT,               -- JSON string[] 缺口
  next_goal  TEXT,               -- 下一级目标（L4 时为 null）
  user_say   TEXT NOT NULL,      -- 本轮用户原话（截 2000 字），回顾时看得出「当时怎么说的」
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evo_event_term    ON evolution_event(term_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evo_event_session ON evolution_event(session_id, created_at);

-- 3) 词条持久化当前等级（不建新表：等级是词条的属性）
ALTER TABLE term_library ADD COLUMN evo_level  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE term_library ADD COLUMN best_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE term_library ADD COLUMN evo_updated_at TEXT;
```

迁移纪律（`AGENTS.md` ADR-6）：每条语句独立 `exec`、索引与建表同批、`schema_version` 逐版递增；**永不触碰 v1 原库**。

---

## 6. 协议设计

### 6.1 `[VERDICT]` 输出协议（模型侧）

模型在正常点评文字之后输出，外围包一对标记（与 `[TERMS]`/`[QUIZ]` 同风格）：

```
[VERDICT]{"term":"闭包","level":2,"verdict":"你把「函数记住外部变量」说清楚了，但没说清捕获的是变量本身还是值，这是 L2 到 L3 的关键。","gaps":["未区分捕获变量与捕获值","没提生命周期"],"nextGoal":"说清闭包捕获变量的生命周期，并举一个踩坑例子","evidence":"用户原话中最能支撑判定的一句","met":["说清了捕获的是变量本身而非值"]}[/VERDICT]
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `term` | string | 必填；必须是本会话深度理解词条之一（服务端校验，不匹配则丢弃该块） |
| `level` | number | 必填；钳到 0..4，非数字 → 丢弃该块 |
| `verdict` | string | 必填；面向用户的评语（≤500 字） |
| `gaps` | string[] | 可选；缺缺口列表，空数组视为无 |
| `nextGoal` | string \| null | 可选；`level<4` 时应给出 |
| `evidence` | string | 可选；留档，不展示 |
| `met` | string[] | 可选（**v1.1 新增**）；本轮命中的 §3 rubric 正面证据要素，每条须可在用户本轮原话里指认（`normalizeVerdict`：非字符串数组→丢字段；超 3 条截 3；**空数组合法** = 本轮没新证据，前端据此渲染「等级不动且无进展」的诚实档） |

一轮可输出**多个** VERDICT 块（用户一次讲多个词条时），闸门与解析均支持重复出现。

### 6.2 System 段注入（`flow.ts`）

深度理解模式激活时，`SYSTEM_PROMPT` **替换**为 `EVOLUTION_SYSTEM_PROMPT`（不是追加——主提示「回答简洁好用」与「教练式追问+判定」语义冲突，追加会让模型左右摇摆）：

- 角色：严格但鼓励的教练，**不直接给答案**，先让用户自己说。
- 输入：目标词条清单 + 每个词条当前等级 + 该等级的提问侧重（见 §10 难度表）+ 词条现有释义（AI 内部参考，**不许**原样念给用户）。
- 输出纪律：先给点评与下一问（正常文字，用户可见），最后输出 `[VERDICT]` 块（用户不可见）。
- 判定纪律：宁可判低不可判高；只有 rubric 证据充分才升级；用户答非所问时 `level` 取当前等级（不变）并在 `verdict` 里说明。
- **v1.1 反馈纪律（治「没升级 = 没反馈」）**：等级不动的轮次，`met` 与 `gaps` **不得同时为空**——要么列出「本轮命中的 rubric 要素」（离升级又近一步的证据），要么列出「还缺什么」。`normalizeVerdict` 对双空块兜底：`verdict` 保留、`met` 置空数组（前端渲染「本轮无新证据」，但绝不静默吞卡）。
- **v1.1 提问式开场**（仅 `probeFirst=true` 的词条直达会话）：首轮回复必须先出一道该词条的单题 `[QUIZ]` 探针题再开始追问——题干与干扰项按 §10 该等级档侧重（L0 考直觉识别、L3 必含边界辨析），`[QUIZ]` 字段清单与示例照 `QUIZ_PROTOCOL` 既有纪律（**字段必须出现在示例里**，flash 级实测教训移植）。复用既有解析阶梯与 `QuizCard` 渲染：**零新协议、零嵌套 LLM 调用**。
- **反幻觉**：不许把未讲过的内容算作用户已掌握。

### 6.3 流式闸门（关键实现约束）

`[VERDICT]` 段**既不上屏也不落 `messages`**，以维持 `flow.ts:126-132` 的「屏上文本 == 库内文本」铁律。实现为纯函数模块：

```ts
// learning/verdict.ts —— 纯函数、零 IO、可单测
export const VERDICT_OPEN = '[VERDICT]';
export const VERDICT_CLOSE = '[/VERDICT]';
export class VerdictGate {
  push(chunk: string): { visible: string; blocks: string[] }  // visible=上屏且入 acc；blocks=完整块原文
  flush(): { visible: string; blocks: string[] }              // 流结束时把悬空前缀吐回可见文本
}
export function parseVerdictBlock(raw: string): Verdict | null  // 容错：围栏/```json/前后杂质/首个 JSON 对象
export function normalizeVerdict(v: Verdict, allowed: Set<string>): Verdict | null  // term 白名单 + level 钳制
```

闸门要点：
1. **跨 chunk 边界**：`[`、`[V`、`[VERDICT` 可能分多次到达 → 保留最长真前缀缓冲（≤9 字符）。
2. **未闭合不误吞**：流结束时仍未出现 `[VERDICT]` → `flush()` 把缓冲原样吐回可见文本（绝不吞用户看到的字）。
3. 只处理 **assistant** 输出，用户输入不过闸门。

---

## 7. 服务端模块划分（红线：单文件 ≤400 行）

| 文件 | 职责 | 预估行数 |
|---|---|---|
| `learning/verdict.ts` | 协议常量 + `VerdictGate` + `parseVerdictBlock` + `normalizeVerdict`（纯函数） | ~150 |
| `learning/evolution.ts` | 会话绑定（get/set/clear）、`applyVerdict`（写链 + 更新等级）、`chainOf(termId)`、`stateOf(sessionId)` | ~200 |
| `routes/evolution.ts` | 薄路由（参数校验 + 调 service，零业务逻辑 ADR-3） | ~90 |
| `chat/flow.ts` 改动 | 注入段 + 闸门 + 收尾应用判定 + 跳过抽词 | +60 |

---

## 8. HTTP API（`/api/evolution`，`routes/evolution.ts`）

| 方法 | 路径 | 请求 | 响应 | 失败 |
|---|---|---|---|---|
| GET | `/api/evolution?sessionId=` | — | `EvolutionState` | 缺参 400 |
| POST | `/api/evolution` | `{ sessionId, termIds: string[], probeFirst?: boolean }`（**v1.1 加法**：直达入口传 true → 深度理解段提示词带提问式开场令；缺省 false，手动开启路径行为与 v1 完全一致） | `EvolutionState`（201） | 缺参/空数组 400；词条不存在 404；会话不存在 404 |
| DELETE | `/api/evolution?sessionId=` | — | `{ ok:true }` | 缺参 400 |
| GET | `/api/evolution/chain/:termId` | `?limit=` 默认 50 | `EvolutionEventRow[]` | — |

```ts
// packages/shared/src/domain.ts 新增（契约先行）
export interface EvolutionTermState {
  id: string; term: string; domain: string; definition: string;
  level: number;      // 当前等级（最新判定）
  bestLevel: number;  // 历史最高（只增不减）
}
export interface EvolutionState {
  active: boolean;
  terms: EvolutionTermState[];
}
export interface EvolutionEventRow {
  id: string; sessionId: string; termId: string; termText: string;
  fromLevel: number; toLevel: number;
  verdict: string; gaps: string[]; nextGoal: string | null; userSay: string;
  createdAt: string;
}
```

---

## 9. 契约登记（三项，先登记再实现）

1. **`BlockKind` 新增 `'verdict'`**（`shared/content-blocks.ts`）→ 同步 `docs/SSE-CONTRACT.md`。
   payload：`{ kind:'verdict', blockId:'evo-<termId>-<ts>', payload: VerdictPayload }`，经既有 SSE `block` 事件下发（不新增事件类型）。
2. **`DomainEvent` 新增** `{ type:'evolution_levelup'; termId:string; term:string; from:number; to:number }`（`events/bus.ts`）→ `activity.ts` 订阅记 XP（`XP_PER.evolution_levelup = 6`）。
3. **`ModelRole` 不新增**：判定由主对话模型（explain 角色）在正常回复末尾顺带输出，零额外 LLM 调用（省钱省延迟）。
   扩展点留档：若将来「判定」需要独立更强模型，加 `evaluator` 角色 + `MODEL_ROLES` 一行即可，不动其余代码。

---

## 10. 难度联动（等级 → 出题档位）

`generateQuiz(topic, material, level)` 增加可选 `level`；`/api/quiz/generate` 透传。ChatView「出题」按钮在深度理解模式下自动带上目标词条的 `level`。

| level | 提问侧重 | 题型配比 | QUIZ_PROTOCOL 追加指令 |
|:--:|---|---|---|
| 0 | 直觉·识别 | single / 判断 | 选项要「通俗说法 vs 错误说法」，不考术语细节 |
| 1 | 复述·要素 | single / fill | 考要素完整性，干扰项缺关键限定 |
| 2 | 准确·应用 | single / fill / multiple | 考准确定义与常规应用 |
| 3 | 边界·反例 | multiple / fill / 找错 | 必须含边界与易混辨析，干扰项取自典型误解 |
| 4 | 迁移·教学 | essay / 情境设计 | 给新情境，要求迁移应用或纠错讲评 |

未传 `level` 时行为与今天完全一致（向后兼容，不动既有题库）。

---

## 11. 前端改动（红线：组件 ≤300 行，禁内联 `style={{`，禁 emoji）

| 组件 | 文件 | 要点 | 预估行数 |
|---|---|---|---|
| 深度理解模式控件 | `features/chat/EvolutionModeControl.tsx` | 三态齐备（ADR-5）：未开（按钮）/ 开启中（禁用+「开启中…」）/ 已开（pill：深度理解中 · 词条 · 当前等级 · 关闭）。选词面板：领域 Tab + 搜索 + 多选（≥1 才可开启）。切会话重取（`alive` 防串台，照抄 `DocModeControl.tsx:28-45`） | ~260 |
| 判定卡片 | `features/chat/VerdictCard.tsx` | 等级徽章 `L1 → L2`、升/降级配色、缺口列表、下一级目标；**v1.1**：顶部 5 格等级阶梯条（点亮至当前级、`best_level` 档浅色描边——「只增不减」字段的首个展示位）+ `met` ✅ 勾选清单（等级不动轮次的正反馈主渠道）；阶梯纯 CSS token 实现不引库 | ~180 |
| 理解链 | `features/terms/TermEvolutionChain.tsx` | 时间轴（竖线 + 节点）：每级时间 / 等级变化 / 用户当时原话 / AI 评语 / 缺口 | ~190 |
| 图标 | `components/icons.tsx` | `EvoIcon` 自绘 SVG line-icon（`currentColor`） | +12 |

样式一律走 `tokens.css` token 与既有 `chat.css`/`terms.css` class，**不内联 style**（gates 会拦）。

---

## 12. 降级与风险（ADR-4：失败只记日志，绝不阻塞对话主链）

| 风险 | 处理 |
|---|---|
| 模型不输出 `[VERDICT]` | 无判定 → 不落链、不报错；UI 不展示卡片（本轮视为「未判定」），对话照常 |
| 输出畸形 JSON / 字段缺失 | `parseVerdictBlock` 返回 `null` → 同上降级 |
| `term` 不在本会话选题内 | 丢弃该块（防模型乱判别的词条） |
| 闸门误吞正文 | 只拦 assistant 输出；`flush()` 兜底吐回；单测覆盖跨 chunk 与未闭合两种边界 |
| 深度理解模式下词条自动抽取污染 | 深度理解模式跳过 `extractTerms`（`flow.ts:227`），`countUsage` 保留 |
| 上下文膨胀 | 深度理解段计入 `systemPromptTokens`（`flow.ts:101`），与词条段/资料段同口径 |
| 词条被删 | `evolution_event` 有 `term_text` 快照，链仍可读；`stateOf` 自动剔除已删词条 |
| 一轮多词条 | 闸门支持多个块；每个块独立落链 |

---

## 13. 测试清单（`AGENTS.md` §工程红线：改代码必带测试）

| 文件 | 用例要点 |
|---|---|
| `learning/verdict.test.ts` | 围栏/```json/前后杂质容错；`term` 白名单外丢弃；`level` 越界钳制与非数字丢弃；多块解析 |
| `learning/verdict-gate.test.ts` | 逐字喂入；跨 chunk 边界（`[VER` + `DICT]`）；未闭合 `flush()` 原样吐回；闭合后正文继续 |
| `learning/evolution.test.ts` | 开启/关闭幂等；`applyVerdict` 写链 + `evo_level` 更新 + `best_level` 只增；降级路径；已删词条剔除 |
| `routes/evolution.test.ts` | 缺参 400 / 空数组 400 / 会话不存在 404 / 开启后 GET 复原 |
| `learning/verdict.test.ts`（v1.1 追加） | `met` 容错三态（非数组丢 / 超 3 截断 / 空数组合法）；双空兜底策略；示例 JSON 自带 `met` 字段可被解析（防「字段没进示例」老坑） |
| `chat/flow.test.ts`（v1.1 追加） | 深度理解模式回复含 `[QUIZ]` 探针题时：quiz block 正常解析上卡、`[VERDICT]` 闸门不被探针题干扰（两协议共存回归）；`probeFirst` 段计入 `systemPromptTokens` |

通过后同步 `docs/dev/test-plan.md` 的**基线用例数与不变量清单**（不同步即违规）；跑 `npm run check`（tsc×3 + eslint + vitest + gates）全绿。

---

## 14. 任务拆解（WBS，按可独立验收排序）

| # | 任务 | 产出 | 依赖 |
|:--:|---|---|---|
| 1 | 契约登记：`BlockKind 'verdict'` + `DomainEvent` + shared 类型 | 改 3 个文件 + 同步 `docs/SSE-CONTRACT.md` | — |
| 2 | DB v8 迁移 | `db.ts` 追加 v8 数组 | 1 |
| 3 | `learning/verdict.ts`（闸门 + 解析）+ 两个测试文件 | 纯函数 + 单测绿灯 | 1 |
| 4 | `learning/evolution.ts`（绑定 / 判定 / 链查询）+ 单测 | service + 单测绿灯 | 2,3 |
| 5 | `routes/evolution.ts` + 挂到 `index.ts` + 路由单测 | 4 个端点 | 4 |
| 6 | `flow.ts` 接入：深度理解段注入 + 闸门 + 收尾应用判定 + 跳过抽词 | 对话主链闭环 | 3,4 |
| 7 | 前端 `EvolutionModeControl` + `VerdictCard` + api 分组 + `EvoIcon` | 对话页可用 | 5,6 |
| 8 | 难度联动：`generateQuiz` 加 `level` + 出题按钮带档 | 练环联动 | 4 |
| 9 | `TermEvolutionChain` 理解链回顾 | 忆环闭环 | 5 |
| 10 | 反馈环：`evolution_levelup` → XP；同步 test-plan / CHANGELOG / AGENTS.md | 全环合上 | 4 |
| 11 | **v1.1** `met` 管线：shared 类型 + `normalizeVerdict` 容错与双空兜底 + 提示词反馈纪律 + 单测 | 证据式判定协议就绪 | 1,3 |
| 12 | **v1.1** VerdictCard 阶梯条 + `met` 勾选清单 + CSS token 阶梯样式 | 「没升级也有话」落地 | 11 |
| 13 | **v1.1** 词条直达：TermsPage「深度理解」按钮（必要时抽 `TermEvolutionActions.tsx`）+ ChatView 跳转消费 + `probeFirst` 提问式开场 + 共存回归锁 | 一键评估入口 | 4,5,6,11 |

建议分批提交：1-2 → 3-4 → 5-6 → 7 → 8-10（每批 `npm run check` 全绿再提交）。

---

## 15. 待拍板（评审时确认，不影响已定部分）

1. **降级是否写链**：当前设计写（诚实记录回退）。若你希望链上只显示「最好轨迹」，改为降级不落 `evolution_event`、只更新 `evo_level`。
2. **选题上限**：建议单会话 ≤5 个词条（等级判定要逐个给，太多会稀释每轮深度）。
3. **难度取 `level` 还是 `best_level`**：当前设计取 `level`（跟随当前真实水平）。

---

## 16. v1.1 修订纪要（2026-09-06 · 反馈加强 · 老板拍板）

**原提示词（逐字）**：

> 「但是这个深度理解目前的反馈太弱了,所以需要加强」
> （方向选择时）「让用户可以直接在词条哪里展开对话,可以让ai直接对词条进行出题,然后评估用户的认知程度」

### 16.1 根因诊断（为什么 v1 设计会「反馈弱」）

1. 判定纪律「宁判低不判高」是对的（反幻觉），但 v1 的反馈面只设计了升/降配色——**等级不动的轮次（多数轮）零正反馈**，用户体感＝问了半天没反应；
2. 入口在对话页模式控件里，**开启前要自己选词**，链条长；词条页（用户刚看过答案的地方）反而没有深度理解入口；
3. 判定介质是自由讲述，冷启动靠 placeholder 引导——首轮没有结构化评估抓手。

### 16.2 v1.1 范围（两件事）

- **A 证据式判定**：`[VERDICT]` 加 `met` 字段（§6.1）+ 反馈纪律「双空禁止」（§6.2）+ VerdictCard 阶梯条与勾选清单（§11）。核心不变式：**等级不动的轮次也必须输出证据增量或缺口**，判定严格度不降、反馈量上升。
- **F 词条直达深度理解**：词条行「深度理解」按钮 → 新会话预开深度理解模式选定该词条 + `probeFirst=true` → 首轮 AI 出 `[QUIZ]` 单题水平探针（复用解析阶梯与渲染，零新协议零嵌套调用）→ 作答后转入追问。定档**开新会话**（理解链随会话隔离更干净，与文档模式「生命周期随会话」同构）；不建第二个聊天壳。

### 16.3 本轮显式不做（候选池，老板未选，不悄悄扩权）

- B 缺口一键复练（gaps 点击「针对这个出一道」+ 修复回写链节点）——依赖 A 落地后缺口数据已有，属纯加法，候选 v1.2；
- C 本场结算卡 + 今日总结深度理解行（★ 2026-09-25：后一半随「今日总结」整页下线消失，这条候选只剩结算卡，见 `QUIZ-NOTES-SPEC` 墓碑）；D XP 按跨度分档与 L4 成就；E 词条页 best_level 轨迹缩略图（v1.1 阶梯条已占用 `best_level` 展示位，E 剩「历史轨迹图」部分）；
- 以上均**未写入正文契约**，落码批次若顺手的行（如 activity 费率函数化）也不得夹带——先回契约重新拍板（照 QUIZ-IMAGE-SPEC §4「显式划界」先例）。

### 16.4 版本记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-02 | v1.0 | 建契约：5 级链、VERDICT 闸门、难度联动，评审前状态 |
| 2026-09-06 | v1.1 | 反馈加强：`met` 证据式判定 + 双空禁令 + 阶梯条卡片；词条直达深度理解按钮 + `probeFirst` 提问式开场（`[QUIZ]` 探针复用）；WBS +11/12/13；候选池划界（B/C/D/E 不做） |
| 2026-09-06 | v1.1.1 勘误 | 落码时补 §5 `evolution_session.probe_first` 列（§8 `probeFirst` 的持久化载体，评审时漏随附建表 SQL；纯表结构补齐，协议与提示词行为不变）。同时定档：`met` 不落链——仅经 SSE verdict block 做会话内即时反馈，链回顾保持 v1 字段集 |
| 2026-09-16 | v1.1.2 改名 | **对外名称「认知进化」→「深度理解」**（老板拍板：更接地气），文件同步改名 `COGNITIVE-EVOLUTION-SPEC.md` → `DEEP-UNDERSTANDING-SPEC.md`，全仓文档与代码注释 140 处引用一并更新（术语连带：进化链→理解链、进化模式→深度理解模式、进化段→深度理解段）。**本轮只改对外名称**：内部标识符（表 `evolution_session`/`evolution_event`、索引 `idx_evo_*`、列 `evo_level`/`evo_updated_at`、API `/api/evolution`、类型 `EvolutionTermState`/`EvolutionState`/`EvolutionEventRow`、事件 `evolution_levelup`）**保持原样**——**v8 迁移已在真实库生效**（实测 `%APPDATA%\studentbuddy-v2\studentbuddy.db`：`schema_version`=16、两表与三列在位、138 会话/1073 消息），就地改 v8 语句不会重放，只会让应用找不到表；要统一标识符必须**新开迁移版本做 RENAME + 先备份真库**，已单列待老板拍板 |
