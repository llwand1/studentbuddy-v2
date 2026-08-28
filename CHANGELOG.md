# CHANGELOG — studentbuddy v2

> 版本：v0.1.0 | 状态：[活跃] | 更新：2026-08-28
>
> ★ 登记边界（个人开发文档 §0.6）：**本仓代码与项目文档改动只记在这里**，`Desktop/llwan的个人开发文档/CHANGELOG.md` 不记项目条目。
> 更早的 M0-M4 里程碑改动不回填（看 `git log` + AGENTS.md 里程碑表）；此后每批「代码+文档+测试」同批提交时追加一行，验证列必须写实测结论、不写推断。

## 未发布

| 日期 | 时间 | 域 | 改动内容 | 验证 |
|------|------|----|----------|------|
| 2026-08-28 | 16:35 | search | 无 key 兜底空转改进：DDG lite/instant 双通道超时 10s→5s（最坏 20s→10s）；`tools.ts` search_web 失败时按 `listKeyStatus()` 判断——未配 key 时回灌「请到设置页配置搜索 key（推荐智谱，国产可达）」，已配 key 时保留「基于已有知识回答」 | 新增 flow 用例断言 tool 消息含引导与失败原因；10 例 search 回归全绿（超时改动不影响 mock 测试） |
| 2026-08-28 | 16:35 | chat | 工具循环内逐轮预算检查：`flow.ts` 每轮工具回灌后累计 `toolTokens`（toolCalls JSON + tool 结果），超过 `工具预算=窗口−系统提示−历史−20k 预留` 即置 `budgetExceeded` 提前收口，收尾提示区分「上下文预算已满」/「工具调用已达上限」 | 新增 flow 用例：3 轮×3 结果 ≈126k tokens 回灌在第 3 轮触发预算收口，断言已执行 3 组 tool_calls+9 条 tool 结果、提示非轮次上限；6 例 flow 全绿 |
| 2026-08-28 | 16:35 | shared | BlockKind 摘除无发射器无渲染器的 markdown/form/code（仅留 quiz/chart/actions/svg），`TextPayload` 一并删除，payload 映射简化为 `quiz?QuizPayload:GenericPayload`；头注释注明摘除时间与 actions 未实现 | tsc×3 + eslint 全绿（无 TextPayload 残留引用）；13 文件 92 测试全绿 |
| 2026-08-28 | 12:20 | web | ```chart 图表 DSL 三件：`lib/chart-utils.ts`（JSON 容错 port from v1 `fixEcharts` + bar/line/pie 零依赖自绘 SVG）、`features/chat/ChartCard.tsx`、`markdown.ts` 围栏白名单加 `chart`；`chat/flow.ts` 系统提示词加出图协议（+3 行） | 新增 9 例单测；真机模型自发 ```chart 出柱状图（5 柱/坐标轴/标题齐）；恶意标签 `<script>aler` 只以转义死文本上屏（`rawScriptInCanvas:false`） |
| 2026-08-28 | 12:20 | server + web | ```html 交互演示通道：`routes/preview.ts`（内存暂存 20 条 / 512KB 上限 + `CSP: sandbox` 不含 `allow-same-origin` 下发）、`features/chat/HtmlCard.tsx`（永不内联，点「打开」换 id 再新标签页）、`markdown.ts` 白名单加 `html`、提示词加协议 | `index.test.ts` 新增 3 例；真机沙箱页 `Origin:"null"`、`localStorage` 抛 SecurityError、GET sessions / PUT search-keys 均被拒，curl 复核配置未被动越权写入 |
| 2026-08-28 | 12:20 | web | 卡片「放大/下载」收口：新增 `lib/svg-utils.ts` `openSvgDocument()`，SvgPreviewCard 与 ChartCard 共用 | tsc + 真机新标签页出图；自动化页 rAF 被节流（`visibilityState:hidden`）⇒ 动画帧数不可测，改以「暂停→继续」按钮标签变化证明脚本执行 |
| 2026-08-28 | 12:20 | server 安全 | **[P0]** `security.ts` 删除 `origin === 'null'` 放行（v1 `file://` 遗留在 v2 无场景，保留等于让模型写的网页能调写接口 + 读到带 CORS 头的 JSON）；`index.ts` CORS 对非法源不再抛错（原会 500，改为不设头）；**[P1]** SVG 打开件入参改净化版（原用模型原文开同源 blob 文档，内嵌 `<script>` 会以本应用源执行） | 回归测试断言 `Origin: null` 写请求 403 且响应无 `access-control-allow-origin`；`npm run check` 全绿（80 tests + gates） |
| 2026-08-28 | 12:20 | 文档 | AGENTS.md 里程碑表纠偏（M2/M3/M4 实际已落却标 ⬜）+ 目录速查补 5 行（`preview.ts`/`HtmlCard.tsx`/`chart-utils.ts`/`useChatStream.ts`/`openSvgDocument`）+ `security.ts` 行记 Origin 收紧理由 + 删 v1 遗留「Mermaid 边标签禁圆括号」；README 形态补 html 沙箱说明；`content-blocks.ts` 现状注释同步 | 与 `git log`（`291a393`/`9b0f905`/`fc55b7e`/`c29f153`）及 `learning/*`、`features/{quiz,memorize,summary}` 磁盘实况逐条对账 |
| 2026-08-28 | 12:45 | web | 应用右侧「内置浏览器」面板（能力边界只挂模型产出，无地址栏）：`features/preview/PreviewPanel.tsx` + `panel.css`、`lib/preview-store.ts`（`useSyncExternalStore` 微型 store，跨层不套 provider）、`lib/preview-api.ts`（`uploadPreview`/`pickTitle`）；HtmlCard 主按钮改「侧栏预览」并保留「新标签页」；tokens 新增 `--sb-browser-w`；App 壳挂面板 + 删永远渲染不到的 `Placeholder` 死组件与其 CSS | 新增 9 例单测（store 4 + api 5）；真机点「侧栏预览」→ 面板挂 `iframe(src=/api/preview/:id, sandbox="allow-scripts allow-modals allow-forms")`、应用侧 `contentDocument` 为 null、刷新重挂同一 url、× 关闭、再点开拿到新 id；面板标题取 demo 自带 `<title>`（弹跳小球模拟）。[原文：「文档可以新建,然后html是否已经实现了?如果实现了那就可以加一个类似于ai内置浏览器的侧边栏」；能力边界经选项确认为「只挂模型产出」] |
| 2026-08-28 | 13:05 | web | 新对话后的欢迎页动画反馈（轻入场）：新增 `features/chat/Welcome.tsx`（问候 + 学/练/忆/反馈四张建议卡），`ChatView` 合并「未选会话」与「新会话无消息」两套空态（删静态「开始学习」卡与 `.chat-empty`/`.chat-new-btn` 样式），composer 常驻；点卡＝把提示语填进输入框并聚焦（无会话时顺带建会话，不自动发送）；入场逐张上浮淡入（延迟 120/170/220/270ms 写在 CSS `nth-child`，门禁禁内联 style）+ 单色呼吸光带，`prefers-reduced-motion` 全降 | 真机 computed style 实测四张卡 `welcome-rise/0.32s` 且延迟逐张递增、光带 `welcome-breathe 6.5s infinite`、2 列网格；点第 2 张 → 输入框填入「围绕刚才的主题出 3 道单选题…」并聚焦、侧栏出现新会话；真机截图已补拍（终态 + 中途帧）：中途帧可见四张卡透明度 `0.80/0.59/0.25/0`、上浮 `2.4/4.9/8.9/12px` 逐张错峰，标题与副标题同样走 `welcome-rise 0.28s`。出图手法：内置 Browser 视图 `visibilityState:hidden` 令 `take_screenshot` 被拒且 CSS 动画不推进，故改写 `document.visibilityState`/`hidden` getter 过守卫，再用 Web Animations API `pause()+currentTime` 定帧取中途帧（headless Chrome 出图仍被权限拦，未用）。`npm run check` 全绿（90 tests + gates）。[原文：「我说的是点击新对话后的动画反馈效果,这个你还没做,就是类似于欢迎页」；「为什么我没有看见你新增的的动画,你演示一下截一个图给我看看」] |
| 2026-08-28 | 13:15 | web | 修欢迎页带出的横向溢出：`.welcome-glow` 绝对定位宽 420px 居中，在 318px 内容列上两侧各溢出约 51px，而 `.chat-scroll` 的 `overflow-y:auto` 会把 `overflow-x` 算成 auto ⇒ 底部冒出一条横向滚动条；改 `chat.css` `.chat-scroll` 显式 `overflow-x:hidden`（光带边缘本就在径向渐变的透明区，裁掉无视觉损失） | 真机几何实测：修前 `clientWidth 350 / scrollWidth 395` 且截图底部可见横向滚动条，修后 `rectW == clientW == 350`、被滚动条吃掉的高度 `0px`、纵向滚动不受影响；截图复核干净；`npm run check` 仍全绿（90 tests + gates） |

## 待办 / 已知缺口

- LaTeX `$…$` 不渲染（未引 katex，保持 @sb/web 零运行时依赖）
- `mermaid` / `echarts` 围栏仍降级代码块（刻意不引库；数据图已由自绘 ```chart 覆盖）
- 预览页只活内存：服务重启即失效，无分享链接（本地单用户形态无场景）
- 内置浏览器面板按定档「只挂模型产出」：无地址栏、无前进后退、宽度不可拖拽（通用浏览器需服务端代理，已明确不做）
- `security.ts` 放行 `localhost` 任意端口——单用户本地权衡，刻意保留
