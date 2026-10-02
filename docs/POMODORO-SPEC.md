# POMODORO-SPEC — 番茄钟 × 学习方向

> 版本：v0.1 | 状态：[未发版] | 更新：2026-10-01 | 分支：`feat/pomodoro-focus`
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

## 3. 植入点：复习列表（词条页 `ReviewPanel`）

- 与「复习范围 / 今日目标 / 展开队列」并列的**第四个独立开关**「番茄钟」；开着钟时按钮写「🍅 进行中」且**默认展开**（倒计时就该在眼前）。
- 未开钟：「学什么」（可敲、可点词条库里已有的领域芯片，最多 8 个）+「学多久」（25 / 30 / 45 / 60 四档 + 自填，钳 [5, 180]）+「开始专注」（方向为空禁用）。
- 开着钟：方向、第几轮、已完成几轮、`MM:SS` 倒计时；工作段「提前休息 / 开始休息」「再来一轮」「结束番茄钟」，休息段「开始第 N 轮」「结束番茄钟」。
- 任何地方发 `sb:pomodoro-open`（气泡「去定一个」）⇒ App 跳词条页，这张卡自己展开。

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
- **5.3 刷词**：`learning/drill.ts` 出新词的提示词里方向句排在「他刚刚问的是」之前（方向是他定的，话题只是刚好聊到）；`shared/drill.ts` 的 `orderDrillQueue` 多一个 `focusSubject`：到期段 / 非到期段**各自内部**方向内领域排前，**不改**到期优先。领域是否「方向内」＝ `domainMatchesFocus`（大小写不敏感、互相包含即算：「高等数学」∋「数学」）。
- **5.4 引路灯**：`GuideFacts.focus`（服务端从库读、客户端从 store 读，两边同一份 `pomodoroFocus`）；提示词多一行「这一段的学习方向是……chat.topic 的开场白必须是这个方向里的问题」；规则推荐的 `chat.topic` / `chat.ask` 文本换成方向版（`focusGuideText`），`quiz.start` 副行写「围绕「方向」出题」。模型输出不合格时的兜底文本同样走方向版。提示词改了 ⇒ `guide.next`、`drill.newterms` 的 `version` 各 +1。

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

## 10. 明确不做

- 不做服务端定时器、不发系统通知、不响铃（与督促 / 引路灯同一条纪律）。
- 不做历史统计表（本周专注几小时）——要做再开表，现在不预支。
- 不在休息段偏向任何功能。
- 不把方向写进长期记忆 / 学习者模型（它是「接下来半小时」的事，不是「他是谁」）。

## 11. 已知边界（如实说）

- 「方向内领域」靠字面包含判断：方向写「高数」而领域是「数学」时不匹配，需要用户选领域芯片或写全名。
- 倒计时在前端按本机时钟走、`focus.leftMin` 在服务端按服务器时钟算；两边差几秒属正常，不做对时。
- 标签页休眠时 `setInterval` 会被浏览器节流，到点提醒可能晚几秒到几十秒出现；不靠后台定时器补。

## 12. 验收与测试

| 文件 | 锁什么 |
|---|---|
| `shared/src/pomodoro.test.ts` | 开钟 / 归一 / 翻段 / 长休 / 不自动翻页 / 方向与文案 / 主题改写 / 领域匹配 / 时钟格式 / 提醒四种判定 / 引路灯与刷词两处消费 |
| `server/src/routes/pomodoro.test.ts` | 三端点 + 400 / 403 / 多租户；对话 focus 段有无；引路灯提示词与规则话题；刷词提示词；出题主题三种改写 |
| `web/src/features/pomodoro/pomodoro-store.test.ts` | 启动拉取与失败降级、四个写口以回写为准、本机时间戳、跨组件事件 |
| `web/src/features/pomodoro/PomodoroCard.test.tsx` | 表单禁用与芯片、PUT 的会话形状、倒计时跳动、到点不翻页、两段的按钮各走各的写口 |
| `web/src/features/pomodoro/PomodoroBubble.test.tsx` | 三种提醒的出现与动作、setup 的 3 分钟 / 2 小时、✕ 只收起这一次 |
| `web/src/features/guide/GuideBeacon.quick.test.tsx` | 快捷项出现 / 执行不展开 / 提灯才展开 / ✕ 只这一次 / 番茄钟刚开亮灯且话落方向 |
| `web/src/features/drill/quiz-wait.test.ts` | 出题等待信号的读写与去重 |

人工验证（本册锁不到）：胶囊旁三种气泡的位置顺不顺、提灯正下方那条在知识大陆页会不会盖住要点的东西、开钟后对话是否真的往方向靠。

## 13. 修订记录

- v0.1（2026-10-01）：首版。
