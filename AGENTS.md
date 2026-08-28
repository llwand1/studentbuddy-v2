# AGENTS.md — studentbuddy v2 项目导航

> AI 改本仓代码的第一入口。**v1 的 gateway/office 命名/双轨工具/工作区全家桶一律不存在**——开工前先读规划。

## 形态声明（最高优先级）

- 纯本地 Web：`api :18791(仅 127.0.0.1) + web :5173`；SQLite WAL；单用户
- **npm workspaces 三包**：`@sb/shared`（契约）/ `@sb/server` / `@sb/web`
- 端口被 v1 占用时：`SB_PORT=18792 SB_PROXY_TARGET=http://127.0.0.1:18792`

## 六条 ADR（凌驾模块设计，全文见规划 §2.0）

1. 需求为纲：模块必须答「服务学习闭环哪一环」
2. 简洁优先：安全做必要最小（密钥加密/Origin/SSRF+白名单三件），无审批门无策略引擎
3. 域自治：chat/quiz/memorize/feedback 只经 shared 契约 + 事件总线交互
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
| `packages/shared/src/domain.ts` | Session/Message/RoleBinding(演进①)/MemorizeItem(SRS 字段) |
| `packages/server/src/index.ts` | Express 入口（安全头/CORS/originCheck/2MB 限制） |
| `packages/server/src/chat/tools.ts` | 单轨工具注册表（当前仅 `search_web`；新增工具=加定义+加 `step` 上报） |
| `packages/server/src/search/index.ts` | 搜索聚合（Exa/Tavily/智谱按 key 并行 → 全无 key 走 DuckDuckGo；24h 缓存；SSRF 护栏） |
| `packages/server/src/routes.ts` | 路由含 `settingsRouter`（搜索 key 读写 + 连通自检，密钥不出接口） |
| `packages/server/src/security.ts` | 安全三件之 Origin 校验 |
| `packages/web/src/app/App.tsx` | 应用壳：180px 侧栏（五环导航） |
| `packages/web/src/styles/tokens.css` | 设计 token 唯一事实源（改它必须同步设计系统 demo） |
| `packages/web/src/components/icons.tsx` | SVG line-icon 基座（禁 emoji） |
| `packages/web/src/lib/markdown.ts` | 零依赖正文解析：块级切分 + 行内标记；围栏白名单只有 `svg`，其余语言一律代码块（禁裸注入） |
| `packages/web/src/lib/svg-utils.ts` | SVG 净化（DOMParser 快路径 + 线性正则回退）+ L1 自愈（补闭合/钳宽/主题色），port from v1 |
| `packages/web/src/features/chat/Markdown.tsx` | 助手正文渲染器（唯一注入点在 SvgPreviewCard 的净化后 SVG，其余走 React 转义） |
| `tools/gates/check.mjs` | 行数/内联样式/any 门禁 |

## 里程碑

| 阶段 | 状态 |
|------|------|
| M0 地基（脚手架/门禁/token/图标/文档骨架） | ✅ 2026-08-23 |
| M1 对话核（SSE/单轨工具/模型路由/内容块流） | 🔶 2026-08-28：SSE+单轨工具循环+角色路由真机通过；正文 Markdown + SVG 卡片渲染上屏（零依赖）；SSE `block` 事件通道仍只服务 quiz |
| M2 练+析（出题/题库/golden dataset） | ⬜ |
| M3 忆（SRS 引擎） | ⬜ |
| M4 反馈+迁移+定稿 | ⬜ |

## 已知约束

- dev 端口与 v1 冲突时用 `SB_PORT` 切换，**不杀 v1 进程**
- **免 key 兜底在本机网络不可用**：2026-08-27 实测 `lite.duckduckgo.com` 与 `api.duckduckgo.com` 均超时（直连被阻断，baidu/agnes 正常 200/401）→ 三路全挂约 20s 且零结果。要让 `search_web` 真出结果必须在设置页配 key（智谱国产可达，优先试）；挂代理另议
- vite 监听 IPv6 `::1`：本机验证用 `http://localhost:5173`（127.0.0.1 不通）
- Mermaid 边标签内禁圆括号（解析冲突）
- **行内公式不渲染**：`$a^2+b^2=c^2$` 按原文显示（未引 katex，保持 @sb/web 零运行时依赖）
- **demo 式动画未实现**：`html` / `mermaid` / `echarts` 通道两版都没做——围栏一律降级成代码块；html 交互通道需要先做 iframe 沙箱 + CSP 分级，是本项最大的安全设计成本
