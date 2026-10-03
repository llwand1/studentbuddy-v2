# POMODORO-SPEC — 番茄钟 × 学习方向

> 版本：v0.2 | 状态：[未发版] | 更新：2026-10-02 | 分支：`feat/pomodoro-in-coach`（v0.1 `feat/pomodoro-focus` 已随 v0.2.154 上线）
>
> 代码：`packages/shared/src/pomodoro.ts`（会话形状 / 翻段 / 方向 / 提醒判定 / 偏向文案，纯函数，两端共读）／
> `packages/server/src/storage/pomodoro.ts` + `routes/pomodoro.ts`（`/api/pomodoro`）／
> `packages/server/src/chat/focus-context.ts`（对话 system 段）／
> `packages/web/src/features/pomodoro/`（store、开钟卡、胶囊旁气泡、秒钟）／
> 偏向落点：`chat/context-segments.ts`、`routes/quiz.ts`、`learning/drill.ts`、`learning/guide-facts.ts` + `guide-prompt.ts`、`shared/guide.ts`、`shared/drill.ts`。

## 1. 为什么有它（用户原话定的口径）

> 「定时并确认接下来的学习方向，比如数学半小时，那么接下来的所有功能都会偏向于数学。」

本仓的番茄钟**不是一个倒计时玩具**。它回答的是「接下来这段时间我在学什么」，然后让已有的四条主动功能一起往那边靠：

| 功能 | 没开钟 | 开着钟（工作段，方向＝「数学」） |
|---|---|---|
| 对话 | 照常 | system 多一段：回答、举例优先围绕数学；别的话题正常答、不硬扯 |
| 出题（对话里「考我」/「+」菜单） | 主题＝输入框文字或「根据当前对话」 | 缺省主题换成「数学（结合当前对话）」；自定主题前加「【数学】」 |
| 等待时刷词 | 到期在前、库内在后 | 两段**各自内部**方向内领域的词条排前；AI 出新词优先出数学的 |
| 引路灯 | 随机话题 / 追问 | 话题与追问落在数学里；开钟那刻灯自己亮，正下方直接摆一条「从这开始」 |
| 督促胶囊 | 欠账数字 | 数字前多一枚 `🍅 数学 24:59`；到点 / 休息结束在旁边冒泡；**没开钟也会提醒你去定一个** |

## 2. 三条硬口径（改码前必读）

1. **方向只在工作段生效。** 休息段不是「学数学」，所有偏向退回常态（`pomodoroFocus` 休息段返回 `null`；对话段、出题、刷词、引路灯四处读的都是它）。
2. **到点不自动翻页。** 工作段到时只是「可以休息了」：休息 / 再来一轮 / 结束由用户在气泡或卡片上点。定时器替人做决定会把一次专注变成被追着跑。所以 `pomodoroRemainingMs` 可以是 0 而 `phase` 仍是 `work`，`focus` 仍在（`leftMin = 0`）。
3. **纯派生、不记第二套账。** 完成几轮只看 `completed`，长休与否只看 `round % 4`，没有别的字段能改它们；服务端没有定时器、不替客户端翻段。

## 3. 植入点：右下角督促小窗（v0.2 改）

> v0.1 把开钟卡放在词条页复习列表里，用户纠正：番茄钟属于**右下角「今日无欠账」那个复习督促小窗**——专注统计与督促的学习可视化是同一类东西，该做到一起。

- **胶囊**（折叠态）：开着钟时数字前多 `🍅 方向 MM:SS`（§7.1）。
- **抽屉**（展开态）顶部第一区「专注番茄钟」（`PomodoroPanel`），排在「今日队列」之前——先定方向、再还账：
  - 开钟卡 `PomodoroCard`：未开钟是「学什么 · 学多久」表单（方向可敲、可点词条库已有领域芯片；25 / 30 / 45 / 60 + 自填，钳 [5, 180]）；开着钟是倒计时、轮次、已完成轮数，工作段「提前休息 / 开始休息」「再来一轮」「结束」，休息段「开始第 N 轮」「结束」。
  - 专注统计（§10）：近 7 天专注分钟折线 + 按方向汇总芯片，与督促趋势卡同一支画笔。
- 实拍（桌面抽屉 / 手机整屏）：`docs/images/pomodoro-in-coach.png`。
- 胶囊旁气泡（§7）的「去定一个」⇒ `sb:pomodoro-open` ⇒ `CoachDock` 打开抽屉（不再跳词条页）。
- 词条页复习列表**不再**有番茄钟入口。
## 4. 数据与接口

**存储**：`app_settings` 每用户一行，键 `pomodoro`，值为整份 `PomodoroSession` JSON（读不到 / 坏值 ⇒ 没开钟）。不开新表：一个人同一时刻只有一个钟，它是状态不是流水。

```ts
interface PomodoroSession {
  subject: string;        // 学习方向，≤24 字
  workMin: number;        // [5,180]
  breakMin: number;       // 缺省 5；第 4n 轮后长休 15
  round: number;          // 第几轮工作段，从 1 起
  phase: 'work' | 'break';
  phaseStartedAt: string; // ISO
  phaseEndsAt: string;    // ISO
  startedAt: string;      // ISO
  completed: number;      // 已完成的工作段数
}
```

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/pomodoro` | `{ session, focus }`；`focus` 由服务端按服务器时钟派生（工作段才有） |
| PUT | `/api/pomodoro` | body `{ session }` 整份落库；形状不对 ⇒ 400 且不写 |
| DELETE | `/api/pomodoro` | 结束 ⇒ `{ session: null, focus: null }` |

翻段算法（`nextPomodoroPhase` / `skipBreak`）只有 shared 一份：客户端算好再 PUT，服务端只归一与落库。归属：按人一行（`ownerForWrite`），A 的钟 B 看不到。

## 5. 偏向怎么落

偏向的那句话只有一份：`pomodoroBiasLine(focus)`。

- **5.1 对话**：`context-segments.ts` 多一段 `kind: 'focus'`，排在偏好段之后、记忆段之前（它讲的是回答口径，不是事实材料）；休息段 / 没开钟为空串、被统一剔除，不占窗口。
- **5.2 出题**：`routes/quiz.ts` 的 `topic` 经 `pomodoroTopic(topic, focus)`——缺省主题（空 / 「根据当前对话内容出题」/ 「综合」）换成「{方向}（结合当前对话）」；自定主题不含方向时前加「【方向】」；已含方向不重复。文档模式回退、材料校验仍用用户原话的 topic。
- **5.3 刷词（v0.2.157 起改为硬过滤）**：`learning/drill.ts` 出新词的提示词里方向句排在「他刚刚问的是」之前（方向是他定的，话题只是刚好聊到）；`shared/drill.ts` 的 `orderDrillQueue` 多一个 `focusSubject` 与 `focusMode`，取词口径收在 `web/features/drill/drill-focus.ts` 的 `buildDrillQueue`。领域是否「方向内」＝ `domainMatchesFocus`（大小写不敏感、互相包含即算：「高等数学」∋「数学」）。

  **为什么从 soft 改成 hard**：旧口径（到期段 / 非到期段各自内部方向内排前、不改到期优先）在真机上**几乎看不出来**——到期词条由艾宾浩斯驱动、恒压在队列最前，方向只能在同优先级内部微调。于是「数学 30 分钟」照样刷出满屏英语单词，用户侧的结论是「番茄钟没生效」。方向是用户**显式定下**的，它应该赢过到期排序，而不是排在它后面。

  **硬过滤**：工作段里方向外的词条**整条不进队列**（哪怕它到期了）。到期打卡并没有损失——换个时段、或结束番茄钟后它仍在队列里。

  **排空后的三级兜底**（硬过滤必须自带退路，否则就是把人锁死在空队列前）：

  | 结局 | 触发 | 行为 |
  | --- | --- | --- |
  | `focused` | 方向内还有没刷的 | 正常出，不提示 |
  | `repeat` | 方向内今天都「斩」过了 | **忽略当天 `slain`**，在方向内重复巩固，并提示「今天都刷过了，开始重复巩固」 |
  | `exhausted` | 词库里这个方向一条都没有 | 队列给空 ⇒ 立即**现场出题**（`POST /api/drill/new-terms`，提示词带方向），并如实提示「正在现场出新词」 |

  `repeat` / `exhausted` 都会顺带要一次新词；补词带闸：同一时刻只一次在飞、每局最多 3 次（换会话重新计数），补不到就如实说空——**不回退到全库**。没开钟 / 休息段（`subject` 为 null）逐字走 soft 原路（口径 1）。

  ★ `orderDrillQueue` 的 `focusMode` 缺省 `soft` ⇒ 不传这个参数的既有调用方（服务端 `learning/drill.ts`）行为一字不变。
- **5.4 引路灯**：`GuideFacts.focus`（服务端从库读、客户端从 store 读，两边同一份 `pomodoroFocus`）；提示词多一行「这一段的学习方向是……chat.topic 的开场白必须是这个方向里的问题」；规则推荐的 `chat.topic` / `chat.ask` 文本换成方向版（`focusGuideText`），`quiz.start` 副行写「围绕「方向」出题」。模型输出不合格时的兜底文本同样走方向版。提示词改了 ⇒ `guide.next`、`drill.newterms` 的 `version` 各 +1。

- **5.5 这一段读哪篇（v0.2.157 新增）**：开钟卡上多一个**选填**的网址输入——定方向时顺手指定这一段要读的网页资料，省得开钟后再翻去对话页的「+」菜单。

  落法：开钟卡长在督促抽屉 / 词条页，**不持有 sessionId**，也不该为一个输入框去持有一份会话状态。所以它只发一条请求事件 `sb:doc-url-request`（`features/chat/doc-events.ts`），由持有 sessionId 与抓取实现的 `useDocMode` 接住，走**同一个** `submitUrl` ⇒ 抓取、截断提示、「失败不碰已载入的那份」全都只有一份实现，不会分叉。

  三条口径：① 开钟成功才载资料（钟没开起来就改会话资料＝改了用户没要求改的东西）；② **工作段**才给「换一篇」，休息段不给（休息段不是「学数学」，口径 1）；③ 对话页没挂载时没人接 ⇒ 文案只说「已交给对话页载入，结果看输入框上方的资料条」，**不说「已载入」**（ADR-5 不静默、不谎报）。

## 6. 前端状态（`pomodoro-store.ts`）

模块级小 store（`useSyncExternalStore`，同 `drill-dock`）：番茄钟一头长在词条页、一头长在右下角胶囊旁，还要喂给引路灯与刷词，props 穿不过去。真相在服务端，store 是镜像 + 写口：`startFocus / advanceFocus / skipFocusBreak / stopFocus` 都「shared 算好 → PUT → 以回写为准」。启动 `loadPomodoroState()` 一次；失败当没开钟并置 `loaded`（不卡别的功能）。`usePomodoroClock` 只在开着钟时每秒跳一次。

## 7. 提醒：督促胶囊旁的气泡（`PomodoroBubble`）

与趋势卡气泡同舱（`.coach-dock-rail`），同一条克制纪律：不是模态、不自动展开抽屉、不响铃、不发系统通知。判定只有 shared 的 `pomodoroReminder` 一份：

| 种类 | 何时 | 动作 |
|---|---|---|
| `work-done` | 工作段到点 | 开始休息 / 再来一轮（跳过休息）/ 结束 |
| `break-done` | 休息段到点 | 开始下一轮 / 结束 |
| `setup` | **没开钟**、应用打开满 3 分钟、本机 2 小时内没提过 | 去定一个（`sb:pomodoro-open`）/ ✕（记时间戳，2 小时内不再提） |

- 7.1 胶囊上：有钟时数字前多 `🍅 方向 MM:SS`（休息段 `☕ 休息 MM:SS`），是此刻最要紧的那个数。
- 7.2 段内进行中不冒泡（倒计时在胶囊上，不需要第二处）。✕ 只收起这一次（键＝段开始时刻 + 种类），翻到下一段到点再冒。
- 7.3 「还没设钟」的提醒是提醒他**定个方向**，不是催他学；`loaded` 之前不提（没拉到状态不知道他有没有钟）。时间戳记本机 `localStorage`，不跨设备。

## 8. 出题中也算等待（等待时刷词）

出一组题常要二三十秒、情景题更久，而那段时间对话流的 `busySessionId` 是空的。`use-quiz-actions` 把「哪间会话正在出题」写进 `drill/quiz-wait` store，App 把它与 `localBusySid` 并成一个信号喂给 `WaitDrill`——弹 / 回的时机、2 秒表、本轮不再弹全部照旧（`WAIT-DRILL-SPEC` §2 一字不改）。出题等待条上另给一个「刷词」入口（同 `sb:drill-open`），关掉自动弹也能点开。

## 9. 引路灯加强：正下方直接摆一条

> 用户原话：「要主动弹出一个选项在他自己的正下方，用户点击他本身才是多个选项。」

- 亮灯时（原有的「聊完一轮 / 一组题刚变得可解析」，加上**番茄钟刚开 / 刚进下一轮**）提灯正下方出现**快捷项**：短提示 + 第一条推荐（`result.items[0]`：先规则、AI 回来原位换）+ ✕。点推荐＝执行并灭灯，**不展开**清单；点提灯本身才是整张清单。
- 亮灯那刻顺手预取 AI 推荐（让 AI 版尽快到）。✕ 只收起这一次亮灯；再次亮灯重新出现。
- 番茄钟触发的亮灯短提示写「专注「方向」，从这开始？」；只在 `fresh / chatted / tour` 三个阶段触发（忙态与做完题各有自己的时刻）。
- 窄屏（<700px）不摆快捷项（提灯坐在顶栏里，下面就是内容），原有光晕与小点照旧；知识大陆通栏页照摆（`position: absolute` + `z-index`，不改页面盒子）。

## 10. 专注统计（v0.2 新增；迁移 v54 `pomodoro_log`）

- **流水**：一行＝完成一个工作段。服务端在 `PUT /api/pomodoro` 里比对库里那份：`completed` 恰好 +1 且上一份在工作段 ⇒ 按**上一份**的方向 / 时长 / 轮次记一行。原样重存、换方向重开（completed 归零）、`DELETE` 都不记；「再来一轮」一次翻两段也只记一轮。
- **接口** `GET /api/pomodoro/stats` → `PomodoroStats { today:{rounds,minutes}, recent:[{day,rounds,minutes}]×7（升序、缺日补 0）, bySubject:[{subject,rounds,minutes}]（分钟降序） }`，按人隔离。
- **可视化**（抽屉顶部）：表头 `今日 N 轮 · M 分`（今天为零则看近 7 天，都为零给引导语）；近 7 天分钟折线复用 `renderTrendSvg`（**只画不算**：数字全来自 SQL，前端不累加、不补点）；方向芯片最多 6 个。一轮没专注过时不画图、只给一句引导——空图比没图更像坏了。
- **刷新**：store 里的会话 `completed` 一变就重拉统计（刚完成一轮）；休息→下一轮不变不拉。

## 11. 明确不做

- 不做服务端定时器、不发系统通知、不响铃（与督促 / 引路灯同一条纪律）。
- （v0.1 的「不做历史统计表」已被 v0.2 §10 取代。）
- 不在休息段偏向任何功能。
- 不把方向写进长期记忆 / 学习者模型（它是「接下来半小时」的事，不是「他是谁」）。

## 12. 已知边界（如实说）

- 「方向内领域」靠字面包含判断：方向写「高数」而领域是「数学」时不匹配，需要用户选领域芯片或写全名。
- 倒计时在前端按本机时钟走、`focus.leftMin` 在服务端按服务器时钟算；两边差几秒属正常，不做对时。
- 标签页休眠时 `setInterval` 会被浏览器节流，到点提醒可能晚几秒到几十秒出现；不靠后台定时器补。

## 13. 验收与测试

| 文件 | 锁什么 |
|---|---|
| `shared/src/pomodoro.test.ts` | 开钟 / 归一 / 翻段 / 长休 / 不自动翻页 / 方向与文案 / 主题改写 / 领域匹配 / 时钟格式 / 提醒四种判定 / 引路灯与刷词两处消费 |
| `server/src/routes/pomodoro.test.ts` | 三端点 + 400 / 403 / 多租户；对话 focus 段有无；引路灯提示词与规则话题；刷词提示词；出题主题三种改写；★ 流水只在 completed +1 时记、再来一轮只记一轮、逐日 7 天升序补 0、方向降序、多租户 |
| `web/src/features/pomodoro/pomodoro-store.test.ts` | 启动拉取与失败降级、四个写口以回写为准、本机时间戳、跨组件事件 |
| `web/src/features/pomodoro/PomodoroCard.test.tsx` | 表单禁用与芯片、PUT 的会话形状、倒计时跳动、到点不翻页、两段的按钮各走各的写口 |
| `web/src/features/pomodoro/PomodoroPanel.test.tsx` | loaded 后才拉统计；空统计引导语不画图、有统计表头 / 折线 / 方向芯片；completed 变才重拉；开钟卡在面板里 |
| `web/src/features/pomodoro/PomodoroBubble.test.tsx` | 三种提醒的出现与动作、setup 的 3 分钟 / 2 小时、✕ 只收起这一次 |
| `web/src/features/guide/GuideBeacon.quick.test.tsx` | 快捷项出现 / 执行不展开 / 提灯才展开 / ✕ 只这一次 / 番茄钟刚开亮灯且话落方向 |
| `web/src/features/drill/quiz-wait.test.ts` | 出题等待信号的读写与去重 |

人工验证（本册锁不到）：胶囊旁三种气泡的位置顺不顺、提灯正下方那条在知识大陆页会不会盖住要点的东西、开钟后对话是否真的往方向靠。

## 14. 修订记录

- v0.1（2026-10-01）：首版。
- v0.2（2026-10-02）：植入点由词条页复习列表改为右下角督促小窗抽屉；新增专注统计（迁移 v54、`/stats`、折线 + 方向芯片）；气泡「去定一个」改为打开抽屉。
