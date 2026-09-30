# 像素 UI 与游戏化功能的接缝

本次统一现役页面的像素视觉：主题、图标、面板、按钮、欢迎场景、手机导航与分享图。没有新增玩法、游戏数值或数据库迁移。

## 视觉入口

- `styles/tokens.css`：纸色底、紫色主色、墨色轮廓、硬阴影，以及字体/间距。
- `styles/pixel-ui.css`：现役控件与面板、焦点、按压反馈、减少动态效果。
- `styles/pixel-shell.css`：应用壳、聊天、欢迎页、手机导航、词条与设置的窄屏布局；公开页面仅改样式。
- `styles/pixel-scene.css` / `chat/PixelScene.tsx`：纯装饰营地。它不代表知识大陆已经实现。
- `components/PixelSidebar.tsx`：包装当前导航、历史和账号。导航项仍由 `app/nav.ts` 决定。
- `seo/og-card.ts`：分享图样式使用相同调色板，图片通过 `npm run og:shots` 重建。

## 多分支合流

卡牌分支的数值、奖励与事件仍归其功能实现；本次不重复实现。后续卡牌/大陆接入时，合并 App、main 和导航的必要小段，不用旧整文件覆盖新基线。已删除的笔记/今日总结页面不恢复，题库删除改动也应保留其删除结果。

像素面板使用具体类选择器，避免给未来游戏组件的每个子元素强制套边框或改布局。新增游戏组件可消费主题 tokens，自己的动效预算仍由功能实现控制。系统减少动态效果偏好会关闭动画与平滑滚动。

知识大陆的领地扩散与怪物侵占已接入，但它们是**派生量**（由逾期天数与词条状态算出），不是存档：视觉层只负责画，不得凭演出另算领地范围或奖励。历史副本与 AI agent 地图生成仍属后续功能。Avatar、卡牌数值和 XP/连签有各自事实源，视觉组件不能凭演出另算奖励。

桌面“StudentBuddy游戏化改动”目录用于汇报和索引，仓内契约、CHANGELOG、测试方案、实际 PR/提交仍是对应事实的来源。未合并分支或原型不得标为已上线。

## 回归

新增回归覆盖手机导航打开/关闭/焦点返回、欢迎卡只填草稿、装饰不进入交互顺序、欢迎空态滚动、历史阅读与减少动态效果跳转。完整验证遵循 `npm run build`、`npm run check` 与指标对账。

## 2026-09-26 统一底稿更新

用户将像素改造定为最高画风优先级。本分支保留既有像素主题，合入题库删除 `72ca2c5`、卡牌 `2b61272` 与知识大陆 `92dc58c`，保留原作者与提交历史。卡牌几何统一取像素 tokens；大陆怪物与收复粒子改为整数方块，减少动态效果偏好下直接显示最终地形。

本轮之后知识大陆已经支持词条地图、五题型（含情景题）复习挑战、图鉴、角色走位与领地扩散，不再属于纯视觉预留；历史副本、AI agent 地图生成与 Boss/PK 联动仍待实现。地图宝箱复用既有每日宝箱账本与开箱仪式，不另算一套稀有度。卡牌保留既有稀有度、奖励账本与迁移，不另算一套游戏数值。

题库、笔记、今日总结、学习流与旧知识图保持下线。落地页改为介绍卡牌和知识大陆，旧知识图演示不再注册。构建与全量检查覆盖合流结果；不代表线上已经部署。

## 2026-09-27 转场与壳层微交互

本批只加**动效层**，不加玩法、不加数值、不加迁移；服务端零改动。

- `styles/tokens.css`：三档动效时长 `--sb-motion-fast / base / scene`（120 / 220 / 320ms）。全站动效只认这三档，像素风一律 `steps()` 阶梯计时、不用缓动曲线。
- `styles/pixel-motion.css`：共享关键帧（`sb-rise-in` / `sb-fade-in` / `sb-drawer-in` / `sb-pop`）、场景舞台与幕布、启动画面。四条口径写在文件头：只用 steps、只动 transform/opacity/clip-path、**默认态即终态**（减少动态效果关掉动画后不会留下一块布）、纯装饰不占焦点不接指针。
- `components/SceneTransition.tsx`：场景转场。应用壳 `<main>` 的四个视图切换与 `main.tsx` 的落地页 ↔ 应用 ↔ 对战页换根都走它。内容**同步**换、幕布盖在上面从上到下掀开；首次挂载不铺布；`prefers-reduced-motion` 命中时幕布节点根本不渲染。场景层 `display: contents` 不产生盒子，各页面原有的 flex / height 口径一字不改。
- `components/BootScreen.tsx`：`/api/auth/me` 未回时的启动画面，默认透明、400ms 后才现身——快路径与原先的空白无异，慢路径不再是一屏空白。
- `styles/pixel-shell.css` 追加的微交互：导航项悬停图标顶一格 / 按下沉 1px / 激活弹一跳，团子悬停抬头，「新对话」加号悬停转 90°，历史会话行悬停右移一格，手机抽屉阶梯滑入 ＋ 遮罩跳变现身，自己发出的消息浮入一格（★ 只挂 user 行：助手行从流式气泡换成落成消息是两个节点的替换，挂了会闪）。

回归：`src/components/SceneTransition.test.tsx`（7 例，登记见 TEST-PLAN §3 顶部）。视觉本身属真机目检：幕布掀开、抽屉滑入、导航弹跳已在无头 Chromium 1280×800 与 390×780 两档连拍确认，减少动态效果档确认零幕布节点。

## 2026-09-28 对话页：篝火对谈皮 + 特效层

起因：对话页是全站唯一还长着「默认聊天软件」模样的页面——无头像、无铭牌、细线气泡、缓动曲线、白渐变卡，和大陆 / 词条（卡面与卡墙）/ 设置那套黑铁金线放在一起像两个产品。本批只加**外观层与动效层**，不加玩法、不加数值、不加迁移，服务端零改动，数据流零改动（`useChatStream` / `MessageRow` 的分支逻辑一行没动）。

- `styles/grimoire-chat.css`（新）：对话页整张皮，按 `grimoire.css` 的语言写——黑铁框 + 双金线（`--gr-frame`）、血红锻铁牌、压印标题、荆棘分隔。**所有效果都是 CSS**，组件只翻 class。层内分区：
  - 会话铭牌头 `.chat-head`：角标 `CAMPFIRE · 篝火对谈` + 会话标题 + 轮数铁牌 `N 轮`，与 `continent-head` / `term-head` 同一套；空会话（欢迎页）不渲染。
  - 说话者铭牌 `.chat-speaker`：金框像素头像 + 名字 + 英文角标。助手＝团子（复用 `Mascot`），用户＝勇者（`hero-sprites.ts` 的 `HERO_MAP`——落地页序章与知识大陆里走位的就是它，**勇者在哪儿都是同一个勇者**）。`.live` 态：头像框亮金线、团子按拍跳一格、一粒余烬上飘、「吟唱中」按拍闪。
  - 助手正文 `.chat-bubble.md`：铁框面板 + 左侧符文轨（`::before` 一列金点）+ 落成时叠一层亮金边三拍淡出（`::after`，`ch-frame-settle` 只动 opacity）。流式中同一个 `::after` 改做从上到下的扫描线（`ch-scan` 只动 transform），外加金色方块光标。★ 助手节点从流式气泡换成落成消息是两个节点的替换，所以**不给助手行挂进场动画**（会闪一下），只闪面板边与印章。
  - 用户消息 `.chat-bubble.user`：血红锻铁牌，整行进场 `ch-plate-drop`（从上落下两格坐实）+ 四角火星（`::before/::after` 各三粒，420ms 内熄，熄灭位＝默认位）。
  - 等待态 `.chat-typing`：三粒符文按节拍轮流点亮（不再是圆点弹跳）；思考面板 / 工具步骤 / 任务清单改成同色系的任务日志条。
  - 回合印章 `.chat-round-meta`：铁牌 + 余烬点，`sb-pop` 弹出（复用 `pixel-motion.css` 关键帧）。
  - 输入框 `.chat-composer`：铁框 + 双金线 + 两枚角饰；`.busy`（生成中）两枚角饰一明一暗交替呼吸（`ch-charge` 只动 opacity），停止键血红。
  - Markdown 覆盖：`h1/h2` 走显示字体 + 压印阴影、`h2` 前缀 ◆、代码块改成像素窗（标题栏三粒色块 + 语言名 + 铁框）、表格金字表头、引用块红边、行内代码铁底。题卡 / 情景卡进场 `ch-unroll`（clip-path 自上而下展开）。
  - 底部一层篝火余光 + 六粒余烬 7s 一循环上飘：压在 `z-index:-1`（`.chat-view` 自成层叠上下文），飘在面板**背后**、只从缝隙露出，不压字。
- `components/PixelSprite.tsx`（新，通用）：字符画 + 调色板 → SVG，同行同色合并成一个 `<rect>`，`crispEdges`，`aria-hidden`，颜色走 `fill` 属性（不是内联 style）。只在整数倍尺寸下用。**定义与引用分家**：`PixelSpriteDefs` 把点阵画进一份零尺寸的 `<symbol id>`（挂一次即可，对话页由 `ChatSpeakerDefs` 挂在 `.chat-view` 顶部），`PixelSpriteUse` 每处只出 `<svg><use href="#id"/></svg>` 两个节点——勇者 104 个色块不再随每条用户消息复制一遍。团子（`Mascot`）仍每条实体渲染：它有自己的眨眼动画，`<use>` 的影子树里动不了。
- `features/chat/ChatSpeaker.tsx`（新）：铭牌组件，`role` + `live` 两个 prop；名字对辅助技术可读，头像 / 角标 / 「吟唱中」装饰隐藏。挂在 `MessageRow`（两种角色）、`ChatView` 流式行、`Thinking` 等待行三处。
- `ChatView.tsx` 多一个 `.chat-head`（302 行，门禁 ≤320）；`ChatComposer.tsx` 根节点多一个 `busy` class。

四条口径照旧：只用 `steps()`；只动 transform / opacity / clip-path（12 组关键帧逐一核过：凡是想「闪一下边框」的地方都改成叠一层伪元素动 opacity，不直接动 box-shadow / background）；**默认态即终态**——`prefers-reduced-motion` 由 `pixel-ui.css` 全局关掉动画后，余烬 `opacity:0` 直接不存在、扫描线停在框外、火星停在熄灭位，不留任何遮挡；装饰层一律 `pointer-events:none` 不占焦点。

文案仍全中文：功能页不双语是 `app/landing-lang.tsx` 头注范围决策 ① 的知情选择，铭牌上的 `BUDDY` / `HERO` / `CAMPFIRE` 是角标不是文案（与大陆 HUD 同款），不算半中半英。

回归：`src/components/PixelSprite.test.tsx`（5 例）、`src/features/chat/ChatSpeaker.test.tsx`（4 例）、`ChatView.test.tsx`（＋3 例：铭牌头／铭牌／符号定义的挂线），登记见 TEST-PLAN §3 顶部；`ChatComposer.test.tsx` / `Markdown.test.tsx` 例数不变。视觉属真机目检，已在无头 Chromium 1360×860（含 `prefers-reduced-motion: reduce` 一档）与 390×844 @2x 连拍核对：发送 → 等待（符文轮亮）→ 流式（扫描线 + 光标 + 吟唱中）→ 落成（印章 pop）→ 悬停脚注 → 编辑重发 → 出题（题卡展开）→ 回到顶部；减少动态效果档零残留遮挡；窄屏隐藏角标与角饰、铭牌与面板不溢出。

复查修补（同日，真机连拍第二轮，覆盖此前没走到的态：思考面板 → 任务清单 → 工具步骤（running／done／展开载荷）→ 选择卡 → 确认卡 → 生成失败 → 中途停止 → 题卡作答／复盘；390 与 700 两档窄屏；`prefers-reduced-motion`）：① 装饰性伪元素字符一律 `content: 'x' / ''`（读屏不念 `+`／`✦`／`◆`）；② `N 轮` 铁牌无用户消息时不渲染；③ 消息内过程面板各占一行——此前思考牌与任务牌并排、被 `align-items: stretch` 拉成一只只有头行的空盒；④ `.chat-step` 的工具载荷跑到行头右侧、行头被垂直居中——根因是 **`chat.css` 写 `display: flex`、`chat-extras.css` 写 `display: block` 想覆盖它，而两份文件谁先进产物取决于模块图**（`ChatView` 先 import 面板组件、后 import `./chat.css` ⇒ 基础层反而排在后面、flex 赢）。**在源头修掉**：`chat.css` 的 `.chat-step` 本就该是块容器（行由 `.chat-step-row` 承担），`chat-extras.css` 不再二次声明；`ChatView` 把 `./chat.css` 提到本目录组件 import 之前；新增 `chat-css-order.test.ts` 锁两条契约——两份文件对同一选择器**不得再声明同一属性**（同值也不许）、基础样式 import 必须在前——主题层不再钉 `display`。载荷 `<pre>` 亮底残留 `rgba(0,0,0,.03)` 换成黑底金暗线；⑤ 消息脚注 `margin-top: 6px` 并进定位层——面板是 `position: relative` 带 5px 黑色偏移投影，会盖住紧贴其下的脚注按钮顶边；⑥ running 工具步骤边线改金（此前被 `chat.css` 的主色红压着，与「吟唱中」的金色 live 语义打架）。实测：减少动态档 `document.getAnimations()` 全程为 0；正常档流式期 10 条动画（团子眨眼／跳、火星、扫描线、光标、充能、停止键脉冲等），落成 3 秒后只剩团子眨眼与背景余烬两条闲置循环；`<use>` 勇者在 DPR 1／2 下均为整像素边（与实体 rect 渲染逐像素一致）。

## 2026-09-29 等待时刷词弹窗 + 五款命中特效

起因：等 AI 回复的空档要能刷词（`docs/WAIT-DRILL-SPEC.md`），弹窗得像本仓的东西，不像一个套壳的背单词 App。

- `features/drill/drill.css`：整张弹窗按 `grimoire.css` 的语言写——黑铁框双金线舞台（`--gr-frame-hi`）+ 两枚角饰、血红主按钮 / 铁灰次按钮（与大陆弹窗同款）、金字战绩铁牌、四选一两列大按钮（键位牌在左，答完正确项绿亮 / 选错红亮 / 其余压暗）、拼写卡首字提示用显示字体压印。全部 `--sb-*` / `--gr-*` 变量，无内联样式；390px 下选项改一列、键位脚注隐藏。
- `features/drill/drill-fx.css` + `DrillFx.tsx`：答对五款轮换（每答对一次换下一款，"变化"本身是奖励）——**斩击**两道白刃 `clip-path` 斜切 + 白闪、**爆裂** 12 粒方块沿 `:nth-child` 写死的方向四散、**星芒**四角星 `clip-path` 撑开 + 冲击环、**电光** SVG 锯齿闪电 `clip-path` 自上劈下 + 蓝闪两拍、**血墨**不规则多边形墨点炸开 + 三滴飞溅；答错**碎裂**（SVG 红裂纹 + `.drill-card.miss` 抖六拍）；连击 5 的倍数叠「COMBO ×N」大字。
- 四条口径照旧：只用 `steps()`；只动 transform / opacity / clip-path（"闪一下"一律叠伪元素动 opacity）；**默认态即终态**（粒子静止 = `opacity:0`，reduced-motion 全关后什么都不剩）；`pointer-events:none` + `aria-hidden`。
- 音频不进 CSS：`drill-audio.ts` 用 Web Audio 合成 8-bit 配乐与七款音效（零音频文件，仓库对外「静态产物无二进制素材」的承诺不破），静音记本机。

回归：`features/drill/WaitDrill.cards.test.tsx` 第 ② 例锁五款按次轮换 + COMBO 大字；`drill-audio.test.ts` 锁配乐调度与静音口径。
