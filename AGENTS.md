# AGENTS.md — studentbuddy v2 项目导航

> AI 改本仓代码的第一入口。**v1 的 gateway/office 命名/双轨工具/工作区全家桶一律不存在**——开工前先读规划。

## 形态声明（最高优先级）

- 纯本地 Web：`api :18791(仅 127.0.0.1) + web :5173`；SQLite WAL；单用户
- **npm workspaces 三包**：`@sb/shared`（契约）/ `@sb/server` / `@sb/web`
- 端口被 v1 占用时：`SB_PORT=18792 SB_PROXY_TARGET=http://127.0.0.1:18792`

## 六条 ADR（凌驾模块设计，全文见规划 §2.0）

1. 需求为纲：模块必须答「服务学习闭环哪一环」
2. 简洁优先：安全做必要最小（密钥加密/Origin/SSRF+白名单三件），无审批门无策略引擎
3. 域自治：chat/quiz/terms/feedback 只经 shared 契约 + 事件总线交互
4. 失败隔离：次级功能失败只记日志；LLM 输出 normalize+降级不崩
5. 体验契约：操作必有成功/失败/进行中三态，禁止静默
6. 数据容错：schema_version 逐语句迁移；迁移永不触碰 v1 原库

## 工程红线（CI 强制）

- 单文件：server ≤400 行 / web 组件 ≤300 行
- 禁内联 `style={{`（用 tokens.css token）；禁 `any`
- `npm run check` = tsc×3 + eslint + vitest + gates，全绿才许提交

## 目录速查

| 路径 | 职责 |
|------|------|
| `packages/shared/src/sse-events.ts` | SSE 事件契约（先登记再实现，同步 docs/SSE-CONTRACT.md） |
| `packages/shared/src/content-blocks.ts` | 内容块协议（演进③；新卡片=登记 kind+注册渲染器） |
| `packages/shared/src/domain.ts` | Session/Message/RoleBinding(演进①)/TermItem(词条库字段) |
| `packages/server/src/index.ts` | Express 入口（安全头/CORS/originCheck/2MB 限制） |
| `packages/server/src/chat/tools.ts` | 单轨工具注册表（当前仅 `search_web`；新增工具=加定义+加 `step` 上报） |
| `packages/server/src/search/index.ts` | 搜索聚合（Exa/Tavily/智谱按 key 并行 → 全无 key 走 DuckDuckGo；24h 缓存；SSRF 护栏） |
| `packages/server/src/routes.ts` | 路由含 `settingsRouter`（搜索 key 读写 + 连通自检，密钥不出接口） |
| `packages/server/src/routes/terms.ts` | 词条库路由：`/api/terms` CRUD + `POST /extract`（AI 抽取入库）+ `/domains`（统计） |
| `packages/server/src/security.ts` | 安全三件之 Origin 校验（**不放行 `'null'`**：sandbox 预览页的源就是字符串 null，放行等于让模型写的网页能调写接口） |
| `packages/web/src/app/App.tsx` | 应用壳：180px 侧栏（五环导航） |
| `packages/web/src/styles/tokens.css` | 设计 token 唯一事实源（改它必须同步设计系统 demo） |
| `packages/web/src/components/icons.tsx` | SVG line-icon 基座（禁 emoji） |
| `packages/web/src/lib/markdown.ts` | 零依赖正文解析：块级切分 + 行内标记；围栏白名单只有 `svg` / `chart` / `html`，其余语言一律代码块（禁裸注入） |
| `packages/web/src/lib/svg-utils.ts` | SVG 净化（DOMParser 快路径 + 线性正则回退）+ L1 自愈（补闭合/钳宽/主题色）+ `openSvgDocument` 下载/新标签页（入参必须是**净化后**的 SVG，blob 文档继承本应用源），port from v1 |
| `packages/web/src/lib/chart-utils.ts` | 图表 DSL：```chart 围栏 JSON 容错（port from v1 fixEcharts）+ bar/line/pie 零依赖自绘 SVG，渲染卡在 features/chat/ChartCard.tsx |
| `packages/server/src/routes/preview.ts` | ```html 预览出页：内存暂存（上限 20 条 / 512KB）+ `CSP: sandbox`（无 allow-same-origin ⇒ 源为 null）；本页 `X-Frame-Options` 由全局 DENY 放宽到 SAMEORIGIN（侧栏面板要嵌它，外站仍嵌不到） |
| `packages/web/src/features/chat/HtmlCard.tsx` | html 卡片：永不内联，点「侧栏预览」送右侧面板、「新标签页」走同一上传路径，三态齐备（进行中/失败/成功） |
| `packages/web/src/features/preview/PreviewPanel.tsx` | 应用右侧内置浏览器面板：只挂 `/api/preview/:id` 沙箱文档，iframe 再叠 `sandbox` 双保险；**无地址栏**（不承诺打开任意 URL） |
| `packages/web/src/lib/preview-store.ts` + `preview-api.ts` | 面板状态（`useSyncExternalStore` 微型 store，跨层不套 provider）与 `uploadPreview()`/`pickTitle()` |
| `packages/server/src/learning/` | 练+忆域：quiz 出题引擎 / **terms AI 词条库**（`[TERMS]` 协议抽取 / `UNIQUE(term,domain)` 入库 / 相关性检索注入 / usage 计数）/ activity 打卡（srs+memorize 已废弃，2026-09-01） |
| `packages/web/src/features/quiz·terms·summary/` | 题库 / 词条库（TermsPage 列表管理页）/ 今日总结三屏 |
| `packages/web/src/features/chat/useChatStream.ts` | SSE 生命周期 + 流式文本/step/block 累积编排（前端加一种 SSE 事件渲染从这里接） |
| `packages/web/src/features/chat/Markdown.tsx` | 助手正文渲染器（注入点只有 SvgPreviewCard / ChartCard 里净化后的 SVG，其余走 React 转义） |
| `packages/web/src/features/chat/Welcome.tsx` + `Mascot.tsx` | 空会话欢迎页（「未选会话」与「新会话无消息」共用一套；建议卡只填输入框不自动发送）；吉祥物是 **16×16 像素点阵**（`SPRITE` + 眨眼合帧 `LID` 由 `toRuns()` 并成 `<rect>`，`crispEdges` 且只按 4× 整数倍放大）；配色档位与 `steps()` 动效时序在 `chat.css`（组件内不写内联 style），`Mascot.test.ts` 用 `spriteErrors()` 钉住点阵自洽（行宽／字母登记／合帧必须正压眼位） |
| `tools/gates/check.mjs` | 行数/内联样式/any 门禁 |

## 里程碑

| 阶段 | 状态 |
|------|------|
| M0 地基（脚手架/门禁/token/图标/文档骨架） | ✅ 2026-08-23 |
| M1 对话核（SSE/单轨工具/模型路由/内容块流） | 🔶 2026-08-28：SSE+单轨工具循环+角色路由真机通过；正文 Markdown + SVG 卡片 + chart 数据图内联渲染、```html 走右侧内置浏览器面板（沙箱 iframe，也可新标签页）；卡片带下载/放大，零依赖；SSE `block` 事件通道仍只服务 quiz |
| M2 练+析（出题/题库/golden dataset） | ✅ 2026-08-23：出题引擎/题库/QuizCard/逐题统计/薄弱点 |
| M3 忆（AI 词条库） | ✅ 2026-08-23：SM-2 调度 + 背背背翻卡；**2026-09-01 重构忆域 v2**：旧 SRS 翻卡废弃（源码删除、数据清空），改 AI 术语库——对话/手动双通道抽词入库、回复前软性注入优先使用、回复后自动计数 |
| M4 反馈+迁移+定稿 | 🔶 2026-08-23：反馈环（事件总线/XP连签/今日总结/近7天趋势）+ v1 全量数据迁移工具已落；定稿未做 |

## 已知约束

- dev 端口与 v1 冲突时用 `SB_PORT` 切换，**不杀 v1 进程**
- **免 key 兜底在本机网络不可用**：2026-08-27 实测 `lite.duckduckgo.com` 与 `api.duckduckgo.com` 均超时（直连被阻断，baidu/agnes 正常 200/401）→ 三路全挂约 20s 且零结果。要让 `search_web` 真出结果必须在设置页配 key（智谱国产可达，优先试）；挂代理另议
- vite 监听 IPv6 `::1`：本机验证用 `http://localhost:5173`（127.0.0.1 不通）
- **行内公式不渲染**：`$a^2+b^2=c^2$` 按原文显示（未引 katex，保持 @sb/web 零运行时依赖）
- **重型图库仍未实现**：`mermaid` / `echarts` 围栏照旧降级代码块（刻意不引库）；数据图走自绘 ```chart，交互动画走 ```html 沙箱预览（2026-08-28 已上，真机验证预览文档源为 `null`、应用侧读不到其 DOM、读写接口均被拒）
- **预览页只活内存不落盘**：上限 20 条、服务重启即失效，页内提示回对话重新点「侧栏预览」；不做分享链接（本地单用户形态无场景）
- 面板宽 `min(--sb-browser-w, 46vw)` 且 `flex-shrink: 0`：窗口很窄时优先保面板、对话区被挤。未做可拖拽分隔条（内联 style 被门禁禁，需走 CSS 变量 + `documentElement.style.setProperty`，等真需要再加）
