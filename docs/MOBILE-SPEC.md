# MOBILE-SPEC — 手机端专项

> 版本：v0.1 | 状态：[未发版] | 更新：2026-10-02 | 分支：`feat/mobile-polish`
>
> 代码：`packages/web/src/styles/mobile.css`（唯一的手机规则文件，main.tsx 最后引入）／`packages/web/src/lib/use-narrow.ts`（JS 侧唯一断点）／
> `packages/web/src/features/chat/composer-placeholder.ts`／`packages/web/index.html`（`viewport-fit=cover`）。

## 1. 现状与问题（真机仪器量出来的，不是感觉）

用 Playwright 的 iPhone 13 配置（390×844，粗指针）对 7 个主要屏幕逐屏截图并量三件事：横向溢出、可点元素 <36px、字号 <12px。改前：

| 问题 | 在哪 | 怎么量到的 |
|---|---|---|
| 右下角督促胶囊压住输入框底边；在词条 / 大陆 / 设置页盖住最后一行内容 | 全部页面 | 截图目视；`.chat-view` 只留了 44px 而胶囊含阴影 50px |
| 督促抽屉是 92vw 的侧抽屉，左边露一条背景、提灯浮在表头上 | 督促抽屉 | 截图 |
| 设置页「服务商」表 5 列挤进 390px，表头竖排成一列一个字 | 设置页 | 截图 |
| 输入框上方三行信息（出题配比 / 回答方式提示 / 占位两行）把输入区顶到屏幕 1/3 | 对话页 | 截图；键盘弹起（高度 500）时更挤 |
| 可点元素 <36px：`.composer-menu-btn` 28px、`.msg-act` 18px、`.msg-edit-trigger` 22px | 对话页 | 仪器逐元素量 |
| 字号 <12px 的可见元素 11 处（`--sb-fs-xs: 11px`） | 全部页面 | 仪器 |
| 没有 `viewport-fit=cover`，`env(safe-area-inset-bottom)` 恒为 0 | 全站 | 读 index.html |
| 表单控件 12.5px：iOS Safari 聚焦自动放大整页 | 全站 | 规则性问题（<16px 必放大） |

横向溢出：7 屏均为 0（既有的 700px 断点已把侧栏折进「探索菜单」、词条页工具栏竖排，这部分不动）。

改前 / 改后（iPhone 13，左改前右改后）：对话页 `docs/images/mobile-chat-before-after.png`、设置页 `docs/images/mobile-settings-before-after.png`、督促抽屉 `docs/images/mobile-coach-before-after.png`。

## 2. 一个断点、一个文件

- **断点只有 700px**：CSS 在 `pixel-shell.css`（既有）与 `mobile.css`；JS 在 `use-narrow.ts` 的 `NARROW_QUERY`。两边同一个数由测试锁住。
- **手机规则只写在 `mobile.css`**：各功能自己的小断点（420 / 520 / 640 / 720 …）仍留原处，但「手机上整体怎样」这个问题以后只看这一个文件。它必须是 `main.tsx` **最后一个** CSS 引入（层叠靠顺序）。
- 只有三类媒体查询可以进这个文件：`(max-width: 700px)`、`(pointer: coarse)`、矮屏 `(max-width: 900px) and (max-height: 460px)`。桌面规则不许混进来（测试锁）。

## 3. 四条口径与落点

| 口径 | 规则 | 落点 |
|---|---|---|
| 1 底部安全区 | 贴底元素都加 `env(safe-area-inset-bottom)` | `.chat-view` 底留 56px + 安全区；`.coach-dock-rail`、`.coach-drawer`、`.sb-pk`；非对话页 `.term-page / .continent-page / .settings-view` 底留 64px |
| 2 粗指针命中区 | 可点元素最小 36×36 | `@media (pointer: coarse)`：输入框菜单钮、消息动作、重试、复习面板开关与按钮、设置页增删、词条 tab、提灯 / 抽屉 / 气泡的关闭钮 |
| 3 表单不放大 | 手机上 input / textarea / select ≥16px | `@media (max-width: 700px)` 全局；聊天输入框单独写一遍（它有自己的字号） |
| 4 字号下限 | `--sb-fs-xs` 11→12、`--sb-fs-sm` 12.5→13 | 只在 ≤700 覆盖 token，桌面不变 |

### 3.1 对话页专项
- 占位文案由 `composerPlaceholder()` 统一给：手机「问点什么…」/「问点什么，发送就开一个新对话」，桌面保留快捷键说明；三种阻塞态（开新对话中 / 生成中 / 未就绪）两端同一句。`ChatComposer` 用 `useNarrow()` 取宽度。
- 「出题配比 … 设置页可改」信息条手机上不显示（信息在设置页原样在）；回答方式提示压成一行省略。
- 错误条 `overflow-wrap: anywhere`（上游 JSON / URL 不撑宽）。
- 键盘弹起（高 ≤560）：欢迎页眉题、副标、像素场景收起，只留标题与卡片。

### 3.2 督促小窗
- 胶囊收紧（padding 6/10、字号 xs），贴右贴底带安全区；对话页输入框下方留的那条从 44px 改 56px + 安全区——胶囊不再压住输入框。
- 抽屉在手机上是**整屏**（`inset: 0`），提灯在抽屉开着时隐藏（两者都是 fixed，否则提灯压在抽屉表头上）。

### 3.3 设置页
- 表格给 `min-width: 560px; white-space: nowrap`，交给 `.settings-sec` 既有的横向滚动——表头不再竖排；`baseUrl` 列省略号。
- 新增服务商表单 5 列 → 1 列。

### 3.4 横屏手机（高 ≤460）
顶栏瘦身、输入区底留 8px、胶囊隐藏——给内容留高度。

## 4. 验收与测试

| 文件 | 锁什么 |
|---|---|
| `web/src/lib/use-narrow.test.ts` | 断点 700 且与两份 CSS 同数；无 matchMedia 当宽屏不抛；跟随 change 翻转、卸载退订 |
| `web/src/features/chat/composer-placeholder.test.ts` | 两端文案；三种阻塞态不被手机短句覆盖；手机句 ≤16 字且不含快捷键 |
| `web/src/styles/mobile.test.ts` | mobile.css 是最后一个 CSS 引入；viewport-fit=cover；四条口径各有规则；文件里只有三类媒体查询 |

改后同一套仪器复量（iPhone 13）：横向溢出 0 → 0；<36px 可点元素 1–4 处 → 0（`composer-menu-btn` 实测 36px）；<12px 可见元素 8–11 处 → 1–2 处（剩余为像素字体装饰文字）。截图目视：胶囊与输入框不再重叠、抽屉整屏、设置表头横排可滚、键盘弹起时输入区完整可见。

人工验证（jsdom 与仪器锁不到）：真 iPhone 上 Safari 的底部手势条是否真的让出来了（需要 `viewport-fit=cover` 生效）；横屏下的实际观感；Android Chrome 的键盘弹起行为（`100dvh` 支持 Chrome 108+）。

## 5. 明确不做
- 不做底部 Tab 栏：现有「探索菜单」抽屉已承担导航，再加一条 Tab 会与输入框争底部。
- 不做 PWA / 安装横幅 / 推送——与手机布局无关。
- 不改知识大陆的地图交互（已是横向可滚容器，手机可拖）。

## 6. 修订记录
- v0.1（2026-10-02）：首版。
