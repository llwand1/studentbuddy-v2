# 等待时刷词（Wait Drill）

> v0.2.178：收录/斩词使用独立反馈；收录等待、防重复、失败重试与迟到结果隔离见 [DRILL-ACTIONS-SPEC.md](DRILL-ACTIONS-SPEC.md)。

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
| 不在对话页（`active=false`）或设置关掉自动弹 | 不自动弹；`sb:drill-open` 事件（等待气泡「刷词」/ 设置「现在试一局」/ 输入框上方的「唤回」小签）仍能开——**练习局**没有"回复到了"可切，关掉靠自己 |

### 2.1 收起 ≠ 结束：能唤回（2026-09-30）

用户的原话：回复等待时的百词斩应该能**唤回来**。此前 ✕ / Esc / 回复到了自动切回 = 整局作废，想接着刷只能等下一轮或去设置页重开一局。
现在「这一局在跑」（`WaitDrill` 的 `alive`）与「小窗看得见」（`trigger.open`）是两件事：

| 动作 | 小窗 | 这一局 |
|---|---|---|
| ✕ / Esc / 回复到了自动切回 / 「现在回去」 | 收起 | **留着**：队列、当前这张、连击、本局战绩原样在宿主里 |
| 输入框上方小签「刷词已收起 · 还有 N 张 · 唤回」（`DrillParkedPill`，发 `sb:drill-open`） | 回来 | 同一局接着答（同一张卡、战绩不清、词库不重取） |
| 下一轮等待自动弹 | 回来 | 同一局；换了正在等的会话只是**再要一批新词插进队列**（新词跟着话题走），不重开局 |
| 小签 ✕（`sb:drill-end`） | — | **结束**：下一次打开是新一局（词库重取、本局战绩归零；当天战绩已落本机，不受影响） |
| 切到别的页 | 小签随对话页卸载 | 留着（`WaitDrill` 常驻 App 壳层） |

- 跨组件靠 `drill-dock.ts` 的模块级 store（`useSyncExternalStore`）：宿主写 `{parked, queueLeft, correct, combo}`，小签读；`ChatView` 贴着行数红线，不穿 props。
- 小签只在 parked 时渲染，长在 `ChatComposer` 输入框上方那排状态条里（与「追问模式」条同位——动作可折叠、状态不能藏）；它不是常驻入口。
- 没在等回复时 `openNow` **沿用上一次的 `openSession`**（换 id 等于换话题，会再要新词）；在等回复时照旧记当前会话。
- `useDrillSession` 的开局效果只随 `open`（＝alive）与日历日重跑；要新词的效果单独随 `sessionId` 重跑。
- 拼写卡打到一半的字（`draft`）也住在 `useDrillSession` 里而不是卡组件里：小窗卸载再唤回，格子里的字原样在（真机验出——放在组件 state 里会随卸载丢掉）；翻到下一张才清空。

### 2.2 出题中也算等待（2026-10-01，契约 `POMODORO-SPEC.md` §8）

`use-quiz-actions` 把「哪间会话正在出题」写进 `drill/quiz-wait` store，App 把它与 `localBusySid` 并成一个 `busySessionId` 喂给 `WaitDrill`——上表一字不改。出题等待条上另给「刷词」入口（同 `sb:drill-open`）。另：番茄钟工作段里 `orderDrillQueue` 让方向内领域的词条在两段各自内部排前（`POMODORO-SPEC` §5.3）。

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

### 5.1 小窗（`DrillOverlay`）

`role=dialog` **非模态**小窗（v1 是全屏遮罩模态，2026-09-30 资料溯源批次改成可拖动浮窗，见 §5.6）：外层 `.drill-overlay` 透明且
`pointer-events: none`，560px 舞台 `.drill-stage` 绝对定位、位置由 `--drill-x/--drill-y` 决定；黑铁框双金线（与大陆弹窗同 `grimoire.css` 语言，只用 `--gr-*` / `--sb-*`）。
头部：品牌角标 + 「AI 正在回复… / 回复到了」+ 战绩（连击 / 答对 / 斩 / 打卡）+ 音效钮 + ✕；横幅（§2）；卡 + 特效层；状态行（打卡通知 / 新词来源）；键位脚注 + 「还有 N 张」。

### 5.2 卡（`DrillQuestion`）

- 芯片：题型 /「到期 · 答对即打卡」/「新词 · AI 现出 | 内置词池」。
- 四选一两列大按钮，键位牌在左；答完正确项绿亮、选错的红亮、其余压暗；对照面写「对了 / 错了 / 记一下 / 斩！今天不再出这条」+ 词条——释义。
- 拼写（2026-09-30 起是**打字练习式**，通用控件 `components/TypingInput.tsx`，口径 `@sb/shared/typing`）：
  - **一格一字**：答案铺成格子，字母 / 数字 / 汉字（Unicode `L`/`N`/`M`）是要打的格；空格断词、标点符号是**替你填好的固定格**，
    键入的符号直接丢（`clampTyped`）——用户不用打符号。提交的仍是带符号的完整答案（`mergeTyped`），`gradeDrill` 判分口径一字未改。
  - **分段提示**：词内汉字 2 字一段、字母数字 3 字一段（字母词尾段 1 字并入前段；汉字不并——三字词第一次提示只给两个字），「提示 k/n」一次揭一段——未打的格里显灰斜体字，
    仍要自己打进去（打字练习的规矩，不是替你填）；换题归零。提示不扣分（这是练习，不是考试）。
  - **逐格即时对错**（`liveCheck`，只在刷词开）：打对绿、打错红，不分大小写；光标格 `steps()` 闪烁，减少动态下不闪。
  - 一个真输入框（视觉隐藏、可聚焦）接键盘与输入法：组字期间不回写（否则拼音字母会先落格再被汉字替换、还可能截断组字）；
    点格子 = 聚焦它；回车提交（组字中的回车不算）。
  - **尽量不出带符号的拼写**：轮到拼写但词条不适合逐格打（`spellFriendly`：可打字符 < 70% 或 > 24 格，如 `C++`、`O(n log n)`）
    ⇒ `buildDrillCard` 改出「看词选义」；连选择题也出不了才照旧拼写（符号格替他填好）。
  - 同一控件也用在知识大陆填空题（`ContinentQuestionForm`，不开 liveCheck——正经考题逐格对错等于把答案试出来）与对话出题的填空
    （`quiz/FillBlank.tsx`：参考答案适合逐格才用格子、可切「自由输入」回普通框，整句 / 满是符号 / 没参考答案走普通框）。
    出题协议同步要求 fill 的每空只写要填的词或短语本身（≤12 字、不带标点单位）。
- 新词学习屏：词条 + 释义 + 来源句（AI：「跟着你正在聊的话题出的」；词池：兜底原因）+「记住了，来一题」。

### 5.3 特效（`DrillFx` + `drill-fx.css`）

答对按次数轮换五款：**斩击**（两道白刃斜切）→ **爆裂**（12 粒方块四散）→ **星芒**（四角星 + 冲击环）→ **电光**（锯齿闪电 + 蓝闪）→ **血墨**（墨点炸开 + 三滴飞溅）；
答错 **碎裂**（红裂纹 + 卡片抖动）；连击 5 的倍数叠 「COMBO ×N」大字。
裂纹 / 闪电是 `viewBox 100×100` + `preserveAspectRatio=none` 拉满整张卡的 SVG，路径标 `vector-effect=non-scaling-stroke` 保持 3–4px 线宽——否则横向会被拉粗十几像素把正确答案盖住（实拍逮到）。
口径与对话页特效层同：只用 `steps()`；只动 transform / opacity / clip-path；默认态即终态；`prefers-reduced-motion` 下全关；
粒子方向写在 `:nth-child` 规则（禁内联样式）。

### 5.4 键位（`useDrillKeys`）

`1–4` 选项 · `Enter/空格` 下一张 / 记住了 / 收入词库 · `N` 不认识 · `Z` 斩 · `X` 不要 · `Esc` 收起（§2.1）。焦点在**弹窗里的**输入框（拼写卡）时字母数字不劫持（Esc 照收）。
焦点规则：发送完消息焦点还留在聊天输入框，所以 **打开时把焦点挪进舞台**（`.drill-stage[tabindex=-1]`），直接按数字就能答。
★ §5.6 之后小窗是非模态：焦点在**小窗外**的输入框 / 文本域 / contentEditable 里时，所有键（含 Esc）都归那个控件——用户点回聊天框
就是要打字，Esc 是聊天框自己的「停止生成」；小窗内的拼写输入框仍只放行 Esc。焦点在 body / 小窗里时按键照归小窗并 `preventDefault`（数字不会打进输入框）。
脚注按卡换词：拼写卡「逐字打词条 Enter 提交…」、学新词屏「Enter 记住了来一题」；练习局（没在等回复）头部写「练习局」而不是「回复到了」。

### 5.5 音频（`DrillAudio`）

全部 Web Audio 现场合成（零音频文件）：A 小调 132 BPM 8 小节循环（三角波低音 + 方波旋律 + 琶音 + 合成鼓），前瞻调度不怕失焦乱拍；
七款音效 correct / wrong / slash / flip / combo / new / ready。弹窗开 `start()`、关 `stop()`（挂起上下文）、卸载 `dispose()`。
静音 = 主增益归零（不停调度，切回还在拍上）；自动播放策略被拒时静默，首个点击再 `resume()`。

### 5.6 可拖动小窗（`useDragWindow`，2026-09-30）

为什么：右侧现在常驻「资料架」（`SOURCE-TRACE-SPEC.md`），刷词若还是居中模态就把资料挡个正着。用户拍板：**刷词变成可拖动的小窗**
（想看资料就拖到左边 / 中间），资料架固定右侧——两个同时开着互不遮挡，对话区也照常可点。

| 事项 | 口径 |
|---|---|
| 拖柄 | 头部 `.drill-head`（`cursor: grab`，拖动中 `grabbing`；`touch-action: none`）；头部里的按钮 / 链接 / 输入框按下不算拖 |
| 位置 | 写在 `.drill-stage` 的 CSS 变量 `--drill-x/--drill-y`（`transform: translate(...)`），不走 React state（每帧 setState 会带着整张卡重渲），也不是内联 style（仓规） |
| 限位 | `clampWindowPos`：窗至少留 `MIN_VISIBLE`（64px）在视口内、顶边不越出（头部要一直够得着）；窗口 resize 重新夹 |
| 首次位置 | 没有记忆时 `centeredPos` 居中（顶部至少留 12px）；`useLayoutEffect` 首帧就写上，不会先画在左上角再跳 |
| 记忆 | 松手 `onSettle(pos)` ⇒ `saveDrillPrefs({ pos })`，下次原地出现；`drill-prefs.pos` 只在两数都有限时才读 |
| 开场动效 | 专用 `drill-pop` 关键帧（translate + scale）——不能用 `sb-pop`：它只写 scale，会在 200ms 里盖掉 translate 让窗闪到左上角 |
| 窄屏 ≤640px | CSS 退回**底部抽屉**（`position: fixed; bottom: 0; transform: none !important`），JS 侧 `matchMedia` 命中也不进入拖动（否则抽屉上划两下会把看不见的位置写进偏好，回到宽屏窗就跑到屏幕外） |
| 无障碍 | 仍是 `role=dialog`，但**不再** `aria-modal`（对话区本来就能操作）；头部 `title=「按住这里拖动小窗」` |

## 6. 偏好与本机战绩（`drill-prefs.ts`，`localStorage`）

- `sb:drill:prefs` `{enabled, sound, pos?}` 默认全开（`pos` 是小窗记忆位置，§5.6）；设置页「等待时刷词」卡与弹窗音效钮都改它，改了广播 `sb:drill-prefs`，常驻的 `WaitDrill` 跟着刷新。
- `sb:drill:stats` `{day, slain[], correct, bestCombo, reviewed}` 按日历日记，换天归零；斩过的 id 只管当天。
- 为什么放本机：要不要弹、要不要出声、今天斩了几个都是这台设备的事；坏 JSON / 隐私模式一律退默认值不抛。

## 7. 测试

| 文件 | 锁什么 |
|---|---|
| `shared/src/drill.test.ts` | 题型节拍、干扰项纪律、判分、队列到期优先且当天恒同、插回位置 |
| `server/src/routes/drill.test.ts` | 词池兜底如实标、pending 先消化 + 不够补齐、keep 幂等 / 400 / 404、dismiss 留行 + 409、候选解析 |
| `shared/src/typing.test.ts` | 打字格口径：谁要打谁固定、分段规则、`mergeTyped` 放回符号、`clampTyped` 丢符号、逐格对错、`spellFriendly` 门槛 |
| `web/…/components/TypingInput.test.tsx` | 铺格 / 符号不落格 / 分段提示灰字与用完停用 / liveCheck 才判对错 / 输入法组字不回写 / 回车提交 / 点格聚焦 / 禁用无提示 |
| `web/…/quiz/FillBlank.test.tsx` | 短答案用格子 + 「自由输入」切回并清空；整句 / 满符号 / 无参考走普通框；两种框回车都提交 |
| `web/…/drill/useDrillTrigger.test.ts` | 2 秒才弹 / 秒回不弹 / replyReady / 关掉本轮不弹 / openNow / 唤回沿用 openSession |
| `web/…/drill/drill-audio.test.ts` | 调度器起停幂等、静音是增益归零、七款音效、无 AudioContext 静默 |
| `web/…/drill/drill-prefs.test.ts` | 默认值 / 广播 / 跨天归零 / 坏 JSON |
| `web/…/drill/WaitDrill.test.tsx` | 弹与回全链：到期答对 mark、回复到了答完切回、8 秒兜底、继续刷、Esc、设置关、焦点进小窗 / 非模态后点回聊天框按键归聊天框 / 关掉焦点还回、拖动改写 `--drill-x/y` + 写偏好 + 头部按钮不算拖 |
| `web/…/drill/useDragWindow.test.ts` | 限位（左右各留 64px、顶边不越出、极窄视口不出负上限）、居中顶部留 12px、窄屏断点常量 |
| `web/…/drill/WaitDrill.cards.test.tsx` | 键盘作答、答错插回、斩、五款特效轮换 + COMBO、拼写、AI 新词 keep、词池兜底 + dismiss、词库取不到如实报 |
| `web/…/drill/WaitDrill.recall.test.tsx` | 收起 ≠ 结束：Esc 收起 ⇒ dock parked、唤回同一张卡 / 战绩在 / 词库不重取；自动切回也是收起、下一轮同一局 + 换会话只补新词；小签 ✕ 才结束再开新局；小签渲染与两枚事件 |
| `web/…/settings/WaitDrillCard.test.tsx` | 开关点选即存 + 广播、试一局事件 |

## 8. 风险与后续

- 小窗非模态（§5.6），✕ / Esc 是收起不是结束（§2.1）：想彻底关掉要点小签上的 ✕——多一步，但"关了就作废"是用户明确不要的。
- 打字格会暴露答案长度与符号位置：这是打字练习式填空的代价（用户选的口径）；正经考题不开逐格对错，对话填空可切「自由输入」。
- 新词依赖模型质量：只收成形条目（`parseDrillCandidates`），超长 / 缺字段整条丢；仍可能出偏门词，靠「不要」闸门兜。
- `term-names.ts` 与 PR #111 的 `continent-expand.ts` 各有一份「用户已有名字」；两边合入后把大陆那份改为 import 这里。
