# 资料溯源（Source Trace）

状态：v1（2026-09-30）。AI 联网回答时，把它**正在看的资料**（网页 / PDF / 视频 / 图片）实时摆到右侧「资料架」演示给学习者看；
AI 自己再从中精选 1–3 条说明为什么值得看；回答里的 `[n]` 引用能点回对应资料；资料随回答落库，历史里照样能翻。

## 1. 目标与不做

- **目标**：等待时不再是黑箱——「AI 在看什么」一眼可见；回答有据可查（`[n]` 点得回去）；学习者能顺手把好资料读完。
- **不做**：不做通用浏览器（阅读页只渲染正文，不执行脚本、不登录、不带 cookie）；不抓全文入库（只存元数据，正文按需现抓）；
  不替代「演示面板」（HTML 演示开着时资料架让位，见 §8.2）。
- **口径由用户拍板（2026-09-30）**：① 展示方式 = **阅读模式优先**（服务端抓取清洗后的正文，塞进已有的沙箱面板；视频走官方播放器；
  PDF 走服务端转发；「原网页 ↗」按钮常在）；② 上架 = **搜到即上架 + 读过自动升格 + AI `pick_sources` 精选**；
  ③ 与「等待时刷词」共存 = **刷词改成可拖动小窗**（学习者拖到左边 / 中间），资料架固定右侧（`WAIT-DRILL-SPEC.md` §5.6）；
  ④ **全量持久化 + 可点引用**：每条回答挂自己的资料架（`message_source` 表），历史回放出「资料 n 条」可重开。

## 2. 一轮回答里学习者看到什么

```
提问 ──▶ search_web ──▶ 右侧弹出资料架：[1]…[5]（搜到）        ← 面板标「AI 在看」
           │
           ├──▶ fetch_page(url) ──▶ 该条升格为「读过」+ 标「在读」；不在架上的网址补一个新编号
           │
           ├──▶ pick_sources ──▶ ★ 精选置顶 + 理由条「★ AI 精选：MDN 官方指南，例子最清楚」
           │
           └──▶ 正文流式吐出，`[1]`、`[2]` 渲成芯片，点了右侧切到该条
回答收口 ──▶ 面板标由「AI 在看」改「资料」；资料随回答落库；消息脚注常显「资料 n 条」
```

- 学习者中途关掉面板 ⇒ **本轮**不再自动弹（下一轮照弹）；点脚注 / 点 `[n]` 随时重开。
- 键位：`[` / `]` 前后切，`Alt+←/→` 同义，`Alt+1–9` 直达面板第 k 个标签（§8.4）。
- 手机（≤640px）：资料架与演示面板一样铺满内容区；刷词退回底部抽屉，两者不并排（先关一个）。

## 3. 契约（`packages/shared/src/sources.ts`）

```ts
type SourceKind = 'page' | 'pdf' | 'video' | 'image';
type SourceOrigin = 'search' | 'read' | 'pick';
interface SourceItem { n: number; url: string; title: string; site: string; kind: SourceKind; origin: SourceOrigin;
                       why?: string;      // 仅 pick：AI 一句话理由
                       snippet?: string;  // 仅 search：搜索摘要（≤200 字）
                       query?: string }   // 哪个查询搜到的
interface SourcesBlockPayload { kind: 'sources'; sessionId: string; items: SourceItem[]; readingN?: number }
interface SessionSourcesResult { byMessage: Record<string, SourceItem[]> }
```

常量：`SOURCE_SHELF_MAX = 12`（架子上限）、`SOURCE_PICK_MAX = 3`、`SOURCE_PER_SEARCH = 5`（每次搜索最多上架）、
`SOURCE_TITLE_MAX = 120`、`SOURCE_WHY_MAX = 140`、`SOURCE_SNIPPET_MAX = 200`。

纯函数（前后端共用、有单测）：

| 函数 | 作用 |
|---|---|
| `videoEmbedUrl(url)` | YouTube（含 youtu.be / shorts）→ `youtube-nocookie.com/embed/{id}`；B 站 `/video/BVxxxx` → `player.bilibili.com/player.html?bvid=…`；其它 `null` |
| `detectSourceKind(url)` | 只看 URL：可嵌视频 ⇒ `video`；`.pdf` ⇒ `pdf`；图片后缀 ⇒ `image`；否则 `page` |
| `siteOf(url)` | host 去 `www.`；解析不了截前 40 字 |
| `isShelvableUrl(url)` | 只放行 http(s)（`javascript:` / `data:` / `file:` 一律不上架） |
| `orderSources(items)` | 面板顺序：精选 → 读过 → 搜到；同档按编号；不改入参 |
| `sourceByN(items, n)` | `[n]` 能点回去的前提 |

## 4. 资料架（服务端 `sources/shelf.ts`，一轮一个）

`createSourceShelf(sessionId)` 在一轮工具循环开始时建，`flow.ts` 持有；每次变更整表下发一帧
SSE `block`（`blockId = sources:{sessionId}`，`payload.kind = 'sources'`，`done=false`），前端**整表替换**。

规则：

1. **编号是身份**：每个网址第一次露面就领一个全轮单调递增的编号，之后再出现（被读、被精选）沿用同号——正文里的 `[n]`
   与面板上的 `n` 永远指同一条。网址先做 `normalizeSourceUrl`（去 hash、根路径去尾斜杠）再比对；未上架的网址也占号
   （模型看到的 `[6]` 之后被读到时就以 6 号上架）。
2. **上限 12**：满了就挤掉编号最大的 `search` 条；全是 `read` / `pick` 时放弃上架（编号照发，只是不摆出来）。
3. **升格不降格**：`search → read → pick` 只往上走；`pick` 带 `why`（≤140 字）。
4. **在读标**：`fetch_page` 开始时 `readingN = n`，结束（成功或失败）清掉——面板上「在读」只在真的抓取期间亮。
5. **在线注册表**：`liveShelfKnows(sessionId, url)` 供 §6 的授权在**落库之前**放行；条目 2 小时无动静自动清；
   落库后许可由 `message_source` 表接力（§7）。

### 4.1 搜到即上架（`search/index.ts` → `tools/web-search.ts`）

每次 `search_web` 的结果**按返回顺序**最多上架 `SOURCE_PER_SEARCH`（5）条（跳过不可上架的 URL 与已在架的），
携带 `title` / `snippet` / `query`。结果编号与工具结果文本里的 `[n]` 一致（模型看到的编号就是学习者看到的编号）。

### 4.2 读过自动升格（`tools/fetch-page.ts`）

`fetch_page(url)`：在架 ⇒ 升 `read`；不在架 ⇒ 领新号以 `read` 上架（可能挤掉一条 `search`）。开始 / 结束各发一帧（在读标）。

### 4.3 `pick_sources` 工具（`chat/tools/pick-sources.ts`）

```
pick_sources({ picks: [{ url, why }, …] })   // 1–3 条；kind 'read'，idempotent
```

- 只认**本轮搜到或读过的网址**（原样复制）；架上没有的网址 ⇒ 该条退回并在返回文本里点名；没有资料架（这轮没搜过）⇒ 如实说明；
  `picks` 不是数组被参数校验挡下，空数组 / 无 url 的条目 ⇒ 纠错文案。
- 系统提示词（`chat/system-prompt.ts`）要求：联网回答用 `[n]` 标注出处、`n` 必须是工具结果里给的编号；读完资料后用
  `pick_sources` 标 1–3 条最值得看的并说一句理由。
- 工具标签：前端三处标签表（`chat-meta.ts` / `process-summary.ts` / `thinking-status.ts`）均为「精选资料」（`fetch_page` 为「读取网页」）。

## 5. 阅读页（`sources/reader.ts`，纯函数可单测）

`loadReaderDoc(url, titleHint, signal)` → `{ ok, html }` 或 `{ ok:false, status, reason }`：

- 抓取走 `fetchSafe`（SSRF 逐跳复检），`READER_TIMEOUT_MS` 15 s，正文上限 `READER_MAX_BYTES` 2 MB；`fetch_page` 刚抓过的 HTML
  会 prime 进阅读页缓存（不二次取页），出过的页再缓存 80 条。`content-type` 不是 HTML ⇒ 415 占位页（PDF 提示走 §6 的 `/pdf`）；
  图片类资料不取页，直接一张原图 + 标题；正文太短（脚本渲染页）外壳给「看原网页」提示。
- 正文区域：`<article>` 够长（>500 字）就用它，其次 `<main>`，再 `<body>`，最后整页。
- **白名单清洗**（`sanitizeReaderHtml`）：先整块剥 `script/style/noscript/template/svg/math/iframe/object/embed/form/button/
  input/select/textarea/canvas/video/audio/picture/source/nav/header/footer/aside/dialog/menu`（连内容），再逐标签过白名单
  （p/h1–h6/ul/ol/li/blockquote/pre/code/strong/em/table…/figure/img/a/section/article 等）；属性只留 `a[href]`（绝对化、
  `javascript:` 剔除、`target=_blank rel=noreferrer noopener`）与 `img[src|alt]`（绝对化、`loading=lazy referrerpolicy=no-referrer`）；
  散 `<` 转义。输出**绝无脚本 / 事件属性 / 内联样式**。
- 页面壳（`SHELL_CSS`，夜行配色）：`.src-head`（`.src-site` 站名、`<h1>` 标题、`.src-open` 「原网页 ↗」）、可选 `<p class="src-note">`、
  `<article>` 含 `.src-byline`（作者 / 时间，来自 meta）；图片 `max-height: 50vh` 防横幅霸屏。
- 失败页 `failDoc(reason, url)`：同一套壳，说明原因 + 「原网页 ↗」。

## 6. REST（`routes/sources.ts`，挂在 `/api/sources`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sources/view?session=&url=&title=` | 阅读页 HTML（§5）。**授权**：会话可访问 **且** 网址在该会话的资料架上（在线注册表或 `message_source` 表），否则 403——不是任意网址代理 |
| GET | `/api/sources/pdf?session=&url=` | PDF 转发：同授权；前 5 字节魔数必须是 `%PDF-`（否则 415）；上限 25 MB；`Content-Disposition: inline` |
| GET | `/api/sources/session/:id` | `{ byMessage }`：该会话每条回答挂的资料（历史重开 / 侧栏用） |

响应头（阅读页）：
`Content-Security-Policy: sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`
+ `X-Frame-Options: SAMEORIGIN`（全局是 `DENY`，会把宿主面板一起挡掉；与演示页同一处理）+ `Referrer-Policy: no-referrer`
+ `Cache-Control: private, max-age=600`。CSP 的 `sandbox` 必须显式列 `allow-popups…`——否则即使 iframe 属性放行，「原网页」也弹不开。

另：`GET /api/sessions/:id/messages` 的每行多一列 `sources: SourceItem[]`（没有就不带键），历史回放直接用。

## 7. 持久化（`sources/store.ts`，表 `message_source`，迁移 v51）

```sql
CREATE TABLE message_source (
  session_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  n INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', site TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'page', origin TEXT NOT NULL DEFAULT 'search', snippet TEXT, why TEXT, query TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (session_id, message_id, n));
CREATE INDEX idx_message_source_url ON message_source(session_id, url);
```

- `chat/persist.ts` 在**最终回答那条** assistant 消息落库的同一事务里写入本轮架子（中间的 tool 轮不挂）；架子为空不写。
- 删会话级联删除；`(session_id, url)` 索引供 §6 授权查询。
- 只存元数据：正文永远现抓（不做全文缓存，避免版权 / 过期问题）。

## 8. 前端

### 8.1 `lib/sources-store.ts`（useSyncExternalStore，跨组件单例）

```ts
state = { open, sessionId, items, activeN, readingN, live }
applyLiveSources(payload)   // SSE 帧：整表替换；首帧自动打开；已选中的条还在就不跳；首选 = 精选 > 在读 > 面板首条
openSources(sid, items, n?) // 历史 / 脚注：指定 n（不存在落首选）；空架不开
showSource(sid, items, n)   // 引用芯片：同一份架子只切条目并确保打开，不同架子按新架重开
selectSource / stepSource(±1) / selectSourceAt(k) / closeSources()
takeTurnSources(sid)        // 回答收口：把本轮架子交给 finalizeRound 挂到消息上；live→false
readerUrl(sid, item)        // pdf → /api/sources/pdf，其余 → /api/sources/view
```

- **关过本轮不再弹**：`closeSources()` 在 live 时记下 `{sessionId, turn}`；同轮后续帧只更新内容不打开；`takeTurnSources` 结束一轮，
  下一轮首帧重新弹。轮次用**单调计数**而不是时间戳（同一毫秒内收口又开新轮会撞号）。
- `takeTurnSources` 在 `setMessages` 的 updater 里被调（StrictMode 下同一 tick 调两次）：同秒重复取返回同一份；
  通知放到微任务（避免「渲染 ChatView 时更新 SourcePanel」告警）；1 s 后再取为空（防陈旧架子挂到下一条）。

### 8.2 面板（`features/sources/SourcePanel.tsx` + `sources.css`）

- 复用演示面板的壳（`.sb-browser.sb-sources`：`-head/-badge/-title/-actions/-btn/-close/-frame`），宽 `--sb-browser-w`；
  **演示面板开着时返回 null**（HTML 演示优先，演示关掉资料架回来）。
- 徽标：live 时「AI 在看」，历史「资料」。标签条 `.src-tabs`：编号 + 类型字（文/PDF/视/图）+ 站名 + ★（精选）+ 「在读」；
  顺序 = `orderSources`；当前 `.active`。理由条 `.src-note.pick`（精选）或摘要（搜到）。
- `SourceFrame` 按类型三路：`video` ⇒ 官方播放器（`sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"` +
  `allow="fullscreen; picture-in-picture; encrypted-media"`）；
  `pdf` ⇒ `/api/sources/pdf`，**不加 sandbox**（浏览器内置 PDF 查看器在沙箱里不工作）；`page` / `image` ⇒ 阅读页
  `sandbox="allow-popups allow-popups-to-escape-sandbox"`（无脚本、无同源）。
- 「原网页」按钮 `window.open(url, '_blank', 'noopener,noreferrer')`；底栏 `.src-foot`：`k / N` + 键位提示。
- 只用 `--sb-*` 令牌、无内联样式；移动端沿用 `.sb-browser` 的铺满规则（`pixel-shell.css`）。

### 8.3 引用芯片 `[n]`（`lib/markdown-inline.ts` + `features/sources/cite.tsx`）

- 解析：行内 `[n]` / `[1, 3]` / `[1][2]`（前一字符不是字母数字，避免 `a[1]` 之类下标）⇒ `{ t:'cite', n }`；`[文](url)` 仍是链接。
- 渲染：`<MessageSourcesProvider sessionId sources>` 给这条消息自己的架子；`CiteChip` 有第 n 条 ⇒ `<button class="md-cite [md-cite-pick]">n</button>`
  （title = 标题 · 站名），点了 `showSource`；没有 ⇒ 原样文字 `[n]`（不误伤普通方括号）。
- 流式正文没有 Provider（消息还没挂架子）⇒ 回落到 store 的 **live** 架；live 结束后不再回落。
- 脚注（`MessageFoot`）：有架子的回答常显「资料 n 条」（其它操作是 hover 才显形，这条是信息不是操作），点了 `openSources`。

### 8.4 键位（`features/sources/useSourceKeys.ts`，纯函数 `handleSourceKey`）

| 键 | 行为 |
|---|---|
| `[` / `]`，`Alt+←` / `Alt+→` | `stepSource(-1 / +1)`（按面板顺序回绕） |
| `Alt+1` … `Alt+9` | `selectSourceAt(k)` |
| 焦点在 input / textarea / select / contentEditable | 不处理（打字优先） |
| 带 Ctrl / Meta | 不处理（浏览器快捷键优先） |

### 8.5 与「等待时刷词」共存

刷词改为**非模态可拖动小窗**（`WAIT-DRILL-SPEC.md` §5.6）：外层不压暗、不吃点击；窗体位置存本机偏好；
资料架固定右侧。窄屏两者都铺满（刷词底部抽屉），先关一个再看另一个。

## 9. 安全

- 阅读页 / PDF 只服务**本会话资料架上的网址**（在线注册表 → 落库表），不是开放代理；抓取一律 `fetchSafe`（SSRF 逐跳复检）。
- 阅读页零脚本（CSP `default-src 'none'` + 白名单清洗双保险），`sandbox` 不给 `allow-same-origin`，图片 `no-referrer`。
- 视频只嵌 YouTube（nocookie）/ B 站官方播放器；其它视频站按网页处理。
- 网页正文进模型上下文时仍是「数据不是指令」（`fetch_page` 既有口径）；`pick_sources` 只能引用本轮网址，不能凭空造。

## 10. 测试

| 文件 | 钉什么 |
|---|---|
| `shared/src/sources.test.ts` | `videoEmbedUrl` 各形态、`detectSourceKind`、`isShelvableUrl` 拒绝非 http(s)、`orderSources` 顺序与不改入参 |
| `server/src/sources/shelf.test.ts` | 跨搜索续号 / 同网址同号、每次只上架前 5 条但全部占号、未上架被读到以原号上架、架满挤 `search`、pick 只认 known ≤3 条、整表帧、在线注册表与 normalize |
| `server/src/sources/reader.test.ts` | 清洗白名单（危险块连内容删、非白名单剥壳留字、属性全丢、`javascript:` 降级、`data:` 图丢）、标题 / 区域 / 署名、太短提示、primed 与缓存、图片直出、415 / 502 / 超时 |
| `server/src/chat/tools/pick-sources.test.ts` | 参数校验与纠错文案、没有架子如实说明、有架子精选生效 + 回灌编号 + 未知退回、注册为 read 档幂等 |
| `server/src/routes/sources.test.ts` | 缺参 400 / 不在架 403、阅读页 CSP + `X-Frame-Options: SAMEORIGIN` + nosniff、失败页非 JSON、落库后仍放行 + `/messages` 带 `sources` + `/session/:id` 分组、删消息级联、PDF 魔数 415 / 真 PDF inline 转发 |
| `web/src/lib/sources-store.test.ts` | §8.1 七条 |
| `web/src/features/sources/sources.test.tsx` | 面板三路 iframe / 让位 / 键位 / 芯片 / 解析 / 分派 / 历史脚注 |
| `web/src/features/drill/useDragWindow.test.ts` + `WaitDrill.test.tsx` | 小窗限位、拖动写偏好、非模态键位归属 |

真浏览器实拍（`.probe-local/sources-cdp.mjs`，本机假上游按「搜 → 读 → 精选 → 带引用正文」四步走）：
搜到即弹、在读标、★ 理由条、`]` / `Alt+3` 切换、芯片点回、刷新后脚注重开、刷词小窗拖到左侧与资料架并存、无 console 告警。

## 11. 风险与后续

- 阅读模式的正文抽取是正则级（没有 Readability），导航残渣（如 w3schools 的 Menu / Search）会漏进来——「原网页 ↗」兜底；
  后续可加基于文本密度的块打分。
- 搜索渠道（Bing 抓取）的相关性有限；上架顺序 = 渠道顺序，AI 精选是给学习者的第二道筛。
- 视频只嵌两家；其它站点将来按需加白名单（必须是官方明文允许嵌入的播放器）。
- 尚未做：资料内搜索 / 高亮引用句、把资料一键存成词条、多轮之间的资料合并视图。
