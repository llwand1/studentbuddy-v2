# AI 出题 PK 契约（PK-SPEC）

> 版本：v0.1.0 | 状态：[企划已定·未开工] | 更新：2026-09-09
> 定位：studentbuddy 的**移动端（微信内）双人对战玩法**——两人互相用提示词让 AI 给对方出题，
> 在固定时限内比「更快更准」，积分定胜负。
> 原则：**先立契约再改码**（AGENTS.md 已知约束）；登录契约先行，P0 模拟实现、P1 换真微信授权时前端零改动。
>
> **决策记录（2026-09-09 与老板 grill 钉死）**：
> ① P0 局域网双人 Demo（同一 WiFi 手机浏览器/微信内置浏览器可开），不做公网；② 登录 = 契约先行模拟登录；
> ③ 题型 P0 纯选择题（系统秒判分，零争议），后续可拓展；④ 胜负 = 固定时长积分制；
> ⑤ P0 范围 = 最小核心环（登录占位→建房/入房→出题/答题→计分→结算），**无观战、无战绩持久化**；
> ⑥ 实时同步复用 `chat/sse-bus.ts` 机制（频道键隔离）；出题引擎复用 `learning/quiz.ts` 管道。

---

## 1. 玩法规则（计分唯一事实源）

一局 PK = 固定时长（默认 **8 分钟**，服务端可配）内的双向对抗。双方**同时**拥有两个动作：
**出题**（写提示词 → AI 给对方出一道选择题）和**答题**（答对方出的题）。

| 动作 | 分值 | 约束 |
|------|------|------|
| 成功出 1 题 | **+1** | 服务端强制 CD：同一玩家两次成功出题间隔 ≥ `QUIZ_CD_MS`（默认 60s）；CD 内提交 → 429，不扣分 |
| 答对 1 题 | **+2** | 服务端判分（选择题：选项比对，毫秒级计时） |
| 答错 1 题 | **−1** | 判分即结算，无申诉 |
| 答题超时 | **−1** | 超过 `ANSWER_TIME_MS`（默认 45s）未提交，服务端自动判超时；之后该题作废不可再答 |
| 怠慢（长时间不出题） | **−1 / 次** | 对局进行中，每 `IDLE_PENALTY_MS`（默认 120s）内无一次**成功**出题提交（CD 中提交被拒不算，重试不算），扣 1 分，可累计 |

- **分数可为负**（增加紧张感，不设下限）。
- **结算**：对局时钟归零 → 分高者胜；平分比正确率（答对数），再平判为平局。
- 所有计时（CD / 答题时限 / 怠慢惩罚 / 对局时钟）**全部在服务端**，客户端时间只作展示——单一事实源，防作弊。
- **正确答案永不下发给答题方**（含 SSE 事件），直到该题被答或超时。

## 2. 数据契约（先在 `packages/shared/src/pk.ts` 登记再实现）

```ts
/** 题目（对答题方隐藏 answer） */
interface PkQuestion {
  id: string;            // pq-<roomId>-<seq>
  roomId: string;
  fromUserId: string;    // 出题人
  toUserId: string;      // 答题人
  prompt: string;        // 出题提示词原文（≤300 字，服务端截断）
  stem: string;          // 题干
  options: string[];     // 4 选项
  createdAt: number;
  deadlineAt: number;    // createdAt + ANSWER_TIME_MS
  status: 'pending' | 'answered' | 'timeout';
}

/** 对局快照（GET state / SSE 全量对齐用） */
interface PkRoomState {
  roomId: string;
  roomCode: string;      // 6 位数字，入房凭证
  status: 'waiting' | 'active' | 'finished';
  players: { userId: string; nickname: string; score: number;
             correct: number; answered: number; lastQuizAt: number }[];
  nextQuizAt: Record<string, number>;   // 各玩家 CD 解锁时刻
  endsAt: number;                       // 对局截止（active 时有效）
  questions: PkQuestion[];              // 答题方视角：answer 字段剥离
  winner?: string;                      // finished 时
}
```

### 2.1 REST 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/pk/auth/login` | `{ nickname }` → `{ userId, openid, nickname }`。**P0 模拟实现**：userId=服务端生成，openid=`mock_<userId>`；**P1 替换为微信公众号网页授权**（oauth2 code→openid），**响应结构不变，前端零改动** |
| POST | `/api/pk/rooms` | `{ userId }` → `{ roomId, roomCode }`；每人同时只能有 1 个 waiting 房 |
| POST | `/api/pk/rooms/join` | `{ roomCode, userId }` → `{ roomId }`；满员/不存在 → 404/409 |
| POST | `/api/pk/rooms/:id/start` | `{ userId }`（房主）→ 双方在线即 `active`，`endsAt = now + MATCH_MS` |
| POST | `/api/pk/rooms/:id/quiz` | `{ userId, prompt }` → 服务端调 AI 出 1 道选择题给对方。CD 内 → 429；对局未开始/已结束 → 409。成功后出题人 +1。AI 失败可免费重试（不计 CD） |
| POST | `/api/pk/rooms/:id/answer` | `{ userId, questionId, choice }` → 立即判分：`{ correct, delta, score }`；已答/超时 → 409 |
| GET | `/api/pk/rooms/:id/state` | 全量快照（断线重连对齐用） |
| GET | `/api/pk/stream?roomId=&userId=&since=` | SSE，见 §2.2 |

### 2.2 SSE 事件（复用 sse-bus，频道键 `pk:<roomId>`）

继承 sse-bus 全部机制（seq 单调去重 / since 增量回放 / 15s 心跳 / 断链回收），
但**与聊天会话频道严格隔离**（频道键前缀 `pk:`，不复用 sessionId 空间，防串台——v1 教训）。
新事件类型在 `packages/shared/src/sse-events.ts` 登记：

| type | 载荷 | 语义 |
|------|------|------|
| `pk-state` | PkRoomState | 房间状态变化（开局/结束/玩家变动） |
| `pk-question` | PkQuestion（无 answer） | 新题到达（只推给答题方视图，双方都收但 answer 已剥离） |
| `pk-verdict` | questionId/correct/delta/score | 某题判分结果（含超时判罚，双方都收） |
| `pk-end` | winner/finalState | 结算 |

服务端定时器（对局时钟、答题超时、怠慢惩罚、CD 解锁）到期时**主动 publish 对应事件**，
不依赖客户端轮询。Android 微信 X5 内核对 EventSource 支持不稳，前端加**轮询兜底**
（SSE 断开 3 次重连失败后降级为每 2s GET state）。

## 3. 出题管道（复用现有能力，加法改造）

- `prompt` 作为 topic/material 传入现有 `learning/quiz.ts → generateQuiz`，外加**PK 系统约束层**：
  ① 只出 **1 道四选一选择题**；② 与提示词主题相关；③ 输出严格 JSON（沿用 `quiz-json-repair.ts` 兜底 + 解析失败重试 1 次，再失败 502 不计 CD）。
- **提示词注入风险**（已知并接受）：出题人可写诱导性提示词。缓解：系统约束层不可被覆盖 +
  输出 JSON schema 校验（stem/options/answer 字段齐全、answer ∈ 选项）+ 出题人自己不答这道题
  （动机方向天然正确：难倒对方才得分，不需要防「出简单题」）。
- P0 用**每次请求现出**（复用 llm/router 已配置模型），不预生成题库。

## 4. 存储（P0 刻意从简）

- **P0 房间状态全内存**（模块级 `Map<roomId, Room>`）：局域网单进程 demo 足够，无战绩落库、
  无 schema 改动；进程重启即丢局（可接受，已在企划声明）。
- 房间 TTL：`finished`/`waiting` 超 30 分钟回收；对局结束快照保留 10 分钟供双方回看，之后删除。
- P1 才引入 `pk_rooms`/`pk_questions`/`pk_results` 表（better-sqlite3）与战绩排行。

## 5. 前端（web 包，移动优先）

- 新增 `/pk` 路由（HashRouter），移动优先布局（≥375px 视口适配），桌面浏览器同套页面可玩（局域网 demo 不挑设备）。
- 三个页面：**大厅**（昵称→登录→建房/输码入房）→ **对局**（双栏比分条 + 自己的「出题/答题」双动作区 +
  对局时钟 + CD 倒计时，全部读服务端时间）→ **结算**（比分、正确率、胜负、回看题目）。
- 登录按钮即替换 `App.tsx:189-198` 现有「微信登录」展示占位（该占位本就为此预留），登录态存
  localStorage（userId/nickname），失效自动重登。
- UI 规范照旧：极简浅色、禁 emoji、SVG line-icon；**这是正式功能不是教学 demo，不做装饰性特效**。

## 6. 分阶段计划（一批一主题，不一把梭）

| 阶段 | 内容 | 验收 |
|------|------|------|
| P0-1 | shared 登记 `pk.ts` 类型 + `/api/pk/auth/login`（模拟）+ 建房/入房/start + SSE `pk:` 频道 | 单测：建房/入房/满员/隔离；curl 双端登录互通 |
| P0-2 | 出题端点（CD+AI 管道）+ 答题端点（判分+超时定时器+怠慢惩罚）+ 对局时钟与结算 | 单测覆盖计分全表（§1 每行一条）+ 超时/怠慢用 fake timer |
| P0-3 | 前端三页面 + App.tsx 占位接入 + 轮询兜底 | **真机端到端**：两台手机同 WiFi 微信内打开，完整打完一局（QUIZ-IMAGE-SPEC 教训：单测全绿≠落地，必须真机跑通） |
| P1 | 公网部署（HTTPS 域名）→ 微信公众号网页授权替换模拟登录 → 战绩落库/排行 → 题型拓展（判断/简答+verdict.ts 判分） | 真机微信授权回流测试 |

## 7. 可行性与难度评估（老板自定义问题，2026-09-09 答）

**结论：能行。P0 难度 = 中低（2~3 个工作阶段可落地），P1 难度 = 中。**

- **为什么不难**：出题（quiz.ts+json-repair）、实时推送（sse-bus）、判分（选择题字符串比对）、
  存储（内存 Map）四块全是**复用现有已验证能力**，PK 本身只是新增一个状态机（房间→对局→结算）+
  一组薄路由 + 三个页面。没有需要攻关的新技术。
- **真正的硬点按序**：① **P1 微信授权资质**——个人主体申请不到已认证服务号，需借用主体或走
  微信开放平台（这是企划能否走到「真微信」的瓶颈，代码反而不是）；② **P1 公网部署**——HTTPS+
  域名是微信网页授权的前置条件，内网穿透只够开发调试；③ **微信内置浏览器兼容**——X5 内核 SSE
  不稳（已备轮询兜底）；④ 提示词注入（§3 已缓解，朋友间对战剩余风险可接受）。
- **玩法可行性自检**：计分闭环无死锁（双方 CD 内仍可答题，怠慢惩罚防摆烂，超时惩罚防拖局）；
  8 分钟局 + 60s 出题 CD ≈ 每人最多出 7 题，节奏成立。
