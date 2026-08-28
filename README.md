# studentbuddy

> 本地优先的 AI 学习助手（学习版豆包）：**学 → 练 → 析 → 忆 → 反馈**闭环。
> v2 全新重写仓——v1（`Desktop/studentbuddy`）已冻结，本仓按「需求为纲、简洁优先」六条 ADR 从零搭建。

## 形态

- 纯本地 Web 服务：`api(Express :18791 仅 127.0.0.1) + web(Vite :5173)`，浏览器访问
- 单用户、零 AI 写盘、SQLite 单文件（WAL）
- 助手正文按 Markdown 排版，```svg 围栏内联出图（净化 + 自愈），@sb/web 保持零运行时依赖

## 快速开始

```bash
npm install
npm run check        # lint + test + gates（提交前必过）
npm run dev:server   # api :18791（端口被占时 SB_PORT=18792）
npm run dev:web      # web :5173（代理目标 SB_PROXY_TARGET 可配）
```

## 仓库结构

```
packages/shared   契约单一事实源：SSE 事件 / 内容块协议 / REST / 领域模型
packages/server   Express + 学习域（chat / quiz / memorize+SRS / feedback）+ search 聚合 + 搬运件
packages/web      React 18 + 浅色豆包 token（180px 侧栏 / SVG line-icon / Markdown+SVG 正文渲染）
tools/gates       工程红线：行数 ≤400/300 · 禁内联 style · 禁 any
docs/             L3 仓库文档
```

## 文档体系（L0-L4）

| 层 | 位置 |
|----|------|
| L0 元规则 / L1 开发文档 5.0 / L2 专题 | `Desktop/studentbuddy重写/` |
| L3 仓库文档 | 本仓 `docs/` |
| L4 归档区 | `Desktop/studentbuddy重写/废弃文档/` |

规划与架构 demo：`Desktop/studentbuddy重写/studentbuddy-v2-重写规划.md`（含六条 ADR、四大演进、砍除清单、搜索实测）。

## 提交纪律

- 三件套：代码 + 文档 + 测试同批提交；`npm run check` 全绿才提交
- Conventional Commits；搬运件标注 `port from v1`
