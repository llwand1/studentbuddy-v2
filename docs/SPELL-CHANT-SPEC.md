# 魔法吟唱（Spell Chant）——对话核 × 知识大陆

> 版本：v0.1 | 状态：[活跃] | 新建：2026-09-28（issue #85，分支 `feat/spell-chant`）
>
> 本册管的是知识大陆里的一个**技能位**：把「对话核」产出的历史对话当作**咒语**，在打怪弹窗里对指定怪物**吟唱并释放**。
> 它是 `docs/KNOWLEDGE-CONTINENT-SPEC.md` 的子契约：地图、怪、血量、收复路径全部沿用那册的口径，本册**只加一种打法**。

## 1. 为什么要有它

- 对话核与知识大陆之间此前只有**数据连接**（对话里沉淀的词条铺成地块），没有**玩法连接**。一段对话结束后，它在地图上没有任何存在感。
- 学习者投入最多的地方是对话（从一个感兴趣的问题出发，一轮轮问答 + AI 出的题卡），但历史对话只会被翻阅，**不会被重新打开、重新复述**——与已下线的知识图同型：写侧持续付成本、读侧近零访问。
- 魔法吟唱把每一段对话变成一件**能在地图上使用的东西**：要用它，就得把当初的提问再说一遍、把当初的题再做一遍。技能的威力由这些学习行为解释。

## 2. 概念映射

| 游戏里叫什么 | 它其实是什么 | 来源 |
| --- | --- | --- |
| **咒语** | 一个会话（一段历史对话） | 既有 `GET /api/sessions` |
| **咒语书** | 本账号的会话列表 | 同上 |
| **一节（verse）· 复述提问** | 对话里的一轮：用户提问 + AI 回答 | 既有 `GET /api/sessions/:id/messages` → `foldToolRounds` |
| **一节（verse）· 重做题目** | 对话里 AI 出过的题卡上的一道题 | 同上（`[QUIZ]` 登记行还原） |
| **回响** | 该轮 AI 回答的前 `SPELL_ECHO_CHARS` 字（去掉标记与围栏） | 派生 |
| **共鸣** | 咒语正文里出现了这块地的词条名 | 派生 |
| **威力 / 伤害** | 命中的节数 ×（共鸣 ? 2 : 1） | 派生 |

★ **全部是派生量**：没有一张新表、没有一条迁移、没有一个新 REST 路由。吟唱过程**不落库**，关掉弹窗就没了。

## 3. 行为

### 3.1 入口（`MonsterDialog`）

- 打怪弹窗底栏多一个「魔法吟唱」按钮，与「提交」并列。
- **一只怪一次开打只能吟唱一次**：释放过（含哑火）或**中途中断**，按钮即置灰为「吟唱已用」并留一句话说明；合上咒语书（还没选）不算用掉。关掉弹窗再开算新的一次开打。
- 吟唱期间弹窗内的常规答题不可操作（同一时刻只有一个对话框在前）。

### 3.2 咒语书（`SpellBook`）

- 打开即拉 `api.sessions.list()`；列表按服务端次序（置顶优先、最近更新在前）。
- 点一本 → 拉 `api.sessions.messages(id)` → `planSpell(rows, term)`（`spell-chant-view.ts`）：
  - `foldToolRounds` 折成消息流 → `buildChantVerses` 切成节；
  - **0 节**（没有文字提问、也没有可判分的题卡）⇒ 就地说「这本咒语是空的」，**不进入吟唱**、不消耗吟唱机会；
  - 节数超过 `SPELL_MAX_VERSES = 8` ⇒ 只取**前 8 节**并如实提示「咒语太长，只吟唱前 8 节」。
- 取数失败原样念出错误（ADR-5 禁静默），可重试。

### 3.3 吟唱（`SpellChant`）——逐节推进

**复述提问**（recall）
- 屏上有两样东西：① **回响**——该轮 AI 回答的摘录；② **遮罩后的原提问**——`maskPrompt(prompt, seed)` 按稳定哈希露出约三分之一的字符（首字必露、标点与空白原样保留），其余以 `＿` 遮住。
- 学习者输入一句提示词，相似度实时显示（`promptSimilarity`：NFKC / 去空白与标点 / 小写后的**字符二元组多重集 Dice 系数**，`[0, 1]`）。
- 相似度 ≥ `resonanceThreshold(原提问归一后的长度)` ⇒ **共鸣**，该节命中（`hit`）；唯一入口是 `resonates(prompt, attempt)`，组件不自己比数。阈值随原提问长度线性递减：长度 ≤ 20 字为 `0.6`，≥ 60 字为 `0.4`，中间线性——长句本来就不可能逐字复述，阈值不降就是把人卡死。
- 允许「跳过这一节」⇒ 该节失谐（`miss`）、威力 0。不许跳过会造出死路（想不起来就永远出不去）。

**重做题目**（quiz）
- 只收**可客观判分**的题（`chantable`）：`single` / `multiple` / `judge` / `fill` 且答案形状完整（选择题下标在选项内、填空有答案）；`essay` 不进吟唱（没有机器可判的对错）。每张题卡最多取前 `SPELL_MAX_QUIZ_PER_CARD = 3` 题。
- 判分复用对话页题卡同一份口径（`features/quiz/quiz-attempt.ts` 的 `reviewAttempt`，`verdict === 'correct'` 才算对）——**不另写第二份判分**。
- **一次作答**：对 ⇒ `hit`；错 ⇒ `miss`，亮出正确答案后进入下一节。与打怪常规题「答错可重试」刻意不同：吟唱是**回忆练习**，看过答案再答一遍不叫回忆。

**进度**：每节一枚符文；命中亮金、失谐暗色、当前节红色脉动、未到的空框。

### 3.4 释放

- 全部节走完 ⇒ 出现「释放咒语（N 点）」（一节没中则是「释放（哑火）」）。点下去播放释放特效（法阵加速旋转 + 三圈错相扩散环 + 金色闪光 + 伤害数字，`SPELL_CAST_MS = 1100`；`prefers-reduced-motion` 下不播、直接显示结果）。结算文案念出「N 节里命中 M 节（共鸣加倍）：造成 D 点伤害」，点「回到战斗」才把伤害交回打怪弹窗。
- **伤害** = `spellDamage(power, resonant)` = `power × (resonant ? SPELL_RESONANCE_MULTIPLIER : 1)`，其中 `power = chantPower(results)` = 命中节数，`resonant = spellResonates(会话全部消息正文, 词条名)`。
- 回到打怪弹窗：
  - `damage ≥ 剩余血量` ⇒ **收复**，走既有 `onSolved(tile, 'spell')` → `api.terms.mark(id, true)`（与常规答完一字不差的写口）；
  - `0 < damage < 剩余血量` ⇒ 扣 `damage` 滴血＝**跳过同样数量的题**（「题数＝血量」的口径不破），剩下的血仍靠常规答题打掉；
  - `damage = 0` ⇒ **哑火**：不扣血，但这一次吟唱机会已用掉。
- 地图击杀特效：吟唱收复时 `burst` 带 `spell: true`（`ContinentBurst`），`drawBurst(ctx, t, age, spell)` 画**三圈错相扩散环 + 十六粒火星 + 旋转符印**（亮金 `COLOR.spell`），时长仍受 `BURST_MS` 约束；普通收复不变。

## 4. 数值由学习行为解释（本仓纪律）

- **威力 = 命中节数**：复述一次提问 = 一次主动回忆（要把当初的问题从记忆里取出来，而不是重读一遍）；重做一题 = 一次检索练习。跳过 / 答错 = 0，没有空转的数值。
- **共鸣 ×2**：咒语正文提到这块地的词条 ⇒ 这次回顾对该词条是**直接复习**，强度更高。
- ★ **代价如实登记**：当 `power ≥ 剩余血量` 且咒语与这块地**不共鸣**时，被收复的词条本身可能一题都没答。这是玩法取舍——换来的是「一段历史对话被重新打开、逐节复述」这件比一道本地填空题**更重**的学习行为；且共鸣加成让"选一段相关的对话"始终是更优解。本册**不做**开关，把这条写在这里就是为了让它可被质疑。

## 5. 边界与不做

- 零新表、零迁移、零新 REST 路由；不落任何吟唱记录（要"吟唱次数统计"就得建账，另立改动）。
- 相似度是**本地纯函数**，不调用模型、不发请求；不宣称语义判分。
- 不改对话核任何一行；不改题卡的判分口径（复用）。
- 不做咒语稀有度 / 等级 / 冷却 / 跨怪叠加；不做失败惩罚。
- 图片提问（无文字）、空提问、`essay` 题、情景题（`[SCENARIO]`）不进吟唱。
- 「一只怪一次开打只能吟唱一次」的计数是**弹窗内存态**，关掉重开会重置——如实登记为已知边界。

## 6. 代码落点

| 层 | 文件 | 放什么 |
| --- | --- | --- |
| shared | `packages/shared/src/spell-chant.ts` | 常量、`ChantTurn`/`ChantVerse`/`ChantPlan` 类型、`chantable`、`buildChantVerses`、`echoOf`、`promptSimilarity`、`resonanceThreshold`、`resonates`、`maskPrompt`、`spellResonates`、`chantPower`、`spellDamage`（**纯函数，零随机零时钟**） |
| web | `features/continent/spell-chant-view.ts` | 历史行 → 节（借 `chat/history-fold`）、`planSpell`、`spellTimeText`、文案（`verseTitle` / `truncatedText` / `castText`） |
| web | `features/continent/SpellBook.tsx` | 咒语书（会话列表 + 取数） |
| web | `features/continent/SpellChant.tsx` + `SpellQuizVerse.tsx` | 吟唱对话框（复述节 / 题目节 / 释放） |
| web | `features/continent/spell-chant.css` | 特效（只动 `transform` / `opacity`，`steps()`，reduced-motion 逐条降级） |
| web | `MonsterDialog.tsx` / `ContinentPage.tsx` / `continent-view.ts` / `ContinentMap.tsx` / `continent-canvas.ts` | 技能按钮与伤害结算（`SolveVia`，`onSolved(tile, 'spell')`；常规答完仍不传第二参）/ `solve(tile, via)` → `burst.spell` / `ContinentBurst` 类型 / 吟唱击杀特效 |

## 7. 验证

- 单测：`packages/shared/src/spell-chant.test.ts`（纯函数口径）、`features/continent/spell-chant-view.test.ts`（历史行切节与共鸣）、`SpellChant.test.tsx`（复述通过/不通过/跳过、题目对/错、释放伤害与共鸣倍率）、`SpellBook.test.tsx`（列表 / 空咒语 / 选中）、`MonsterDialog.test.tsx`（技能按钮、扣血、吟唱收复走 `onSolved(tile,'spell')`、一次开打只一次）。
- ★ **浏览器实跑（headless Chromium，2026-09-28）**：对着真 dev server（`SB_DATA_DIR` 隔离库）＋ vite 页面走完整条链——SQL 灌入 3 段会话（其中一段带 `[QUIZ]` 题卡、一段只有图片提问）与 3 只逾期怪 ⇒ 点怪开弹窗 → 「魔法吟唱」→ 咒语书三本按更新时间排列（「只有一张图」被判空咒语、置灰不进吟唱）→ 「闭包到底是什么」切成 6 节（3 复述 + 3 题，`essay` 被剔除）→ 复述相似度 73% ≥ 60% 放行、故意答错判断题得一节失谐 → 「释放咒语（10 点）」= 5 命中 × 共鸣 2 → 3 血的怪被收复，页面横幅「咒语命中，收复了「闭包」」，`terms.mark` 真的写了库（再开地图怪已消失、地上留箱）；canvas 在释放后 200ms 的帧上能看到咒语版 burst（方环 + 火花 + 旋转符印）。截图：`docs/images/spell-chant-book.png` / `spell-chant-recall.png` / `spell-chant-cast.png` / `spell-chant-map-burst.png`。
- ⚠️ **仍未做的**：真实设备与多浏览器（只跑了 headless Chromium）、`prefers-reduced-motion` 下的画面（只在 jsdom 里锁了「跳过释放阶段」）、canvas 特效的**几何断言**（本次只是目检截图，没有像 `tools/probes/continent-cdp.mjs` 那样量像素质心）。`ContinentPage` 里 `via='spell'` → `burst.spell` 那一行接线没有页面级用例（`ContinentPage.test.tsx` 已贴近 300 行红线），由类型（`SolveVia`）、`MonsterDialog.test.tsx` 的 `onSolved(tile,'spell')` 断言与上面那次浏览器实跑兜住。

## 8. 画面

| 咒语书 | 复述一节 |
| --- | --- |
| ![咒语书](images/spell-chant-book.png) | ![复述](images/spell-chant-recall.png) |

| 释放 | 地图上的咒语版 burst |
| --- | --- |
| ![释放](images/spell-chant-cast.png) | ![burst](images/spell-chant-map-burst.png) |
