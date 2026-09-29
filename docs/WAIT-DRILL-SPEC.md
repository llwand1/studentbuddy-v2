# 等待时刷词（Wait Drill）

状态：v1（issue #120）。发出问题后 AI 还在想的那段空档，弹一张百词斩式词卡让你刷；回复到了答完这张自动切回。

## 1. 目标与不做

- **目标**：把「等回复」的垃圾时间变成刷词——词来自你自己的词库（到期优先），AI 顺着当前话题现出库里没有的新词；
  手感照百词斩（点了就判、键盘一把梭）、有配乐音效、答对有多款特效。
- **不做**：不做独立的「刷词页」（它只是等待的伴生态，入口在等待气泡与设置卡）；不发奖励、不写任何刷词账本到服务端
  （避免"刷词白拿钥匙"）；不把「斩」当成永久掌握（那是复习引擎的事）。
- **口径由用户拍板（2026-09-29）**：① 只在回复超过 2 秒时弹；② 范围内到期词条答对 = 一次真复习打卡，其余只记战绩；
  ③ AI 新词是候选，必须点「收入词库」；④ 题型 = 词→义 + 义→词 + 拼写。

## 2. 触发：什么时候弹、什么时候回（`useDrillTrigger`）

输入只有一个信号 `busySessionId`（App 已有的"当前挂载的会话在不在流"，token 级零延迟）。

| 事件 | 行为 |
|---|---|
| `busySessionId` 空→非空（一轮开始） | 起 `DRILL_OPEN_DELAY_MS`（2000）的表；到点**还在生成** ⇒ `open`，记 `openSession`（出新词带给服务端） |
| 2 秒内回完 | 表被清掉，什么都不弹 |
| 生成中用户点 ✕ / Esc | 关闭并记住本轮序号，**本轮不再弹**；下一轮照弹 |
| 弹窗开着时 `busySessionId` 变空（回复到了） | `replyReady`：横幅「回复到了——答完这张自动切回（Ns）」+ 一声提示音 |
| `replyReady` 且当前卡答完 | 宿主 `onCardResolved` 返回 true ⇒ 关闭（不再出下一张） |
| `replyReady` 且 `READY_GRACE_S`（8）秒没答 | 也关闭（等待的意义已经没了） |
| `replyReady` 时按「继续刷」 | 横幅收起，本轮不再自动切，直到自己关 |
| `replyReady` 时按「现在回去」 | 立刻关闭 |
| 词库取不到 / 队列空时回复到了 | 立刻关闭（没在答题就不用等答完） |
| 不在对话页（`active=false`）或设置关掉自动弹 | 不自动弹；`sb:drill-open` 事件（等待气泡「刷词」/ 设置「现在试一局」）仍能开——**练习局**没有"回复到了"可切，关掉靠自己 |

## 3. 一局（`useDrillSession`）

```
loading ──取词──▶ question ──答──▶ reveal ──下一张──▶ question …
                     │                 ▲
                     └── 新词先 learn ──┘          队列空 ⇒ empty（新词到了自动续上）
```

### 3.1 词从哪来

- 开局取一次 `GET /api/terms/review/map`（全库 + 服务端现算的到期状态），按 `orderDrillQueue` 排队：
  **范围内到期/逾期在前（origin `due`）**，其余 `library`；同一日历日次序恒同（种子 `day|r轮次`），今天斩过的不进队。
- 队列刷完从头再排一轮（等待多久刷多久）；库空且新词也没有 ⇒ `empty` 如实说明。

### 3.2 题型节拍（`drillKindAt`）

每 4 张：3 张四选一里恰 1 张「看义选词」（落点按种子哈希）+ 固定 1 张拼写（第 4 张）。新词一律先学一屏再出「看词选义」。
四选一干扰项（`pickDistractors`）：同领域优先、与正确答案同名或同释义的不当干扰、库不够 3 个从冷启动词池补。

### 3.3 判分与三种账

| origin | 答对 | 答错 / 不认识 | 斩（Z） |
|---|---|---|---|
| `due` | `POST /api/terms/:id/review {remembered:true}`（怪消失，通知说清）+ 战绩 | 隔 `DRILL_REQUEUE_GAP`（3）张再来，连击归零 | 今天不再出（本机记 id），不碰打卡 |
| `library` | 只记战绩 | 同上 | 同上 |
| `new` | 问「收入词库 / 不要」 | **也问**「收入词库 / 不要」（答错的词恰恰最想留） | 没有斩（还不在库里） |

判分走 `gradeDrill`：选择题比下标；拼写比归一化文本（大小写 / 空白 / 全半角同大陆口径），别名也算对。
答对的普通卡 `DRILL_ADVANCE_MS`（750）后自动翻下一张；答错停在对照面等 Enter；新词永不自动翻（等用户决定）。

### 3.4 新词（AI 实时出 + 候选闸门）

- 开局同时 `POST /api/drill/new-terms {sessionId}`；到了就插队：第一条排成**下一张**，之后每隔 4 张一条。
- 服务端先消化词池候选表里 `pending` 的（去掉已在库里的名字），不够 `DRILL_NEW_TERMS`（3）条再补：
  有模型 ⇒ `drill.newterms` 用途（按会话最近几句话出 3 条库里没有的词，写入 `term_pool_candidate` pending）；
  没模型 / 模型失手 ⇒ 内置词池，`source:'fallback'` + `fallbackReason` 如实标（卡面「内置词池」+ 原因句）。
- 「收入词库」⇒ `POST /api/drill/keep`：候选按表里那行落库并翻 `approved`（幂等）；词池条目按 body 落库。
- 「不要」⇒ 候选 `POST /api/drill/dismiss` 翻 `rejected`（留行，以后不再出）；词池条目不发请求。

## 4. REST（前缀 `/api/drill`，路由 `routes/drill.ts`，域 `learning/drill.ts`）

| 方法 | 路径 | body | 返回 | 说明 |
|---|---|---|---|---|
| POST | `/new-terms` | `{sessionId?, want?}` | `DrillNewTermsResult{mode:'pending'|'ai'|'fallback'|'empty', items[], fallbackReason?}` | 永不 5xx；`sessionId` 越权按无会话处理 |
| POST | `/keep` | `{candidateId}` 或 `{term, definition, domain?}` | `DrillKeepResult{termId, term, candidateApproved}` | 候选不存在 404；缺字段 400 |
| POST | `/dismiss` | `{candidateId}` | `{ok:true}` | 缺 id 400、不存在 404、已决 409 |

题面与判分不过网络（`@sb/shared/drill`），刷词不发奖励 ⇒ 前端判分没有"白拿"面。

## 5. UI

### 5.1 弹窗（`DrillOverlay`）

`role=dialog` 全屏遮罩 + 640px 舞台，黑铁框双金线（与大陆弹窗同 `grimoire.css` 语言，只用 `--gr-*` / `--sb-*`）。
头部：品牌角标 + 「AI 正在回复… / 回复到了」+ 战绩（连击 / 答对 / 斩 / 打卡）+ 音效钮 + ✕；横幅（§2）；卡 + 特效层；状态行（打卡通知 / 新词来源）；键位脚注 + 「还有 N 张」。

### 5.2 卡（`DrillQuestion`）

- 芯片：题型 /「到期 · 答对即打卡」/「新词 · AI 现出 | 内置词池」。
- 四选一两列大按钮，键位牌在左；答完正确项绿亮、选错的红亮、其余压暗；对照面写「对了 / 错了 / 记一下 / 斩！今天不再出这条」+ 词条——释义。
- 拼写：首字提示 + 输入框（自动聚焦）+ 回车提交。
- 新词学习屏：词条 + 释义 + 来源句（AI：「跟着你正在聊的话题出的」；词池：兜底原因）+「记住了，来一题」。

### 5.3 特效（`DrillFx` + `drill-fx.css`）

答对按次数轮换五款：**斩击**（两道白刃斜切）→ **爆裂**（12 粒方块四散）→ **星芒**（四角星 + 冲击环）→ **电光**（锯齿闪电 + 蓝闪）→ **血墨**（墨点炸开 + 三滴飞溅）；
答错 **碎裂**（红裂纹 + 卡片抖动）；连击 5 的倍数叠 「COMBO ×N」大字。
裂纹 / 闪电是 `viewBox 100×100` + `preserveAspectRatio=none` 拉满整张卡的 SVG，路径标 `vector-effect=non-scaling-stroke` 保持 3–4px 线宽——否则横向会被拉粗十几像素把正确答案盖住（实拍逮到）。
口径与对话页特效层同：只用 `steps()`；只动 transform / opacity / clip-path；默认态即终态；`prefers-reduced-motion` 下全关；
粒子方向写在 `:nth-child` 规则（禁内联样式）。

### 5.4 键位（`useDrillKeys`）

`1–4` 选项 · `Enter/空格` 下一张 / 记住了 / 收入词库 · `N` 不认识 · `Z` 斩 · `X` 不要 · `Esc` 关闭。焦点在**弹窗里的**输入框（拼写卡）时字母数字不劫持（Esc 照关）。
焦点规则（真机实拍逮到的坑）：发送完消息焦点还留在聊天输入框——弹窗是模态，所以 **打开时把焦点挪进舞台**（`.drill-stage[tabindex=-1]`），弹窗外的输入框不算「在打字」，按键照归弹窗并 `preventDefault`（数字不会被打进聊天框）；**关掉时焦点还回去**（回复到了正好接着打字）。
脚注按卡换词：拼写卡「输入词条 Enter 提交…」、学新词屏「Enter 记住了来一题」；练习局（没在等回复）头部写「练习局」而不是「回复到了」。

### 5.5 音频（`DrillAudio`）

全部 Web Audio 现场合成（零音频文件）：A 小调 132 BPM 8 小节循环（三角波低音 + 方波旋律 + 琶音 + 合成鼓），前瞻调度不怕失焦乱拍；
七款音效 correct / wrong / slash / flip / combo / new / ready。弹窗开 `start()`、关 `stop()`（挂起上下文）、卸载 `dispose()`。
静音 = 主增益归零（不停调度，切回还在拍上）；自动播放策略被拒时静默，首个点击再 `resume()`。

## 6. 偏好与本机战绩（`drill-prefs.ts`，`localStorage`）

- `sb:drill:prefs` `{enabled, sound}` 默认全开；设置页「等待时刷词」卡与弹窗音效钮都改它，改了广播 `sb:drill-prefs`，常驻的 `WaitDrill` 跟着刷新。
- `sb:drill:stats` `{day, slain[], correct, bestCombo, reviewed}` 按日历日记，换天归零；斩过的 id 只管当天。
- 为什么放本机：要不要弹、要不要出声、今天斩了几个都是这台设备的事；坏 JSON / 隐私模式一律退默认值不抛。

## 7. 测试

| 文件 | 锁什么 |
|---|---|
| `shared/src/drill.test.ts` | 题型节拍、干扰项纪律、判分、队列到期优先且当天恒同、插回位置 |
| `server/src/routes/drill.test.ts` | 词池兜底如实标、pending 先消化 + 不够补齐、keep 幂等 / 400 / 404、dismiss 留行 + 409、候选解析 |
| `web/…/drill/useDrillTrigger.test.ts` | 2 秒才弹 / 秒回不弹 / replyReady / 关掉本轮不弹 / openNow |
| `web/…/drill/drill-audio.test.ts` | 调度器起停幂等、静音是增益归零、七款音效、无 AudioContext 静默 |
| `web/…/drill/drill-prefs.test.ts` | 默认值 / 广播 / 跨天归零 / 坏 JSON |
| `web/…/drill/WaitDrill.test.tsx` | 弹与回全链：到期答对 mark、回复到了答完切回、8 秒兜底、继续刷、Esc、设置关、焦点进弹窗 / 聊天框有焦点也能按数字 / 关掉还回、音效钮 |
| `web/…/drill/WaitDrill.cards.test.tsx` | 键盘作答、答错插回、斩、五款特效轮换 + COMBO、拼写、AI 新词 keep、词池兜底 + dismiss、词库取不到如实报 |
| `web/…/settings/WaitDrillCard.test.tsx` | 开关点选即存 + 广播、试一局事件 |

## 8. 风险与后续

- 弹窗是模态：回复期间用户不能追加输入——这是刻意的（等待时本来也没事做），✕ / Esc 一键回。
- 新词依赖模型质量：只收成形条目（`parseDrillCandidates`），超长 / 缺字段整条丢；仍可能出偏门词，靠「不要」闸门兜。
- `term-names.ts` 与 PR #111 的 `continent-expand.ts` 各有一份「用户已有名字」；两边合入后把大陆那份改为 import 这里。
