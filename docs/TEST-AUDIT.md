# TEST-AUDIT — 全仓测试合理化评估（2026-10-02）

> 范围：`main` 上全部 **342 个测试文件 / 4038 例**（另对 `feat/pomodoro-focus` 新增的 7 文件 44 例同口径评估，全部落在 A/B，不在本表）。逐例明细见 [`test-audit-cases.csv`](test-audit-cases.csv)（每行：包 / 文件 / 行号 / describe / 标题 / 耗时 / 断言数 / 自动标签 / 档位 / 理由 / 处置）。

## 0. 一句话结论

**这套测试不是「多而无理由」，是「多且几乎每条都写了理由」。** 按正规口径逐例过完：A 必须 **2975** 例（73%）、B 保底 **992** 例（24%）、C 建议删除 **71** 例（1%）。本次只删 C 档（71 例 / 5 整文件 + `Landing.test.tsx` 9 例），**不按比例砍**——砍 B 档等于删掉能挡住真实回归的锁，换来的只是数字好看。真正该合理化的不是用例数，而是三件事（§4）：登记台账的行级计数已漂移、保底档里有一批适合并成表驱动、以及少数慢文件。

## 1. 评估标准（正规口径）

采用**风险驱动测试**（ISTQB risk-based testing）+ **测试金字塔**两把尺子。每一条用例必须能回答三个问题：

1. **挡住什么失败？**（failure mode）——说不出具体失败的用例没有存在理由。
2. **别处能不能挡？**——TypeScript、eslint、四项门禁、另一条测试已经能挡住的，这条就是重复。
3. **代价多大？**——运行耗时、脆弱度（改文案 / 改常量就红的测试是「实现镜像」，维护成本高于价值）。

据此分三档：

| 档 | 定义 | 典型 |
|---|---|---|
| **A 必须** | 挡住的是**用户可见 / 数据 / 安全**层面的失败，且别处挡不住 | 端到端集成链（supertest 真库）、安全与归属边界（403/404、消毒、租户隔离）、事故回归锁、迁移与库形状、错误路径、多断言的契约纯函数、UI 交互→处理器 |
| **B 保底** | 挡住真实失败，但影响面小、或与 A 档部分重叠 | 纯函数单点边界、UI 渲染细节、双语完整性、像素资产一致性、公开页形状、源码文本锁 |
| **C 建议删除** | 不产生独立判定：改实现必改测试、或 tsc / 门禁已覆盖、或测的不是产品行为 | 断言常量＝常量、文案逐字相等、营销演示内容的形状、只验「能渲染不炸」、跳过且无解除条件、零断言 |

## 2. 方法与局限（如实说）

- **自动标注**：静态解析每个 `it/test` 块（断言数、是否 supertest / 真库 / render、是否读源码、是否只比字面量或常量、是否 4xx、标题关键词），叠加 vitest JSON 报告的真实耗时与 skip 状态，得到 18 种标签与初判档位。
- **人工复核**：C 档**全部逐条读过**；自动初判为 C 的 128 例里 **57 例是误报**（实为行为判定，如「摘要超长按上限截断」「选项失效给兜底文案不抛」），已改回 B 并在 CSV 标注「人工复核」。B 档抽样 45 例核对口径。
- **局限**：A/B 的边界是启发式的（断言数、是否引契约、是否有错误路径），不是逐条读码；它回答的是「这条测试属于哪一类风险」，不是「这条测试写得好不好」。要再精确一档，需要变异测试（本仓 `guard-audit` 已对门禁做了，对业务测试没做）。

## 3. 结果总览

| 包 | A 必须 | B 保底 | C 建议删除 | 合计 |
|---|---:|---:|---:|---:|
| shared | 352 | 184 | 0 | 536 |
| server | 1790 | 487 | 0 | 2277 |
| web | 833 | 321 | 71 | 1225 |
| **合计** | **2975** | **992** | **71** | **4038** |

**A 档为什么必须（按理由）**

| 理由 | 例数 |
|---|---:|
| 纯函数契约(多断言/引契约) | 861 |
| 安全/归属边界 | 697 |
| 事故回归锁 | 634 |
| 错误路径/异常处理 | 453 |
| UI 交互 → 处理器被调用/状态变化 | 149 |
| 真库读写 | 98 |
| 数据迁移/库形状 | 47 |
| 端到端集成链 | 36 |

**B 档为什么只是保底**

| 理由 | 例数 |
|---|---:|
| 纯函数单点边界 | 867 |
| 公开页形状(sitemap/canonical) | 27 |
| 文案逐字相等:改文案必改测试,无独立判定价值 | 23 |
| 落地页/演示内容的形状与文案:属营销素材,不是产品行为 | 19 |
| UI 渲染细节 | 18 |
| 像素资产一致性校验 | 11 |
| 双语完整性/长度上限(翻译漏项) | 10 |
| 断言常量等于常量:改常量时测试跟着改,挡不住任何错 | 8 |
| 不产生判定(跳过/只测类型/零断言/快照) | 4 |
| 只验「能渲染不炸」:tsc 与任一交互用例已覆盖 | 3 |
| 源码文本锁(守门禁) | 2 |

**自动标签分布**（一例可多标）

| 标签 | 含义 | 例数 |
|---|---|---:|
| `UNIT` | 纯函数 | 2181 |
| `REGRESSION` | 事故回归锁(标题含 回归/事故/真机/变异/★) | 810 |
| `SECURITY` | 安全/归属/限流边界(403/404/429、消毒、租户) | 701 |
| `DB` | 真库读写(非 HTTP) | 265 |
| `UI` | jsdom 渲染 | 232 |
| `INTEGRATION` | supertest 真路由/真库端到端 | 150 |
| `SEO_SHAPE` | 公开页形状 | 113 |
| `DEMO_CONTENT` | 落地页/演示内容 | 99 |
| `MIGRATION` | 迁移与库形状 | 93 |
| `COPY` | 文案/双语 | 54 |
| `ART_ASSET` | 像素资产校验 | 38 |
| `CONST_ECHO` | 断言常量=常量 | 14 |
| `SOURCE_GREP` | 读源码文本的锁 | 11 |
| `SKIPPED` | 跳过 | 4 |
| `RENDER_ONLY` | 只验能渲染 | 4 |

**耗时**：全量用例自身耗时合计约 68 秒（不含环境启动）；shared 0.3s / server 41s / web 26s。最慢 10 个文件：

| 文件 | 例数 | 耗时 |
|---|---:|---:|
| `web/src/app/Landing.test.tsx` | 14 | 3.6s |
| `server/src/storage/db.test.ts` | 75 | 2.6s |
| `web/src/lib/svg-sanitize.fuzz.test.ts` | 3 | 2.3s |
| `web/src/features/continent/spell-fx.test.ts` | 6 | 1.9s |
| `server/src/routes/pk-history.test.ts` | 22 | 1.7s |
| `server/src/routes/auth.test.ts` | 20 | 1.4s |
| `server/src/routes/pk-match.test.ts` | 17 | 1.4s |
| `server/src/routes/pk-scenario.test.ts` | 13 | 1.4s |
| `server/src/routes/pk-room.test.ts` | 19 | 1.3s |
| `web/src/app/LandingLang.test.tsx` | 13 | 1.2s |

## 4. 真正该合理化的三件事

### 4.1 删除 C 档（本 PR 已做）：71 例 / 5 文件

| 文件 | 删 | 理由 |
|---|---:|---|
| `web/src/app/demo/graph-visual.test.ts` | 20 | hero 演示用的椭圆交点几何：演示素材，不进产品；产品里的知识图功能已于 2026-09-25 整族下线，这些几何只剩落地页动画在用 |
| `web/src/app/demo/graph-demo.test.ts` | 17 | 演示帧的节点布局不相交、环数：同上 |
| `web/src/app/demo/PkFlowDemo.test.tsx` | 10 | 对战演示五帧的内容矩阵：演示内容形状 |
| `web/src/app/demo/GraphDemo.test.tsx` | 8 | 知识图演示逐帧 DOM：同上 |
| `web/src/app/LandingBrand.test.tsx` | 7 | 顶栏品牌牌打字机的帧数与格数：动画观感，改节奏必改测试 |
| `web/src/app/Landing.test.tsx` | 9 of 14 | 章节顺序、章节文案齐备、演示线型：营销文案的镜像。**留 5 条**：「门面只讲游戏化、下线功能不再出现」（产品诚实性）、三条展开注册/登录卡（行为）、速览卡结构（真 bug 回归锁） |

判断标准：这些测试挡住的失败是「落地页的字 / 动画和昨天不一样」——那是改文案时**预期**要发生的事，不是缺陷；且这组文件里的 `Landing.test.tsx` 是全仓**最慢**的测试文件（3.6s）。

**复核后保留的 C 初判误报（57 例）**：
- `shared/src/choice.test.ts` — 选项已失效（回复对不上任何选项、也没有 custom）→ 兜底文案，不抛（自动标注 `COPY`，实为行为判定）
- `shared/src/memory.test.ts` — 超长按 MEMORY_CONTENT_MAX 截断而不是丢弃（自动标注 `CONST_ECHO`，实为行为判定）
- `shared/src/npc.test.ts` — ①b 脏输入不炸：负数 / 小数 / NaN 一律落到下限（自动标注 `CONST_ECHO`，实为行为判定）
- `shared/src/quiz-mix.test.ts` — 一步跨多档时只加到能加的位置（差 2 档到顶却 +5 → 只 +2）（自动标注 `CONST_ECHO`，实为行为判定）
- `shared/src/speech.test.ts` — 有音色显示音色名；没有则显示「系统默认英文音色」（自动标注 `COPY`，实为行为判定）
- `server/src/chat/compact.test.ts` — 摘要超长按 SUMMARY_MAX_CHARS 截断（防「摘要」出一篇长文把窗口吃回去）（自动标注 `CONST_ECHO`，实为行为判定）
- `server/src/chat/grill.test.ts` — pre 与 post 是两条不同的指令，不是同一个模板换词（自动标注 `CONST_ECHO`，实为行为判定）
- `server/src/chat/task-list.test.ts` — renderTaskList：带序号 + 三态标记（序号是增量定位的锚点，必须给）（自动标注 `COPY`，实为行为判定）
- `server/src/routes/pk-match.test.ts` — 成功出题重置怠慢锚点：无动作的对手吃怠慢分，出题人免罚（自动标注 `SKIPPED`，实为行为判定）
- `server/src/sources/shot.test.ts` — 经守门代理截本机页面：PNG 魔数、体积合理（自动标注 `SKIPPED`，实为行为判定）
- `web/src/app/Landing.test.tsx` — 点「开始使用」→ 展开注册卡（提交按钮是「注册并登录」）；再点一次收起（自动标注 `DEMO_CONTENT+UI`，实为行为判定）
- `web/src/app/Landing.test.tsx` — 终章「踏上大陆」也能展开注册卡（自动标注 `DEMO_CONTENT+UI`，实为行为判定）
- `web/src/app/Landing.test.tsx` — 点「登录」→ 展开登录卡（提交按钮是「登录」，不是注册）（自动标注 `DEMO_CONTENT+UI`，实为行为判定）
- `web/src/app/LandingDemoEntry.test.tsx` — providers.demo=true → 画「免注册，直接体验」并附共享池警示文案（自动标注 `DEMO_CONTENT+UI`，实为行为判定）
- `web/src/app/LandingDemoEntry.test.tsx` — providers.demo=false → 入口不存在（开关在上游，按钮不点了报错）（自动标注 `DEMO_CONTENT+UI`，实为行为判定）
- `web/src/app/LandingDemoEntry.test.tsx` — 点击成功 → onAuthed 收到体验用户（进应用壳的动作由上层完成）（自动标注 `DEMO_CONTENT+UI`，实为行为判定）
- `web/src/app/LandingDemoEntry.test.tsx` — 点击失败 → 错误文案就地可见，按钮回到可点（ADR-5 可读可重试）（自动标注 `DEMO_CONTENT+UI`，实为行为判定）
- `web/src/app/LandingLang.test.tsx` — 非中文浏览器首探即英文：hero 标题与体验警示都是英文那一侧（自动标注 `DEMO_CONTENT`，实为行为判定）
- `web/src/app/LandingLang.test.tsx` — 切换键两枚永远都在（语言名不翻译：中文 / EN 各自写自己）（自动标注 `DEMO_CONTENT+UI`，实为行为判定）
- `web/src/app/LandingLang.test.tsx` — 存过 zh 就不再让自动判定插手（哪怕浏览器是英文）（自动标注 `DEMO_CONTENT`，实为行为判定）
- `web/src/app/LandingLang.test.tsx` — 存过 en 就不再切回中文（哪怕浏览器是 zh-CN）（自动标注 `DEMO_CONTENT`，实为行为判定）
- `web/src/app/LandingLang.test.tsx` — 知识图演示切到 EN：按钮、角标、图例全换成英文，中文侧仍说自己那套（自动标注 `DEMO_CONTENT+UI`，实为行为判定）
- `web/src/app/LandingLang.test.tsx` — EN 侧：知识大陆与伙伴章的标题、按钮都是英文；切回中文后换成中文（自动标注 `DEMO_CONTENT`，实为行为判定）
- `web/src/app/LandingPv.test.tsx` — ① 弹层关着时页面上没有 <video>（不点就不下载）（自动标注 `DEMO_CONTENT`，实为行为判定）
- `web/src/app/LandingPv.test.tsx` — ② 点开后出现 dialog，视频指向站点静态路径且带播放控件（自动标注 `DEMO_CONTENT`，实为行为判定）
- `web/src/app/LandingPv.test.tsx` — ③ Esc 关闭后 <video> 真的从 DOM 卸载（不是藏起来）（自动标注 `DEMO_CONTENT`，实为行为判定）
- `web/src/app/LandingPv.test.tsx` — ④ 关闭键与遮罩都能关；点层内不误关（遮罩靠冒泡，stopPropagation 一漏就出事）（自动标注 `DEMO_CONTENT`，实为行为判定）
- `web/src/app/LandingPv.test.tsx` — ⑤ 背景滚动锁与解锁成对（关掉后回到打开前的样子）（自动标注 `DEMO_CONTENT+COPY`，实为行为判定）
- `web/src/app/LandingPv.test.tsx` — ⑥ 英文侧按钮与弹层文案都是英文，且不与中文同形（自动标注 `DEMO_CONTENT`，实为行为判定）
- `web/src/components/GithubLoginButton.test.tsx` — 渲染为指向 /api/auth/github 的整页链接（不是 fetch）（自动标注 `UI+RENDER_ONLY`，实为行为判定）
- `web/src/lib/highlight.test.ts` — 无损：拼回原文（自动标注 `CONST_ECHO`，实为行为判定）
- `web/src/lib/image-intake.test.ts` — 空托盘、无进行中的上传 → 满额可用（自动标注 `CONST_ECHO`，实为行为判定）
- `web/src/seo/public-hygiene.test.ts` — ★ 真实产物：未豁免前确实带字样（钉住「bundle 本来就干净」这个偷懒前提），豁免后必须为空（自动标注 `SKIPPED+SECURITY+REGRESSION`，实为行为判定）
- `web/src/seo/public-hygiene.test.ts` — ★ 豁免不许变成死的：每一条必须当场还在产物里出现（依赖升级／文案改动之后要重看）（自动标注 `SKIPPED+SECURITY+REGRESSION`，实为行为判定）
- `web/src/seo/term-en.test.ts` — 英文页里每条 `/terms/` 链接都有对应落盘文件；sitemap 含全部英文地址（自动标注 `SEO_SHAPE+COPY`，实为行为判定）
- `web/src/seo/term-en.test.ts` — 英文目录页把六条全列出来，每条带一句定义（自动标注 `SEO_SHAPE+COPY`，实为行为判定）
- `web/src/seo/term-en.test.ts` — 产品落点只描述机制，不冒充第三方背书（自动标注 `SEO_SHAPE+COPY`，实为行为判定）
- `server/src/chat/tools/generate-quiz.test.ts` — 单档上限可以把总数压到不足请求值：如实少给，不越界补题（ADR-5）（自动标注 `CONST_ECHO`，实为行为判定）
- `web/src/features/chat/chat-meta.test.ts` — 未登记的新工具回退原 key——宁可露英文也不把「有工具在跑」藏掉（ADR-5 不静默）（自动标注 `COPY`，实为行为判定）
- `web/src/features/chat/process-summary.test.ts` — 全空给兜底文案（调用方据此不渲染按钮，但函数本身不抛）（自动标注 `COPY`，实为行为判定）
- `web/src/features/chat/process-summary.test.ts` — 只有思考链：短报「已深度思考」，过千字带字数（自动标注 `COPY`，实为行为判定）
- `web/src/features/chat/useSessionDraft.test.ts` — 首次挂载与同会话重渲染都不动输入框（自动标注 `UI+RENDER_ONLY`，实为行为判定）
- `web/src/features/continent/continent-view.test.ts` — cellLabel 用 1 起的行列号（写「第 1 行」而不是「第 0 行」）（自动标注 `COPY`，实为行为判定）
- `web/src/features/guide/guide-copy.test.ts` — 每条都有非空的中文与英文（自动标注 `COPY`，实为行为判定）
- `web/src/features/guide/guide-copy.test.ts` — 中英不相同（相同＝没译；个别纯符号条目除外，这里没有）（自动标注 `COPY`，实为行为判定）
- `web/src/features/guide/guide-copy.test.ts` — 机器码原因全覆盖：no-model / timeout / aborted / upstream / parse + 客户端自己的 fail（自动标注 `COPY`，实为行为判定）
- `web/src/features/pk/pk-view.test.ts` — myPendingQuestion：只认「发给我且 pending」的题（自动标注 `COPY`，实为行为判定）
- `web/src/features/pk/pk-view.test.ts` — pendingToOpponent：只认「我出、发给对方、pending」的题（自动标注 `COPY`，实为行为判定）
- `web/src/features/pk/pk-view.test.ts` — verdictText：答对带 + 号，答错为负（自动标注 `COPY`，实为行为判定）
- `web/src/features/quiz/mix-report.test.ts` — 只命中缓存 → 说命中缓存，不把 cache 谎报成一家搜索源（自动标注 `COPY`，实为行为判定）
- `web/src/features/quiz/mix-report.test.ts` — 全摘够 → 逐档 want/want，并报总数与页数（页数取抓取成功的页）（自动标注 `COPY`，实为行为判定）
- `web/src/features/quiz/mix-report.test.ts` — 页数优先按真题逐题 source.url 去重（准确口径，抓了没用上的页不算）（自动标注 `COPY`，实为行为判定）
- `web/src/features/quiz/mix-report.test.ts` — AI/联网题的 url 不计入真题页数（来源分开算，不混账）（自动标注 `COPY`，实为行为判定）
- `web/src/features/quiz/mix-report.test.ts` — 部分摘不到 → 缺的档标「少 N 道」，并明说未用 AI 顶替（报缺不补）（自动标注 `COPY`，实为行为判定）
- `web/src/features/quiz/mix-report.test.ts` — 一条都没摘到 → 交代结果、指向逐页报告、并说清题目从哪来（自动标注 `COPY`，实为行为判定）
- `web/src/features/quiz/mix-report.test.ts` — 老服务端不返回 collect / 搜集整体抛错 → 照样给文案，不崩（真题是增益不是依赖）（自动标注 `COPY`，实为行为判定）
- `web/src/features/settings/SpeechCard.test.tsx` — 渲染服务端读回的音色与语速（自动标注 `UI+RENDER_ONLY`，实为行为判定）

### 4.2 登记台账的行级计数已经形式化（建议：去掉行级例数，只留文件与不变量）

`docs/TEST-PLAN.md` §3 要求每个测试文件成行并写例数，但本次对账发现 **22 行的例数与实测不符**（门禁只查「有没有这一行」，不查数字）。门禁不查数字，数字也就没人复核。最大偏差：

| 文件 | 台账 | 实测 |
|---|---:|---:|
| `server/src/routes/providers-tenancy.test.ts` | 13 | 20 |
| `web/src/seo/term-corpus.test.ts` | 9 | 15 |
| `shared/src/continent.test.ts` | 33 | 38 |
| `server/src/routes/growth.test.ts` | 8 | 13 |
| `server/src/learning/quiz.test.ts` | 40 | 44 |
| `web/src/seo/public-hygiene.test.ts` | 7 | 11 |
| `server/src/sources/shelf.test.ts` | 8 | 11 |
| `web/src/features/settings/RoleRow.test.tsx` | 10 | 13 |
| `web/src/app/Landing.test.tsx` | 11 | 14 |
| `server/src/routes/npc.test.ts` | 12 | 14 |

建议：行级只留「文件 + 不变量」，例数由 `node tools/metrics.mjs --tests` 产出（README 已经这么做），台账不再手抄数字。这比删测试更能解决「为什么要这些测试」——不变量那一列才是理由，数字不是。

### 4.3 保底档里适合并成表驱动的文件（建议，不在本 PR 做）

以下文件 ≥8 例且 ≥60% 是单点边界（B 档），多数是「同一函数、不同输入」的平铺，并成 `it.each` 表后**例数变少、覆盖不变、可读性更高**：

| 文件 | 例数 | 其中 B |
|---|---:|---:|
| `server/src/learning/quiz-completeness.test.ts` | 43 | 29 |
| `server/src/chat/search-nudge.test.ts` | 30 | 25 |
| `shared/src/npc-life.test.ts` | 31 | 21 |
| `shared/src/quiz-mix.test.ts` | 27 | 21 |
| `server/src/chat/task-list.test.ts` | 25 | 19 |
| `server/src/learning/collect-figures.test.ts` | 28 | 17 |
| `web/src/lib/remend.test.ts` | 20 | 15 |
| `web/src/lib/highlight.test.ts` | 23 | 14 |
| `web/src/features/coach/coach-cards.test.ts` | 20 | 13 |
| `server/src/chat/grill.test.ts` | 12 | 11 |
| `web/src/lib/image-intake.test.ts` | 11 | 11 |
| `server/src/chat/date-context.test.ts` | 10 | 9 |
| `server/src/chat/opening.test.ts` | 10 | 8 |
| `server/src/chat/tools/registry.test.ts` | 12 | 8 |
| `server/src/llm/model-limits.test.ts` | 10 | 7 |
| `web/src/features/chat/quote-ask.test.ts` | 8 | 7 |
| `server/src/chat/context-segments.test.ts` | 8 | 6 |
| `web/src/features/search/global-search.test.ts` | 10 | 6 |
| `shared/src/quiz-image.test.ts` | 8 | 5 |
| `web/src/features/chat/chat-export.test.ts` | 8 | 5 |

（共 20 个文件符合该形状；合并后预计全仓例数下降 15–20%，而断言总数不变。）

### 4.4 一条在全量跑里偶发的用例（本次观察到，未改）

`web/src/features/continent/ContinentPage.spawn.test.tsx` 的「★ 野怪：新用户唯一一条范围外的新词条也会冒怪」在一次全量跑（337 文件并行）里红过一次，单跑三次全绿——典型的负载相关时序脆弱。按 TEST-PLAN §2 的老话「先怀疑环境，再怀疑代码」，本次只登记；若再现应给它加等待条件而不是删它。

### 4.5 跳过的 4 例都有解除条件，不删

- `routes/pk-match.test.ts` 1 例：`it.skip`，注释写明「match.ts 定稿后改回 it，不得直接删例」——这是**有欠条的隔离**，删了欠条就丢了。
- `sources/shot.test.ts` 1 例、`seo/public-hygiene.test.ts` 2 例：`skipIf`（无真浏览器 / 无 dist 时跳过），本机有条件就会跑。

## 5. 对「测试太多」这个判断的回应

- **数量来自粒度，不来自冗余**：4038 例里 73% 是 A 档；一条 supertest 用例平均只有 1 个断言、锁一个失败模式，这是本仓刻意的风格（题注里写了「为什么」）。它的代价是数字大、读台账累，收益是红灯能直接指到哪条口径坏了。
- **真正的冗余在「实现镜像」类**，本次已删；再往下删就是在删保底。
- **如果目标是「跑得快」**：server 包 41s 里一半在 pk / auth / db 这些真库 supertest 上，优化方向是共享库实例与并行，不是删例。
- **如果目标是「看得懂为什么」**：做 §4.2——把台账的理由列变成唯一真相，数字列去掉。

## 6. 每文件判定表

判定口径：`A 主导`＝A 占比 ≥50%；`B 主导`＝B 占比 ≥50%；`删除`＝本 PR 删除。耗时为 vitest 报告的用例自身耗时之和。

| 文件 | A | B | C | 耗时 | 判定 | 主要标签 |
|---|---:|---:|---:|---:|---|---|
| `server/src/ai/call-log.test.ts` | 5 | 0 | 0 | 0.12s | A 主导 | `DB` |
| `server/src/ai/gateway.test.ts` | 9 | 6 | 0 | 0.03s | A 主导 | `REGRESSION` |
| `server/src/auth/code-flow.test.ts` | 14 | 8 | 0 | 0.19s | A 主导 | `REGRESSION` |
| `server/src/auth/code-limit.test.ts` | 12 | 7 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/auth/codes.test.ts` | 9 | 6 | 0 | 0.04s | A 主导 | `DB` |
| `server/src/auth/demo-seed.test.ts` | 10 | 0 | 0 | 0.32s | A 主导 | `REGRESSION` `DB` |
| `server/src/auth/password.test.ts` | 6 | 0 | 0 | 0.48s | A 主导 | `SECURITY` |
| `server/src/auth/register-limit.test.ts` | 3 | 2 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `server/src/auth/session.test.ts` | 7 | 1 | 0 | 0.03s | A 主导 | `DB` |
| `server/src/chat/choice.test.ts` | 19 | 0 | 0 | 0.02s | A 主导 | `SECURITY` |
| `server/src/chat/compact.test.ts` | 17 | 5 | 0 | 0.71s | A 主导 | `SECURITY` |
| `server/src/chat/context-segments.test.ts` | 2 | 6 | 0 | 0.01s | B 主导 | `UNIT` |
| `server/src/chat/context.test.ts` | 6 | 4 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `server/src/chat/date-context.test.ts` | 1 | 9 | 0 | 0.00s | B 主导 | `UNIT` |
| `server/src/chat/flow.test.ts` | 38 | 3 | 0 | 0.84s | A 主导 | `SECURITY` |
| `server/src/chat/follow-up.test.ts` | 14 | 4 | 0 | 0.45s | A 主导 | `REGRESSION` |
| `server/src/chat/grill.test.ts` | 1 | 11 | 0 | 0.01s | B 主导 | `CONST_ECHO` |
| `server/src/chat/memory-digest.test.ts` | 11 | 2 | 0 | 0.41s | A 主导 | `SECURITY` |
| `server/src/chat/memory.test.ts` | 19 | 3 | 0 | 0.62s | A 主导 | `SECURITY` |
| `server/src/chat/opening.test.ts` | 2 | 8 | 0 | 0.00s | B 主导 | `SECURITY` |
| `server/src/chat/regenerate.test.ts` | 5 | 0 | 0 | 0.13s | A 主导 | `DB` |
| `server/src/chat/resend.test.ts` | 4 | 0 | 0 | 0.13s | A 主导 | `DB` |
| `server/src/chat/search-nudge.test.ts` | 5 | 25 | 0 | 0.00s | B 主导 | `SECURITY` |
| `server/src/chat/sse-bus.test.ts` | 10 | 0 | 0 | 0.01s | A 主导 | `REGRESSION` `SECURITY` |
| `server/src/chat/system-prompt.test.ts` | 1 | 2 | 0 | 0.00s | B 主导 | `REGRESSION` |
| `server/src/chat/task-list.test.ts` | 6 | 19 | 0 | 0.01s | B 主导 | `COPY` |
| `server/src/chat/tool-exec.test.ts` | 16 | 12 | 0 | 0.55s | A 主导 | `REGRESSION` |
| `server/src/chat/tools/budget.test.ts` | 0 | 3 | 0 | 0.00s | B 主导 | `UNIT` |
| `server/src/chat/tools/confirm.test.ts` | 12 | 2 | 0 | 0.02s | A 主导 | `SECURITY` |
| `server/src/chat/tools/fetch-image.test.ts` | 10 | 3 | 0 | 0.02s | A 主导 | `REGRESSION` |
| `server/src/chat/tools/fetch-page.test.ts` | 12 | 6 | 0 | 0.03s | A 主导 | `REGRESSION` |
| `server/src/chat/tools/generate-image.test.ts` | 6 | 1 | 0 | 0.19s | A 主导 | `REGRESSION` |
| `server/src/chat/tools/generate-quiz.test.ts` | 15 | 9 | 0 | 0.67s | A 主导 | `REGRESSION` |
| `server/src/chat/tools/offer-pk-battle.test.ts` | 14 | 1 | 0 | 0.46s | A 主导 | `SECURITY` |
| `server/src/chat/tools/pick-sources.test.ts` | 3 | 1 | 0 | 0.00s | A 主导 | `UNIT` |
| `server/src/chat/tools/registry.test.ts` | 4 | 8 | 0 | 0.01s | B 主导 | `UNIT` |
| `server/src/chat/tools/schema.test.ts` | 6 | 5 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `server/src/chat/tools/term-ops.test.ts` | 17 | 1 | 0 | 0.49s | A 主导 | `DB` |
| `server/src/chat/vision-error.test.ts` | 6 | 8 | 0 | 0.00s | B 主导 | `SECURITY` |
| `server/src/chat/vision.test.ts` | 5 | 7 | 0 | 0.01s | B 主导 | `SECURITY` |
| `server/src/growth/activity.test.ts` | 6 | 0 | 0 | 0.05s | A 主导 | `INTEGRATION` `DB` |
| `server/src/growth/counters.test.ts` | 24 | 3 | 0 | 0.79s | A 主导 | `REGRESSION` `DB` |
| `server/src/index.test.ts` | 16 | 0 | 0 | 0.13s | A 主导 | `INTEGRATION` `SECURITY` |
| `server/src/jobs/queue.test.ts` | 14 | 3 | 0 | 0.56s | A 主导 | `REGRESSION` |
| `server/src/learning/card-announce.test.ts` | 5 | 0 | 0 | 0.13s | A 主导 | `SECURITY` |
| `server/src/learning/chest.test.ts` | 16 | 1 | 0 | 0.49s | A 主导 | `DB` |
| `server/src/learning/collect-figures.test.ts` | 11 | 17 | 0 | 0.02s | B 主导 | `UNIT` |
| `server/src/learning/collect-quality.test.ts` | 9 | 3 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `server/src/learning/collect.test.ts` | 12 | 15 | 0 | 0.01s | B 主导 | `REGRESSION` |
| `server/src/learning/complete-eval-metrics.test.ts` | 11 | 2 | 0 | 0.01s | A 主导 | `UNIT` |
| `server/src/learning/doc-retrieve.test.ts` | 16 | 12 | 0 | 0.04s | A 主导 | `SECURITY` |
| `server/src/learning/document.test.ts` | 16 | 5 | 0 | 0.11s | A 主导 | `SECURITY` |
| `server/src/learning/domains.test.ts` | 23 | 5 | 0 | 0.81s | A 主导 | `DB` |
| `server/src/learning/fsrs-personal.test.ts` | 4 | 0 | 0 | 0.15s | A 主导 | `DB` `REGRESSION` |
| `server/src/learning/game-tick.test.ts` | 7 | 0 | 0 | 0.23s | A 主导 | `SECURITY` |
| `server/src/learning/grade-eval-metrics.test.ts` | 3 | 3 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `server/src/learning/guide.test.ts` | 22 | 1 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/learning/learner-model.test.ts` | 13 | 2 | 0 | 0.55s | A 主导 | `REGRESSION` `SECURITY` |
| `server/src/learning/learning-events.test.ts` | 5 | 4 | 0 | 0.23s | A 主导 | `REGRESSION` |
| `server/src/learning/mention.test.ts` | 15 | 3 | 0 | 0.49s | A 主导 | `SECURITY` |
| `server/src/learning/npc-agent.test.ts` | 5 | 0 | 0 | 0.17s | A 主导 | `REGRESSION` `DB` |
| `server/src/learning/npc-move.test.ts` | 9 | 3 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/learning/npc.test.ts` | 24 | 0 | 0 | 0.76s | A 主导 | `DB` `SECURITY` |
| `server/src/learning/quiz-announce.test.ts` | 6 | 1 | 0 | 0.04s | A 主导 | `UNIT` |
| `server/src/learning/quiz-attempts.test.ts` | 4 | 0 | 0 | 0.12s | A 主导 | `SECURITY` |
| `server/src/learning/quiz-blend.test.ts` | 18 | 6 | 0 | 0.01s | A 主导 | `SECURITY` |
| `server/src/learning/quiz-completeness.test.ts` | 14 | 29 | 0 | 0.02s | B 主导 | `SECURITY` |
| `server/src/learning/quiz-eval-metrics.test.ts` | 24 | 2 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/learning/quiz-explanation.test.ts` | 11 | 1 | 0 | 0.01s | A 主导 | `UNIT` |
| `server/src/learning/quiz-grade.test.ts` | 4 | 0 | 0 | 0.11s | A 主导 | `REGRESSION` |
| `server/src/learning/quiz-json-repair.test.ts` | 16 | 0 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/learning/quiz-photo.test.ts` | 3 | 0 | 0 | 0.00s | A 主导 | `SECURITY` |
| `server/src/learning/quiz-search.test.ts` | 14 | 10 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/learning/quiz-selfcontained.test.ts` | 8 | 3 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/learning/quiz-tier.test.ts` | 5 | 2 | 0 | 0.00s | A 主导 | `UNIT` |
| `server/src/learning/quiz-verify.test.ts` | 9 | 8 | 0 | 0.01s | A 主导 | `UNIT` |
| `server/src/learning/quiz.test.ts` | 32 | 12 | 0 | 1.20s | A 主导 | `REGRESSION` |
| `server/src/learning/review-queue.test.ts` | 8 | 8 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/learning/scenario-protocol.test.ts` | 8 | 2 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/learning/streak.test.ts` | 11 | 0 | 0 | 0.68s | A 主导 | `REGRESSION` `INTEGRATION` |
| `server/src/learning/tasks.test.ts` | 12 | 2 | 0 | 0.40s | A 主导 | `DB` |
| `server/src/learning/term-cards.test.ts` | 15 | 3 | 0 | 0.53s | A 主导 | `SECURITY` |
| `server/src/learning/term-graph.test.ts` | 6 | 1 | 0 | 0.24s | A 主导 | `REGRESSION` `SECURITY` |
| `server/src/learning/terms.test.ts` | 11 | 10 | 0 | 0.56s | A 主导 | `DB` |
| `server/src/learning/tidy.test.ts` | 12 | 8 | 0 | 0.61s | A 主导 | `DB` |
| `server/src/learning/trend.test.ts` | 18 | 1 | 0 | 0.59s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/llm/anthropic-thinking.test.ts` | 4 | 3 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/llm/anthropic.test.ts` | 8 | 3 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/llm/image-error.test.ts` | 10 | 1 | 0 | 0.00s | A 主导 | `SECURITY` |
| `server/src/llm/image-gen.test.ts` | 15 | 1 | 0 | 0.39s | A 主导 | `SECURITY` `DB` |
| `server/src/llm/image-quota.test.ts` | 6 | 2 | 0 | 0.22s | A 主导 | `UNIT` |
| `server/src/llm/model-limits.test.ts` | 3 | 7 | 0 | 0.00s | B 主导 | `REGRESSION` |
| `server/src/llm/openai-content.test.ts` | 1 | 1 | 0 | 0.01s | A 主导 | `UNIT` |
| `server/src/llm/openai.test.ts` | 3 | 0 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/llm/platform-quota.test.ts` | 17 | 4 | 0 | 0.58s | A 主导 | `REGRESSION` |
| `server/src/llm/router.test.ts` | 27 | 0 | 0 | 0.76s | A 主导 | `REGRESSION` `SECURITY` |
| `server/src/llm/tool-choice.test.ts` | 0 | 6 | 0 | 0.01s | B 主导 | `UNIT` |
| `server/src/llm/upstream-gate.test.ts` | 17 | 7 | 0 | 0.01s | A 主导 | `SECURITY` |
| `server/src/llm/upstream-timeout.test.ts` | 6 | 6 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/llm/upstream-wiring.test.ts` | 6 | 2 | 0 | 0.02s | A 主导 | `REGRESSION` |
| `server/src/mail/send.test.ts` | 10 | 2 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/media/find-image.test.ts` | 5 | 2 | 0 | 0.04s | A 主导 | `SECURITY` |
| `server/src/media/image-parse.test.ts` | 2 | 5 | 0 | 0.00s | B 主导 | `SECURITY` |
| `server/src/media/vision-eval-metrics.test.ts` | 4 | 2 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `server/src/pk/invite.test.ts` | 20 | 0 | 0 | 0.02s | A 主导 | `DB` |
| `server/src/pk/question-pool.test.ts` | 4 | 3 | 0 | 0.17s | A 主导 | `REGRESSION` |
| `server/src/routes/ai-ops.test.ts` | 6 | 0 | 0 | 0.08s | A 主导 | `SECURITY` |
| `server/src/routes/answer-style.test.ts` | 8 | 0 | 0 | 0.09s | A 主导 | `DB` |
| `server/src/routes/auth-code.test.ts` | 16 | 0 | 0 | 0.60s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/routes/auth-demo.test.ts` | 10 | 0 | 0 | 0.25s | A 主导 | `SECURITY` `INTEGRATION` |
| `server/src/routes/auth-github.test.ts` | 13 | 0 | 0 | 0.46s | A 主导 | `INTEGRATION` `SECURITY` |
| `server/src/routes/auth-require.test.ts` | 9 | 0 | 0 | 0.34s | A 主导 | `SECURITY` `INTEGRATION` |
| `server/src/routes/auth.test.ts` | 20 | 0 | 0 | 1.44s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/routes/cards.test.ts` | 15 | 0 | 0 | 0.16s | A 主导 | `SECURITY` `DB` |
| `server/src/routes/chat-active.test.ts` | 4 | 3 | 0 | 0.12s | A 主导 | `REGRESSION` |
| `server/src/routes/chat-send.test.ts` | 10 | 2 | 0 | 0.33s | A 主导 | `SECURITY` |
| `server/src/routes/coach.test.ts` | 13 | 0 | 0 | 0.24s | A 主导 | `INTEGRATION` `REGRESSION` |
| `server/src/routes/continent-expand.test.ts` | 6 | 0 | 0 | 0.13s | A 主导 | `SECURITY` |
| `server/src/routes/continent.test.ts` | 4 | 1 | 0 | 0.12s | A 主导 | `INTEGRATION` `DB` |
| `server/src/routes/document.test.ts` | 13 | 0 | 0 | 0.10s | A 主导 | `INTEGRATION` `SECURITY` |
| `server/src/routes/drill.test.ts` | 7 | 0 | 0 | 0.11s | A 主导 | `INTEGRATION` |
| `server/src/routes/fork.test.ts` | 9 | 0 | 0 | 0.11s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/routes/growth.test.ts` | 12 | 1 | 0 | 0.30s | A 主导 | `REGRESSION` `INTEGRATION` |
| `server/src/routes/guide.test.ts` | 19 | 0 | 0 | 0.25s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/routes/learner.test.ts` | 5 | 0 | 0 | 0.07s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/routes/memory.test.ts` | 8 | 1 | 0 | 0.08s | A 主导 | `SECURITY` |
| `server/src/routes/npc.test.ts` | 14 | 0 | 0 | 0.18s | A 主导 | `SECURITY` |
| `server/src/routes/pk-auth.test.ts` | 4 | 0 | 0 | 0.19s | A 主导 | `SECURITY` |
| `server/src/routes/pk-history.test.ts` | 22 | 0 | 0 | 1.72s | A 主导 | `SECURITY` |
| `server/src/routes/pk-invite.test.ts` | 13 | 0 | 0 | 0.78s | A 主导 | `SECURITY` |
| `server/src/routes/pk-local.test.ts` | 2 | 1 | 0 | 0.03s | A 主导 | `UNIT` |
| `server/src/routes/pk-match.test.ts` | 14 | 3 | 0 | 1.41s | A 主导 | `SECURITY` |
| `server/src/routes/pk-power.test.ts` | 9 | 2 | 0 | 1.01s | A 主导 | `SECURITY` |
| `server/src/routes/pk-pve.test.ts` | 7 | 1 | 0 | 0.63s | A 主导 | `REGRESSION` |
| `server/src/routes/pk-room.test.ts` | 19 | 0 | 0 | 1.32s | A 主导 | `SECURITY` |
| `server/src/routes/pk-scenario.test.ts` | 13 | 0 | 0 | 1.36s | A 主导 | `SECURITY` |
| `server/src/routes/pk-terms.test.ts` | 6 | 0 | 0 | 0.63s | A 主导 | `SECURITY` |
| `server/src/routes/providers-tenancy.test.ts` | 20 | 0 | 0 | 0.16s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/routes/quiz-attempts.test.ts` | 3 | 0 | 0 | 0.08s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/routes/quiz-blend.test.ts` | 17 | 0 | 0 | 0.20s | A 主导 | `REGRESSION` |
| `server/src/routes/quiz-explanation.test.ts` | 4 | 1 | 0 | 0.10s | A 主导 | `SECURITY` |
| `server/src/routes/quiz-image.test.ts` | 11 | 0 | 0 | 0.10s | A 主导 | `INTEGRATION` `REGRESSION` |
| `server/src/routes/quiz-mix.test.ts` | 14 | 0 | 0 | 0.11s | A 主导 | `INTEGRATION` |
| `server/src/routes/quiz-search.test.ts` | 10 | 0 | 0 | 0.10s | A 主导 | `REGRESSION` |
| `server/src/routes/scenario.test.ts` | 11 | 0 | 0 | 0.11s | A 主导 | `INTEGRATION` `SECURITY` |
| `server/src/routes/search.test.ts` | 9 | 0 | 0 | 0.07s | A 主导 | `REGRESSION` |
| `server/src/routes/settings-tenancy.test.ts` | 8 | 0 | 0 | 0.11s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/routes/sources-fallback.test.ts` | 4 | 0 | 0 | 0.15s | A 主导 | `INTEGRATION` `SECURITY` |
| `server/src/routes/sources.test.ts` | 6 | 0 | 0 | 0.15s | A 主导 | `SECURITY` |
| `server/src/routes/speech.test.ts` | 7 | 2 | 0 | 0.09s | A 主导 | `REGRESSION` |
| `server/src/routes/tenancy.test.ts` | 15 | 0 | 0 | 0.08s | A 主导 | `SECURITY` `INTEGRATION` |
| `server/src/routes/term-review.test.ts` | 26 | 1 | 0 | 0.41s | A 主导 | `REGRESSION` |
| `server/src/routes/terms-tenancy.test.ts` | 8 | 0 | 0 | 0.07s | A 主导 | `SECURITY` `REGRESSION` |
| `server/src/routes/tools.test.ts` | 7 | 1 | 0 | 0.14s | A 主导 | `INTEGRATION` |
| `server/src/search/bing-channel.test.ts` | 3 | 3 | 0 | 0.01s | A 主导 | `UNIT` |
| `server/src/search/fts-index.test.ts` | 23 | 3 | 0 | 0.03s | A 主导 | `REGRESSION` |
| `server/src/search/search.test.ts` | 10 | 2 | 0 | 0.04s | A 主导 | `SECURITY` |
| `server/src/sources/reader.test.ts` | 10 | 0 | 0 | 0.02s | A 主导 | `SECURITY` |
| `server/src/sources/shelf.test.ts` | 11 | 0 | 0 | 0.01s | A 主导 | `SECURITY` |
| `server/src/sources/shot.test.ts` | 6 | 1 | 0 | 0.03s | A 主导 | `SECURITY` |
| `server/src/sources/video-route.test.ts` | 5 | 0 | 0 | 0.02s | A 主导 | `UNIT` |
| `server/src/storage/db.test.ts` | 75 | 0 | 0 | 2.64s | A 主导 | `MIGRATION` `DB` |
| `server/src/storage/image-cache.test.ts` | 9 | 3 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `server/src/storage/migrations-v43.test.ts` | 9 | 0 | 0 | 0.16s | A 主导 | `MIGRATION` `DB` |
| `server/src/storage/migrations-v44.test.ts` | 9 | 0 | 0 | 0.19s | A 主导 | `MIGRATION` `REGRESSION` |
| `server/src/storage/obs.test.ts` | 5 | 0 | 0 | 0.14s | A 主导 | `DB` |
| `server/src/storage/resolve-datadir.test.ts` | 0 | 4 | 0 | 0.00s | B 主导 | `UNIT` |
| `server/src/storage/term-delete-log.test.ts` | 7 | 0 | 0 | 0.21s | A 主导 | `DB` `SECURITY` |
| `server/src/storage/tool-stats.test.ts` | 5 | 4 | 0 | 0.31s | A 主导 | `SECURITY` |
| `server/src/version.test.ts` | 2 | 1 | 0 | 0.00s | A 主导 | `SOURCE_GREP` |
| `server/src/web-static.test.ts` | 6 | 0 | 0 | 0.06s | A 主导 | `SECURITY` `INTEGRATION` |
| `shared/src/adaptive.test.ts` | 4 | 3 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `shared/src/answer-style.test.ts` | 8 | 10 | 0 | 0.01s | B 主导 | `UNIT` |
| `shared/src/auth.test.ts` | 15 | 0 | 0 | 0.00s | A 主导 | `SECURITY` |
| `shared/src/chat-limits.test.ts` | 1 | 5 | 0 | 0.00s | B 主导 | `UNIT` |
| `shared/src/choice.test.ts` | 15 | 4 | 0 | 0.00s | A 主导 | `COPY` |
| `shared/src/coach.test.ts` | 7 | 5 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `shared/src/continent-expand.test.ts` | 5 | 3 | 0 | 0.01s | A 主导 | `UNIT` |
| `shared/src/continent-upkeep.test.ts` | 5 | 1 | 0 | 0.00s | A 主导 | `UNIT` |
| `shared/src/continent-wild.test.ts` | 7 | 1 | 0 | 0.00s | A 主导 | `SECURITY` |
| `shared/src/continent.test.ts` | 26 | 12 | 0 | 0.03s | A 主导 | `REGRESSION` |
| `shared/src/demo-content.test.ts` | 4 | 1 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `shared/src/drill.test.ts` | 8 | 7 | 0 | 0.01s | A 主导 | `UNIT` |
| `shared/src/ebbinghaus.test.ts` | 12 | 3 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `shared/src/follow-up.test.ts` | 9 | 13 | 0 | 0.01s | B 主导 | `REGRESSION` |
| `shared/src/fsrs-fit.test.ts` | 5 | 1 | 0 | 0.04s | A 主导 | `REGRESSION` |
| `shared/src/fsrs.test.ts` | 9 | 2 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `shared/src/guide.test.ts` | 41 | 6 | 0 | 0.02s | A 主导 | `SECURITY` |
| `shared/src/learner.test.ts` | 4 | 1 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `shared/src/memory.test.ts` | 10 | 11 | 0 | 0.00s | B 主导 | `SECURITY` |
| `shared/src/npc-life.test.ts` | 10 | 21 | 0 | 0.01s | B 主导 | `REGRESSION` |
| `shared/src/npc.test.ts` | 16 | 3 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `shared/src/quiz-attempts.test.ts` | 3 | 2 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `shared/src/quiz-image.test.ts` | 3 | 5 | 0 | 0.00s | B 主导 | `UNIT` |
| `shared/src/quiz-mix.test.ts` | 6 | 21 | 0 | 0.01s | B 主导 | `CONST_ECHO` |
| `shared/src/quiz-source.test.ts` | 18 | 11 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `shared/src/quiz-tier.test.ts` | 3 | 4 | 0 | 0.00s | B 主导 | `UNIT` |
| `shared/src/review-goal.test.ts` | 11 | 6 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `shared/src/scenario.test.ts` | 10 | 2 | 0 | 0.01s | A 主导 | `SECURITY` |
| `shared/src/sources.test.ts` | 6 | 0 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `shared/src/speech.test.ts` | 5 | 6 | 0 | 0.00s | B 主导 | `REGRESSION` |
| `shared/src/spell-chant.test.ts` | 12 | 0 | 0 | 0.01s | A 主导 | `UNIT` |
| `shared/src/spell-kinds.test.ts` | 5 | 0 | 0 | 0.00s | A 主导 | `UNIT` |
| `shared/src/stem-of.test.ts` | 0 | 3 | 0 | 0.00s | B 主导 | `UNIT` |
| `shared/src/term-cards.test.ts` | 18 | 1 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `shared/src/term-graph.test.ts` | 4 | 1 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `shared/src/term-highlight.test.ts` | 16 | 8 | 0 | 0.01s | A 主导 | `COPY` |
| `shared/src/typing.test.ts` | 4 | 1 | 0 | 0.00s | A 主导 | `UNIT` |
| `shared/src/video-route.test.ts` | 7 | 0 | 0 | 0.01s | A 主导 | `UNIT` |
| `web/src/app/Landing.test.tsx` | 2 | 3 | 9 | 3.58s | 删 9 留 5 | `DEMO_CONTENT` `UI` |
| `web/src/app/LandingBrand.test.tsx` | 0 | 0 | 7 | 0.17s | 删除 | `DEMO_CONTENT` `UI` |
| `web/src/app/LandingDemoEntry.test.tsx` | 0 | 4 | 0 | 0.72s | B 主导 | `DEMO_CONTENT` `UI` |
| `web/src/app/LandingLang.test.tsx` | 7 | 6 | 0 | 1.20s | A 主导 | `DEMO_CONTENT` `REGRESSION` |
| `web/src/app/LandingPv.test.tsx` | 0 | 6 | 0 | 0.30s | B 主导 | `DEMO_CONTENT` `COPY` |
| `web/src/app/demo/GraphDemo.test.tsx` | 0 | 0 | 8 | 0.12s | 删除 | `DEMO_CONTENT` `REGRESSION` |
| `web/src/app/demo/PkFlowDemo.test.tsx` | 0 | 0 | 10 | 0.09s | 删除 | `DEMO_CONTENT` `UI` |
| `web/src/app/demo/graph-demo.test.ts` | 0 | 0 | 17 | 0.01s | 删除 | `DEMO_CONTENT` `REGRESSION` |
| `web/src/app/demo/graph-visual.test.ts` | 0 | 0 | 20 | 0.01s | 删除 | `DEMO_CONTENT` `REGRESSION` |
| `web/src/app/entry.test.ts` | 2 | 1 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `web/src/app/shell-lang.test.tsx` | 6 | 1 | 0 | 0.37s | A 主导 | `UI` |
| `web/src/components/GithubLoginButton.test.tsx` | 0 | 2 | 0 | 0.15s | B 主导 | `UI` `RENDER_ONLY` |
| `web/src/components/PixelSidebar.test.tsx` | 3 | 1 | 0 | 0.23s | A 主导 | `ART_ASSET` `UI` |
| `web/src/components/PixelSprite.test.tsx` | 2 | 3 | 0 | 0.05s | B 主导 | `ART_ASSET` `UI` |
| `web/src/components/SceneTransition.test.tsx` | 7 | 0 | 0 | 0.14s | A 主导 | `UI` |
| `web/src/components/TrialNotice.test.tsx` | 1 | 0 | 0 | 0.02s | A 主导 | `REGRESSION` `UI` |
| `web/src/components/TypingInput.test.tsx` | 4 | 1 | 0 | 0.24s | A 主导 | `UI` |
| `web/src/features/chat/ChatComposer.test.tsx` | 12 | 4 | 0 | 0.40s | A 主导 | `UI` |
| `web/src/features/chat/ChatSpeaker.test.tsx` | 4 | 0 | 0 | 0.08s | A 主导 | `UI` |
| `web/src/features/chat/ChatView.guide.test.tsx` | 11 | 6 | 0 | 0.58s | A 主导 | `REGRESSION` |
| `web/src/features/chat/ChatView.quickstart.test.tsx` | 3 | 0 | 0 | 0.28s | A 主导 | `UNIT` |
| `web/src/features/chat/ChatView.test.tsx` | 11 | 1 | 0 | 0.44s | A 主导 | `UI` |
| `web/src/features/chat/ConfirmCard.test.tsx` | 7 | 1 | 0 | 0.07s | A 主导 | `UNIT` |
| `web/src/features/chat/Markdown.test.tsx` | 14 | 0 | 0 | 0.14s | A 主导 | `UI` `SECURITY` |
| `web/src/features/chat/Mascot.test.ts` | 0 | 3 | 0 | 0.00s | B 主导 | `ART_ASSET` |
| `web/src/features/chat/PkInviteCard.test.tsx` | 7 | 0 | 0 | 0.06s | A 主导 | `SECURITY` |
| `web/src/features/chat/QuoteAsk.test.tsx` | 4 | 0 | 0 | 0.06s | A 主导 | `UNIT` |
| `web/src/features/chat/TermCard.test.tsx` | 7 | 4 | 0 | 0.28s | A 主导 | `REGRESSION` |
| `web/src/features/chat/TermText.test.tsx` | 18 | 0 | 0 | 0.30s | A 主导 | `UI` |
| `web/src/features/chat/Welcome.test.tsx` | 2 | 0 | 0 | 0.19s | A 主导 | `UI` |
| `web/src/features/chat/chat-blocks.test.ts` | 8 | 2 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `web/src/features/chat/chat-css-order.test.ts` | 3 | 1 | 0 | 0.01s | A 主导 | `UNIT` |
| `web/src/features/chat/chat-export.test.ts` | 3 | 5 | 0 | 0.00s | B 主导 | `SECURITY` |
| `web/src/features/chat/chat-meta.test.ts` | 9 | 9 | 0 | 0.00s | A 主导 | `COPY` |
| `web/src/features/chat/composer-status.test.ts` | 2 | 4 | 0 | 0.00s | B 主导 | `UNIT` |
| `web/src/features/chat/doc-name.test.ts` | 0 | 6 | 0 | 0.00s | B 主导 | `UNIT` |
| `web/src/features/chat/history-fold.test.ts` | 9 | 11 | 0 | 0.01s | B 主导 | `UNIT` |
| `web/src/features/chat/process-summary.test.ts` | 0 | 5 | 0 | 0.00s | B 主导 | `COPY` |
| `web/src/features/chat/quote-ask.test.ts` | 1 | 7 | 0 | 0.00s | B 主导 | `UNIT` |
| `web/src/features/chat/session-busy.test.ts` | 5 | 6 | 0 | 0.00s | B 主导 | `REGRESSION` |
| `web/src/features/chat/step-fold.test.ts` | 4 | 3 | 0 | 0.00s | A 主导 | `SECURITY` |
| `web/src/features/chat/stream-smooth.test.ts` | 5 | 3 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `web/src/features/chat/thinking-status.test.ts` | 5 | 7 | 0 | 0.00s | B 主导 | `UNIT` |
| `web/src/features/chat/useBusyTitle.test.ts` | 4 | 2 | 0 | 0.02s | A 主导 | `UI` |
| `web/src/features/chat/useConfirmQueue.test.ts` | 5 | 0 | 0 | 0.02s | A 主导 | `UI` |
| `web/src/features/chat/usePkInviteQueue.test.ts` | 12 | 0 | 0 | 0.04s | A 主导 | `UI` `SECURITY` |
| `web/src/features/chat/useQuickStart.test.ts` | 6 | 0 | 0 | 0.03s | A 主导 | `UI` |
| `web/src/features/chat/useScrollAnchor.test.tsx` | 2 | 1 | 0 | 0.14s | A 主导 | `UI` |
| `web/src/features/chat/useSessionDraft.test.ts` | 1 | 4 | 0 | 0.03s | B 主导 | `UI` `RENDER_ONLY` |
| `web/src/features/coach/coach-cards.test.ts` | 7 | 13 | 0 | 0.01s | B 主导 | `UNIT` |
| `web/src/features/continent/ContinentPage.hunt.test.tsx` | 4 | 0 | 0 | 0.58s | A 主导 | `UI` `REGRESSION` |
| `web/src/features/continent/ContinentPage.spawn.test.tsx` | 2 | 0 | 0 | 0.22s | A 主导 | `REGRESSION` `UI` |
| `web/src/features/continent/ContinentPage.test.tsx` | 7 | 2 | 0 | 0.34s | A 主导 | `UI` `REGRESSION` |
| `web/src/features/continent/ExpandDialog.test.tsx` | 4 | 1 | 0 | 0.36s | A 主导 | `UI` |
| `web/src/features/continent/MonsterDialog.test.tsx` | 7 | 0 | 0 | 0.38s | A 主导 | `UI` |
| `web/src/features/continent/NpcDialog.test.tsx` | 4 | 0 | 0 | 0.24s | A 主导 | `UNIT` |
| `web/src/features/continent/SpellBook.test.tsx` | 3 | 0 | 0 | 0.23s | A 主导 | `UI` |
| `web/src/features/continent/SpellChant.test.tsx` | 4 | 0 | 0 | 0.36s | A 主导 | `UI` |
| `web/src/features/continent/continent-partners.test.tsx` | 7 | 0 | 0 | 0.04s | A 主导 | `UNIT` |
| `web/src/features/continent/continent-path.test.ts` | 3 | 2 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `web/src/features/continent/continent-view.test.ts` | 34 | 3 | 0 | 0.05s | A 主导 | `REGRESSION` |
| `web/src/features/continent/monster-art.test.ts` | 3 | 0 | 0 | 0.23s | A 主导 | `UNIT` |
| `web/src/features/continent/spell-chant-view.test.ts` | 4 | 1 | 0 | 0.01s | A 主导 | `COPY` |
| `web/src/features/continent/spell-fx.test.ts` | 6 | 0 | 0 | 1.86s | A 主导 | `UNIT` |
| `web/src/features/drill/WaitDrill.cards.test.tsx` | 6 | 0 | 0 | 0.37s | A 主导 | `REGRESSION` |
| `web/src/features/drill/WaitDrill.recall.test.tsx` | 3 | 0 | 0 | 0.24s | A 主导 | `UI` `REGRESSION` |
| `web/src/features/drill/WaitDrill.test.tsx` | 8 | 0 | 0 | 0.31s | A 主导 | `UI` `REGRESSION` |
| `web/src/features/drill/drill-audio.test.ts` | 4 | 0 | 0 | 0.04s | A 主导 | `UNIT` |
| `web/src/features/drill/drill-prefs.test.ts` | 2 | 2 | 0 | 0.00s | A 主导 | `UNIT` |
| `web/src/features/drill/useDragWindow.test.ts` | 2 | 3 | 0 | 0.00s | B 主导 | `UNIT` |
| `web/src/features/drill/useDrillTrigger.test.ts` | 5 | 0 | 0 | 0.05s | A 主导 | `UI` |
| `web/src/features/game/card-motion.test.ts` | 9 | 0 | 0 | 0.04s | A 主导 | `REGRESSION` `ART_ASSET` |
| `web/src/features/game/card-pixel.test.ts` | 10 | 0 | 0 | 0.02s | A 主导 | `REGRESSION` `ART_ASSET` |
| `web/src/features/guide/GuideBeacon.proactive.test.tsx` | 14 | 4 | 0 | 0.73s | A 主导 | `REGRESSION` |
| `web/src/features/guide/GuideBeacon.test.tsx` | 16 | 2 | 0 | 0.98s | A 主导 | `REGRESSION` |
| `web/src/features/guide/Lantern.test.tsx` | 2 | 5 | 0 | 0.05s | B 主导 | `ART_ASSET` `UI` |
| `web/src/features/guide/guide-copy.test.ts` | 0 | 3 | 0 | 0.00s | B 主导 | `COPY` |
| `web/src/features/guide/guide-layout.test.ts` | 1 | 1 | 0 | 0.00s | A 主导 | `SOURCE_GREP` |
| `web/src/features/guide/guide-store.test.ts` | 11 | 1 | 0 | 0.02s | A 主导 | `SECURITY` |
| `web/src/features/hunt/HuntAlert.test.tsx` | 3 | 0 | 0 | 0.30s | A 主导 | `UI` `REGRESSION` |
| `web/src/features/pk/PkMatch.test.tsx` | 10 | 0 | 0 | 0.33s | A 主导 | `UNIT` |
| `web/src/features/pk/pk-audio.test.ts` | 3 | 0 | 0 | 0.01s | A 主导 | `UNIT` |
| `web/src/features/pk/pk-view.test.ts` | 29 | 18 | 0 | 0.01s | A 主导 | `SECURITY` |
| `web/src/features/pk/usePkEffects.test.tsx` | 2 | 1 | 0 | 0.04s | A 主导 | `UI` |
| `web/src/features/quiz/AiGradeNote.test.tsx` | 3 | 1 | 0 | 0.05s | A 主导 | `UI` `REGRESSION` |
| `web/src/features/quiz/FillBlank.test.tsx` | 2 | 1 | 0 | 0.16s | A 主导 | `UI` |
| `web/src/features/quiz/QuizCard.attempts.test.tsx` | 3 | 0 | 0 | 0.27s | A 主导 | `UI` |
| `web/src/features/quiz/QuizCard.test.tsx` | 5 | 2 | 0 | 0.48s | A 主导 | `UI` |
| `web/src/features/quiz/QuizMaterial.test.tsx` | 3 | 1 | 0 | 0.13s | A 主导 | `UI` |
| `web/src/features/quiz/QuizReview.guide.test.tsx` | 9 | 0 | 0 | 0.13s | A 主导 | `REGRESSION` |
| `web/src/features/quiz/ScenarioPanel.test.tsx` | 3 | 0 | 0 | 0.22s | A 主导 | `UI` |
| `web/src/features/quiz/mix-report.test.ts` | 10 | 12 | 0 | 0.01s | B 主导 | `COPY` |
| `web/src/features/quiz/scenario-view.test.ts` | 4 | 0 | 0 | 0.00s | A 主导 | `SECURITY` |
| `web/src/features/search/global-search.test.ts` | 4 | 6 | 0 | 0.00s | B 主导 | `REGRESSION` |
| `web/src/features/settings/AiHealthCard.test.tsx` | 4 | 0 | 0 | 0.25s | A 主导 | `UI` `REGRESSION` |
| `web/src/features/settings/PlatformChannelCard.test.tsx` | 5 | 1 | 0 | 0.32s | A 主导 | `UNIT` |
| `web/src/features/settings/RoleRow.test.tsx` | 10 | 3 | 0 | 0.08s | A 主导 | `REGRESSION` |
| `web/src/features/settings/SpeechCard.test.tsx` | 5 | 1 | 0 | 0.08s | A 主导 | `UI` `REGRESSION` |
| `web/src/features/settings/WaitDrillCard.test.tsx` | 1 | 0 | 0 | 0.03s | A 主导 | `UI` |
| `web/src/features/sources/ReaderFrame.test.tsx` | 4 | 0 | 0 | 0.15s | A 主导 | `UI` |
| `web/src/features/sources/sources.test.tsx` | 10 | 0 | 0 | 0.16s | A 主导 | `UI` |
| `web/src/features/sources/video-route.test.tsx` | 3 | 0 | 0 | 0.15s | A 主导 | `UI` |
| `web/src/features/terms/LearnerModelCard.test.tsx` | 6 | 1 | 0 | 0.16s | A 主导 | `UI` |
| `web/src/features/terms/ReviewGoalCard.test.tsx` | 5 | 5 | 0 | 0.39s | A 主导 | `REGRESSION` |
| `web/src/features/terms/TermRelations.test.tsx` | 1 | 2 | 0 | 0.05s | B 主导 | `UI` |
| `web/src/features/terms/TermsPage.test.tsx` | 9 | 0 | 0 | 0.35s | A 主导 | `UI` |
| `web/src/features/terms/UndoDeleteBar.test.tsx` | 6 | 0 | 0 | 0.06s | A 主导 | `UI` |
| `web/src/lib/api-ai-ops.test.ts` | 2 | 0 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `web/src/lib/api.test.ts` | 5 | 0 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `web/src/lib/attribution.test.ts` | 15 | 0 | 0 | 0.01s | A 主导 | `REGRESSION` `SECURITY` |
| `web/src/lib/chart-utils.test.ts` | 12 | 4 | 0 | 0.01s | A 主导 | `REGRESSION` |
| `web/src/lib/highlight.test.ts` | 9 | 14 | 0 | 0.01s | B 主导 | `CONST_ECHO` |
| `web/src/lib/image-intake.test.ts` | 0 | 11 | 0 | 0.00s | B 主导 | `CONST_ECHO` |
| `web/src/lib/markdown.test.ts` | 28 | 10 | 0 | 0.02s | A 主导 | `REGRESSION` |
| `web/src/lib/preview-api.test.ts` | 5 | 0 | 0 | 0.01s | A 主导 | `SECURITY` |
| `web/src/lib/preview-store.test.ts` | 4 | 0 | 0 | 0.00s | A 主导 | `SECURITY` |
| `web/src/lib/remend.test.ts` | 5 | 15 | 0 | 0.01s | B 主导 | `UNIT` |
| `web/src/lib/sources-store.test.ts` | 7 | 0 | 0 | 0.01s | A 主导 | `UNIT` |
| `web/src/lib/speech.test.ts` | 20 | 3 | 0 | 0.02s | A 主导 | `REGRESSION` |
| `web/src/lib/sse-seq.test.ts` | 7 | 1 | 0 | 0.00s | A 主导 | `REGRESSION` |
| `web/src/lib/svg-sanitize.fuzz.test.ts` | 3 | 0 | 0 | 2.25s | A 主导 | `SECURITY` |
| `web/src/lib/svg-sanitize.test.ts` | 39 | 0 | 0 | 0.26s | A 主导 | `SECURITY` `REGRESSION` |
| `web/src/lib/svg-utils.test.ts` | 8 | 6 | 0 | 0.09s | A 主导 | `SECURITY` |
| `web/src/lib/video-route-store.test.ts` | 4 | 0 | 0 | 0.01s | A 主导 | `UNIT` |
| `web/src/seo/attribution-links.test.ts` | 4 | 0 | 0 | 0.00s | A 主导 | `REGRESSION` `SEO_SHAPE` |
| `web/src/seo/changelog.test.ts` | 8 | 7 | 0 | 0.02s | A 主导 | `SEO_SHAPE` `REGRESSION` |
| `web/src/seo/og-card.test.ts` | 14 | 4 | 0 | 0.03s | A 主导 | `SEO_SHAPE` `REGRESSION` |
| `web/src/seo/plan-tool.test.ts` | 11 | 5 | 0 | 0.04s | A 主导 | `SEO_SHAPE` `REGRESSION` |
| `web/src/seo/public-hygiene.test.ts` | 9 | 2 | 0 | 0.02s | A 主导 | `SECURITY` `REGRESSION` |
| `web/src/seo/robots-coverage.test.ts` | 3 | 3 | 0 | 0.00s | A 主导 | `SEO_SHAPE` `REGRESSION` |
| `web/src/seo/term-corpus.test.ts` | 13 | 2 | 0 | 0.01s | A 主导 | `SEO_SHAPE` `REGRESSION` |
| `web/src/seo/term-en.test.ts` | 15 | 7 | 0 | 0.03s | A 主导 | `SEO_SHAPE` `COPY` |
| `web/src/seo/term-page.test.ts` | 11 | 6 | 0 | 0.03s | A 主导 | `SEO_SHAPE` `REGRESSION` |
