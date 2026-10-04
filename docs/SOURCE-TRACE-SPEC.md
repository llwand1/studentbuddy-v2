# 资料溯源（Source Trace）

状态：v1.1（2026-09-30；v1 同日）。AI 联网回答时，把它**正在看的资料**（网页 / PDF / 视频 / 图片）实时摆到右侧「资料架」演示给学习者看；
AI 自己再从中精选 1–3 条说明为什么值得看；回答里的 `[n]` 引用能点回对应资料；资料随回答落库，历史里照样能翻。
v1.1 加两条腿：**视频线路**（§12，学习者自己一键去 B站 / 抖音找讲解视频）与**截图保底**（§13，阅读页打不开就让服务器用真浏览器截首屏）。

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

视频线路（`packages/shared/src/video-route.ts`，§12）：

```ts
type VideoRoute = 'bilibili' | 'douyin';
interface VideoHit { route: VideoRoute; url: string; title: string; author?: string; cover?: string; duration?: string; plays?: number; snippet?: string }
interface VideoRouteResult { route: VideoRoute; query: string; hits: VideoHit[]; siteSearchUrl: string;
                             via: 'api' | 'web' | 'none';   // 站内接口 / 联网搜索 / 两条都空
                             note?: string }                 // 给学习者看的一句实话（为什么少 / 为什么空）
```

常量：`VIDEO_ROUTES`、`VIDEO_ROUTE_META`（`label / site / playable / hint`）、`VIDEO_QUERY_MAX = 80`、`VIDEO_HITS_MAX = 8`、
`VIDEO_SEED_MAX = 30`。纯函数：`videoSiteSearchUrl(route, q)`、`cleanVideoQuery`（去控制字符 / 压空白 / 截 80）、
`videoQueryFromText(text)`（第一个标题，否则首句，≤30 字）、`stripSearchEm`、`bilibiliVideoUrl` / `bvidFromUrl`、
`douyinVideoIdFromUrl`、`formatPlays`（`68万`）。

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
6. **收口只留看得了的**（2026-09-30，`settle(answer)`）：回答结束时（正常与失败/中止两条落库路径都是）只留
   **读成功**（正文已进阅读页缓存）、**精选**、**正文 `[n]` 引用到**（`citedSourceNumbers`，与前端 `CITE` 同口径）的条目，
   其余（搜到但没读、正文也没提）撤下，**编号不动**，再整表下发一帧；落库的就是这份终态。
   动机：搜索结果只有摘要，点开要现抓，一大半站点会拒——学习者原话「推的东西很多看不了」。引用到的 `search` 条即使
   现抓可能失败也留着：撤了会留下点不动的 `[n]`，比一张 415 页更糟。
7. **读失败不装读过**（同批）：`read(url, title, ok=false)` 把 `reading` 占的 `read` 位撤掉——原本是搜到的退回 `search` 档
   （摘要还在，去留由规则 6 决定），纯为读而占的位直接撤；号不回收（稍后读成功仍是原号）。

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
| GET | `/api/sources/probe?session=&url=&title=` | 阅读页探测（§13.1）：同授权；`{ ok, thin, shot }` 或 `{ ok:false, status, reason, thin:false, shot }`；与 `/view` 合流同一次取页 |
| GET | `/api/sources/shot?session=&url=` | 截图保底（§13）：同授权；成功 `image/png`（nosniff、`CSP default-src 'none'`、`private, max-age=600`）；失败 JSON `{ error, kind }`，状态码按种类：`no_browser` 404 / `blocked` 400 / `timeout` 504 / `busy` 503 / `failed` 502 |
| GET | `/api/sources/videos?route=&q=` | 视频线路（§12）：`VideoRouteResult`；`route` 不是两家之一或 `q` 清洗后为空 ⇒ 400；上游失败不报错，写进 `via:'none'` + `note` |

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
removeSource(n)             // 叉掉第 n 条：按网址记入本会话隐藏表（页面级）；live 帧 / 归位 / 历史重开都先过这张表
takeTurnSources(sid)        // 回答收口：把本轮架子交给 finalizeRound 挂到消息上；live→false
readerUrl(sid, item)        // pdf → /api/sources/pdf，其余 → /api/sources/view
```

- **关过本轮不再弹**：`closeSources()` 在 live 时记下 `{sessionId, turn}`；同轮后续帧只更新内容不打开；`takeTurnSources` 结束一轮，
  下一轮首帧重新弹。轮次用**单调计数**而不是时间戳（同一毫秒内收口又开新轮会撞号）。
- `takeTurnSources` 在 `setMessages` 的 updater 里被调（StrictMode 下同一 tick 调两次）：同秒重复取返回同一份；
  通知放到微任务（避免「渲染 ChatView 时更新 SourcePanel」告警）；1 s 后再取为空（防陈旧架子挂到下一条）。
- **单条可叉掉**（2026-09-30）：`removeSource(n)` 从架上拿掉并按**网址**记入本会话的隐藏表；正在看的被叉掉 ⇒ 落到剩下里的首选；
  一条不剩 ⇒ 面板收起。隐藏表是页面级（刷新即忘、不落库）：叉掉表达的是「我现在不想看」，不是删资料——
  服务端 `message_source` 不动，翻历史重开时（同一页面会话内）仍按隐藏表过滤。

### 8.2 面板（`features/sources/SourcePanel.tsx` + `sources.css`）

- 复用演示面板的壳（`.sb-browser.sb-sources`：`-head/-badge/-title/-actions/-btn/-close/-frame`），宽 `--sb-browser-w`；
  **演示面板开着时返回 null**（HTML 演示优先，演示关掉资料架回来）。
- 徽标：live 时「AI 在看」，历史「资料」。标签条 `.src-tabs`：每条是 `.src-tab-wrap`（标签按钮 `.src-tab` + 旁边的 ✕ `.src-tab-x`，
  button 不能套 button 故并排）：编号 + 类型字（文/PDF/视/图）+ 站名 + ★（精选）+ 「在读」；✕ 平时淡、悬停 / 当前条亮，
  `aria-label="去掉资料 n：标题"`。顺序 = `orderSources`；当前 `.active`。理由条 `.src-note.pick`（精选）或摘要（搜到）。
- `SourceFrame` 按类型三路：`video` ⇒ 官方播放器（`sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"` +
  `allow="fullscreen; picture-in-picture; encrypted-media"`）；
  `pdf` ⇒ `/api/sources/pdf`，**不加 sandbox**（浏览器内置 PDF 查看器在沙箱里不工作）；`page` / `image` ⇒ 阅读页
  `sandbox="allow-popups allow-popups-to-escape-sandbox"`（无脚本、无同源）。
- 「原网页」按钮 `window.open(url, '_blank', 'noopener,noreferrer')`；底栏 `.src-foot`：`k / N` + 键位提示。
- 网页 / 图片那一格是 `ReaderFrame`（§13.1）：iframe 之外还会按探测结果叠一条出口栏或整格换成截图视图。
- **两种内容**（2026-09-30）：架子视图之外，同一块面板还能显示**视频线路**（`VideoRouteView`，§12.4）——头部多一个「找视频」；
  视频视图开着时壳加 `.sb-video-route`，徽标「视频」，头部「资料 n」一键切回架子（架子状态原样保留），× 两个都关。
  没有架子时（回答没联网）也能单独打开视频视图。
- 只用 `--sb-*` 令牌、无内联样式；移动端沿用 `.sb-browser` 的铺满规则（`pixel-shell.css`）。
- **「存为资料」**（2026-10-02，`SaveAsDocButton.tsx`，细则 `DOC-RAG-SPEC.md` §10.6）：头部多一个按钮，
  把**当前这一条**的网页设成**本会话的学习资料**（文档模式，之后的回答 / 出题 / 抽词条都以它为准）。
  ★ **它写的是文档模式，不碰架子本身**——架子是「AI 这一轮读了什么」（编号即身份、随消息落库），
  资料是「以后都按这页答」（会话级、每次一份）；两个语义混了就会出现「存一下，架子少一条」这种鬼事。
  视频条目不显示（视频抓不出正文，存了是一份空资料）；成功转金、失败转危险色并把原因写进 `title`，
  **两种终态都留在屏上**（ADR-5），可再点重试。
  跨组件同步只发一条 `DOC_CHANGED_EVENT` 让 composer 上的 pill 去重取，**前端不存第二份资料状态**。

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
| 视频线路开着 | 全部不处理（`[` `]` 切的是架子，视频视图里切了看不见会很怪） |

### 8.5 与「等待时刷词」共存

刷词改为**非模态可拖动小窗**（`WAIT-DRILL-SPEC.md` §5.6）：外层不压暗、不吃点击；窗体位置存本机偏好；
资料架固定右侧。窄屏两者都铺满（刷词底部抽屉），先关一个再看另一个。

## 9. 安全

- 阅读页 / PDF 只服务**本会话资料架上的网址**（在线注册表 → 落库表），不是开放代理；抓取一律 `fetchSafe`（SSRF 逐跳复检）。
- 阅读页零脚本（CSP `default-src 'none'` + 白名单清洗双保险），`sandbox` 不给 `allow-same-origin`，图片 `no-referrer`。
- 视频只嵌 YouTube（nocookie）/ B 站官方播放器；其它视频站按网页处理。视频线路的抖音命中**只跳转不嵌播**（§12.2）。
- 网页正文进模型上下文时仍是「数据不是指令」（`fetch_page` 既有口径）；`pick_sources` 只能引用本轮网址，不能凭空造。
- 截图保底（§13.2）：浏览器的**每一个**出站连接（含重定向、子资源、回环）都经本机守门代理按 `fetchSafe` 同一套规则
  解析 + 判内网，过了才按解析出的 IP 钉住连；`/shot` 与 `/view` 同一套「只服务架上网址」的许可；截图进程用独立的
  临时 profile、不带任何 cookie，用完即删。
- B站站内搜索接口只带**免登录的设备 cookie**（`buvid3/buvid4`，§12.1），不带用户身份、不做 WBI 签名、不登录。

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
| `shared/src/video-route.test.ts` | 站内搜索页网址两家、`cleanVideoQuery` 控制字符 / 空白 / 截断、`videoQueryFromText` 标题 > 首句、BV 号 / 抖音 id 抽取、`formatPlays` |
| `server/src/sources/video-route.test.ts` | B站接口形态解析（去 `<em>`、封面补协议、时长 / 播放量）、设备 cookie 领取 / 复用 / 412 换新重试、接口失败退回联网搜索、抖音只留视频页 + 零命中如实 `note`、按线路 + 词缓存 |
| `server/src/sources/shot.test.ts` | 找浏览器（环境变量 / `off` / PATH）、无头参数（root 才加 `--no-sandbox`、代理 + 回环不绕过）、并发 2 / 排队 4 / `busy`、超时 `timeout`、内网 `blocked`、PNG 上限、结果缓存；守门代理放行 / 拦截 / 钉 IP |
| `server/src/routes/sources-fallback.test.ts` | `/probe` 授权 + `thin` + `shot` 三态、`/shot` PNG 头与五种失败码、`/videos` 400 与结果透传、失败页写明「截不了图」 |
| `web/src/lib/video-route-store.test.ts` | 种子词即搜、切线路重搜 / 切回不重搜、旧请求作废、就地播只给 B站、关闭清态 |
| `web/src/features/sources/ReaderFrame.test.tsx` | 打不开 + 能截 ⇒ 自动截图视图；太薄 ⇒ 出口栏、点了才截；没浏览器 ⇒ 什么都不加；探测失败不影响 iframe；「阅读模式」切回 |
| `web/src/features/sources/video-route.test.tsx` | 「找视频」只挂回答行、种子词优先级、面板视频视图 + 键位停用、B站卡就地播 + 抖音卡开新标签、零命中 / 出错都给站内搜索出口、「资料 n」切回、× 全关 |

真浏览器实拍（`.probe-local/sources-cdp.mjs`，本机假上游按「搜 → 读 → 精选 → 带引用正文」四步走）：
搜到即弹、在读标、★ 理由条、`]` / `Alt+3` 切换、芯片点回、刷新后脚注重开、刷词小窗拖到左侧与资料架并存、无 console 告警。
v1.1 实拍（真上游）：脚本渲染页出「用服务器截图看全」→ 截到对方验证码页原样搬来（如实）；空响应体的 403 页 Chromium 不出图 ⇒
「截图也没成」+ 原网页出口；「找视频」→ B站 8 条带封面 / 时长 / 播放量、点卡就地播；抖音零命中 ⇒ 站内搜索卡。

## 11. 风险与后续

- 阅读模式的正文抽取是正则级（没有 Readability），导航残渣（如 w3schools 的 Menu / Search）会漏进来——「原网页 ↗」兜底；
  后续可加基于文本密度的块打分。
- 搜索渠道（Bing 抓取）的相关性有限；上架顺序 = 渠道顺序，AI 精选是给学习者的第二道筛。
- 视频只嵌两家；其它站点将来按需加白名单（必须是官方明文允许嵌入的播放器）。
- 尚未做：资料内搜索 / 高亮引用句、把资料一键存成词条、多轮之间的资料合并视图。
  （★ 2026-10-02 已做掉相邻的一件：**把架上这一页存成本会话学习资料**，见 §8.2 与 `DOC-RAG-SPEC.md` §10。）
- 视频线路：B站站内接口是公开但**未承诺**的（形状变了退回联网搜索，不会报错）；抖音没有可用的公开搜索面，
  搜索引擎对它的收录也几乎为零——命中常为空，产品上接受「站内搜索卡」就是抖音线路的常态。
- 截图保底：依赖部署机上有 Chromium（线上镜像要自己装）；每张图起一个浏览器进程（≈1–3 s、百兆级内存），
  已限并发 2 / 排队 4，再多的请求直接 `busy`；截的是**首屏静态图**，登录墙 / 验证码页会原样截到——这是如实，不是 bug。

## 12. 视频线路（2026-09-30）

学习者读完回答想「找个人讲一遍」——不用离开对话，一键去 B站 / 抖音搜这个知识点的讲解视频。
**口径由用户拍板**：B站 = 站内搜 + 站内播；抖音 = 只能给标题 + 跳转卡（没有公开接口、官方不许嵌播）。

### 12.1 取数（`server/src/sources/video-route.ts`）

`searchVideoRoute(route, q, ownerId, signal?, deps?)` → `VideoRouteResult`：

- **B站**：站内搜索接口（`x/web-interface/search/type?search_type=video&order=totalrank`，公开、免登录）。接口要带
  **设备 cookie** `buvid3/buvid4`——不带时风控间歇性回 412；cookie 从 `x/frontend/finger/spi` 免登录领，进程内缓存 6 小时，
  遇 412 领新的再试**一次**。解析：标题去 `<em class="keyword">`、封面补 `https:`、`duration` / `play` / `author` / `bvid`。
  接口没应答（风控、超时、形状变了）⇒ 退回联网搜索 `site:bilibili.com/video <q>`（`searchWeb`），从网址抠 BV 号
  （没封面时长，一样能就地播）⇒ `via:'web'`。两条都空 ⇒ `via:'none'` + `note`。
- **抖音**：只走联网搜索 `site:douyin.com <q>`；命中只留**视频页**（`/video/<id>` 或 `v.douyin.com/<code>`），不给封面
  （抖音封面链接带签名会过期）；零命中 ⇒ `via:'none'` + 如实的 `note`（「搜索引擎几乎不收录抖音」）。
- 每条线路都附 `siteSearchUrl`（B站 `search.bilibili.com/all?keyword=`，抖音 `www.douyin.com/search/<q>?type=video`）——
  **任何情况下**面板都有「去站内搜」这一张卡。
- 结果按「线路 + 词」缓存 10 分钟（`via:'none'` 不缓存，下次还试）；命中 ≤ `VIDEO_HITS_MAX`（8）；出站都走 `fetchSafe`。

### 12.2 入口与种子词

- 消息脚注（`MessageFoot`）的「找视频」：**只挂回答行**（一问一答挂两个是噪音），不要求这条回答联过网；
  常显但淡一档（它是入口，复制 / 重答仍是悬停才现）。种子词：架上任一条的 `query`（AI 这轮的搜索词）> `videoQueryFromText(正文)`。
- 面板头部的「找视频」（架子视图开着时）：种子同上，学习者在面板里随时改词。

### 12.3 状态件（`web/src/lib/video-route-store.ts`）

```ts
state = { open, sessionId, route, query, phase: 'idle'|'loading'|'done'|'error', result, error, playing }
openVideoRoute(sid, seed?)  // 打开；当前词为空且有种子 ⇒ 用种子并立即搜
setVideoRoute(route)        // 切线路即重搜（每条线路各留一份结果，切回不重搜）
setVideoQuery(q) / runVideoSearch()   // 改词要按「搜」或回车
playVideo(hit)              // 只接受 route:'bilibili'；抖音卡由视图直接开新标签页
closeVideoRoute()           // 关掉并清 playing；架子状态不动
```

旧请求作废：连续搜两次只认最后一次（AbortController + 序号）。与 `sources-store` 分开：架子是 AI 引用的资料（编号即身份、随消息落库），
视频线路是学习者自己点出来的一次搜索（不编号、不落库、刷新即散）。

### 12.4 视图（`features/sources/VideoRouteView.tsx`，类名 `.vr-*`）

- 一行工具条：词输入框（回车即搜）+ 线路开关「B站 / 抖音」（`.vr-route`）+ 「搜」。
- 命中卡 `.vr-card`：封面（`referrerpolicy="no-referrer"`，B站图床对外站 Referer 回 403）或 `.vr-cover-blank` 站名占位；
  标题 + 元信息 `UP · 时长 · n万播放`；右侧动作：B站「播」/「播放中」（`.active`），抖音「↗」（`.jump`，开新标签页）。
- 就地播：B站命中点开在列表上方出 `iframe.vr-player`（`videoEmbedUrl`，与架子里的视频同一套 sandbox / allow），
  头部「原网页」指向正在播的那条。
- 站内搜索出口 `.vr-site`：与命中卡同一副面孔的 `<a>`（「去 B站 站内搜「…」· 在新标签页打开」），`done` / `error` 都在；
  零命中 `.vr-note.none`、出错 `.vr-note.error` 各一句实话。底栏「B站：就地播 · 抖音：跳转看」。

## 13. 截图保底（2026-09-30）

阅读模式注定拿不好三类页：脚本渲染的单页应用（正文几乎为空）、拒绝非浏览器 UA 的站（403 / 412）、返回非网页内容的地址。
**口径由用户拍板**：服务器有 Chromium 就用真浏览器截首屏搬过来；没有就退回「新标签页打开」并如实提示；
零新 npm 依赖（不打包 Playwright）、不接第三方截图服务。

### 13.1 前端三路（`features/sources/ReaderFrame.tsx`）

挂阅读页 iframe 的同时问 `/probe`（服务端与 `/view` 合流同一次取页，不多拉上游），按答复分三路：

| 探测结果 | 面板 |
|---|---|
| 打不开（`ok:false`）且 `shot:true` | **自动**换成截图视图 `.src-shot`：顶栏「阅读模式打不开这一页，服务器正在用浏览器截图…」→ 成功 `img.src-shot-img`（可滚动看整张首屏）+ 「是一张图，点不了；要往下看请开原网页」；失败「截图也没成…」；「阅读模式」按钮切回 iframe |
| 打得开但 `thin:true`（正文 < 200 字）且 `shot:true` | 阅读页照显示，顶上一条 `.src-thin` 出口栏「这页正文主要靠脚本渲染，阅读模式只拿到一小部分 · 用服务器截图看全」，学习者自己决定 |
| `shot:false` | 什么都不加：失败页本身写了「服务器没装浏览器，截不了图 · 在新标签页打开原网页」 |

探测请求自己失败（网络抖动）不影响 iframe。截图 `<img>` 必须放在**顶层文档**：阅读页在 CSP `sandbox` 里是不透明源，
它发出的请求带不上 `SameSite=Lax` 的会话 cookie，`/shot` 会被鉴权挡下。

### 13.2 服务端（`sources/shot.ts` + `sources/shot-proxy.ts`）

- 浏览器：`SB_SHOT_BROWSER=<绝对路径>` 优先（`off` 关掉），否则 PATH 上找 `chromium / chromium-browser / google-chrome /
  google-chrome-stable / chrome / microsoft-edge`；探测结果进程内缓存；`shotAvailable()` 给 `/probe` 报 `shot`。
- 无头参数（`shotArgs`，纯函数可单测）：`--headless --screenshot=<tmp>.png --window-size=1000,1400 --virtual-time-budget=6000
  --timeout=12000 --user-data-dir=<临时 profile> --lang=zh-CN` + 与其它出站一致的 UA，扩展 / 同步 / 后台联网 / 组件更新全关；
  `--no-sandbox` 只在以 root 运行时加（Chromium 不加它就拒绝以 root 起，非 root 保留沙箱）。
- **守门代理**：每次截图起一个只听 127.0.0.1 的 HTTP 代理，浏览器 `--proxy-server` + `--proxy-bypass-list=<-loopback>`
  把**所有**出站（含回环）交给它；`CONNECT`（https 隧道，不解密）与绝对地址请求（http 转发）两条通道；每个目标主机都过
  `resolveSafeAddress`（与 `fetchSafe` 同一套内网判定，从 `assertSafeUrl` 抽出）并按解析出的 IP 钉住连——
  重定向 / 子资源 / DNS 重绑定都挡在这一层。代理随截图起、随截图关。
- 资源上限：并发 2、排队 4（再来 `busy` 503）、单次 20 s 硬超时（`timeout` 504）、PNG ≤ 8 MB（超了 `failed`）、
  结果按网址缓存 10 分钟 / 12 张；临时 profile 与 PNG 用完即删。
- 失败种类 `ShotError.kind`：`no_browser / blocked / timeout / busy / failed`，`message` 是能直接给学习者看的一句话；
  空响应体的 4xx 页 Chromium 自己不出图（`ERR_HTTP_RESPONSE_CODE_FAILURE`）⇒ `failed`，前端如实说「截图也没成」。

## 14. 侧栏阅读器：页内跳转与划线（2026-10-04）

> 代码：`shared/reader-doc.ts`（块模型 + 选区上下文，纯函数两端共读）、`server/sources/reader-blocks.ts`（HTML→块）、
> `server/sources/reader-page.ts`（装配）、`server/sources/follow.ts`（跳转许可）、
> `web/lib/reader-store.ts`（导航状态）、`web/features/sources/{ReaderView,ReaderBlocks,reader-selection,reader-ask}`。

### 14.0 为什么要改

两件用户直说的事，旧架构都做不到：

1. **「点阅读页里的链接会跳出本站」**。根因在 `sanitizeReaderHtml`：清洗时给每个 `<a>` 硬加了
   `target="_blank"`，于是任何一次点击都是一个新标签页，连续阅读的体验在第一次点击时就断了。
2. **「想划线让 AI 讲解 / 出题 / 存词条」**。阅读页是 `sandbox` iframe 且**不给 `allow-same-origin`**，
   主文档读不到里面的选区。要拿到选区，要么往 iframe 里注脚本（打破 §9「阅读页零脚本」），
   要么把阅读页搬进主文档。

### 14.1 阅读页改为「服务端出结构、前端渲染」

新增 `GET /api/sources/read?session=&url=&title=` → `ReaderPage`（JSON）：
`{ ok, url, title, site, byline, blocks, thin }`。失败也回 **200 + `ok:false`**，面板把原因显示在阅读区里。

- 取页、清洗、缓存与 `/view` **完全共用**（`loadReaderStruct`），不会出现「iframe 看到的」与「划线取到的」不是同一份。
- `parseReaderBlocks` 把清洗后的 HTML 归并成 `ReaderBlock[]`，每块一个稳定 id（`b0`、`b1`…，按产出顺序、与内容无关）。
- 前端 `ReaderBlocks` 渲染成 React 元素，**全程不用 `dangerouslySetInnerHTML`**。
  这是本次改动在安全上的**净收益**：第三方内容不再以标记形态进入 DOM，标签名全由我们写死；
  清洗器漏了什么，也不再等价于主文档被注入什么。服务端白名单清洗仍在，作为第二道。
- 代价：失去了 iframe 这一层纵深隔离。两相权衡后选了前者——清洗 + 结构化双层，比「清洗 + innerHTML + sandbox」更难出事。
- 图片类资料仍走旧的 `ReaderFrame`（一张原图没有正文可划、没有链接可跳）。

### 14.2 页内跳转：每一跳都要人点头

正文里的链接**不渲染成 `<a href>`**，而是按钮 → `askFollow()` 弹确认条：
「要在侧栏打开 example.com 吗？」+ 三个出口「在侧栏打开 / 新标签页 ↗ / 取消」。
渲染成真链接就意味着中键、Ctrl+点仍会跳出去，那条路绕过确认，等于留后门。

点「在侧栏打开」才 `POST /api/sources/follow {session,url}` 登记许可，随后 `/read`、`/view`、`/probe`、`/shot`
的 `authorize()` 才认这个网址（第三条来源，与「在线架」「已落库」并列）。

**这仍然不是开放代理**，理由有三：
- 每一条许可都对应一次**明确的人类点击**，因此可审计——比前端能自行构造的签名更强；
- 许可按会话隔离、上限 `FOLLOW_MAX_PER_SESSION = 200`、TTL 2 小时，进程重启即退回「只认架上网址」；
- **没有抬高能力等级**：同一个已登录用户本来就能用 `POST /api/doc/url`（DOC-RAG-SPEC §10）让服务端抓任意网址。
  follow 只是把同一件事收进「先看见、再确认」的流程里。SSRF 防护仍由 `fetchSafe` 在取页时逐跳负责。

面板自带返回栈（上限 20）。**换资料条目 / 换会话 ⇒ 栈清空**：那时「返回」该指「回到这条资料的上一页」，
而不是「回到上一条资料」。

### 14.3 划线：选区 → 选中句 + 所在章节

`ReaderBlocks` 给每块挂 `data-rb={id}`；`readReaderSelection` 从选区两端 `closest('[data-rb]')` 反查块，
取文档序区间。`sectionForBlock` 再按**标题级别**反查章节：从该块往前找最近的标题，往后收到
**同级或更高级**的标题为止（h2 的章节在下一个 h2/h1 处断，h3 不打断它）。
无标题页退回「前 3 块、后 6 块」的邻域——**不能返回空**，模型没有上下文就会把代词、简称、公式片段讲偏。

预算集中在 `buildReaderSelection`：选区 ≤1000 字、章节 ≤2500 字。放在一处是为了让三个动作
**看到的材料完全一样**，不会长出「讲解送 2500 字、出题送整页」的偏差。

### 14.4 三个动作 → **划词速查小窗**（2026-10-04 改版，契约移交 `docs/LOOKUP-SPEC.md`）

> ⚠️ **本节的初版做法已被推翻。** 初版是「把拟好的提示词塞进对话输入框，让用户按发送」。
> 实测下来两个硬伤：① **污染主对话**——会话里凭空多出一大段用户没打算问的引用；
> ② **失败不可见**——选区在某一步丢了请求照样发出去，模型只能反问「你没有贴出具体划中的那句话」，
> 而界面上完全看不出哪一步错了。第 ② 条是设计缺陷：链路里没有任何一处让人看见「模型到底拿到了什么」。

现在三个动作统一**打开划词速查小窗**（`features/lookup/`，契约 `docs/LOOKUP-SPEC.md`）：

- 答案只出现在小窗里，**不写任何会话**；
- **划中的原文原样显示在窗口顶部**，模型拿到了什么一眼可查；
- 顺序是「先免费后付费」：术语先查维基百科（不烧额度），落空或划的是整句才给 AI 讲解按钮；
- 「存为词条」能复用维基结果直接入库，也可落到 `/api/terms/extract`。

`buildReaderSelection`（§14.3）产出的材料原样交给小窗，**预算与口径不变**——
改的只是「这份材料送到哪里、答案显示在哪里」。

### 14.5 已知边界（登记在案，不是「已覆盖」）

- **jsdom 没有布局引擎**：`Range.getBoundingClientRect()` 恒为 0，真实拖选能否正确拿到起止块
  **测不了**，只能人眼验收。`reader-selection.test.ts` 只钉「没选中就不该亮」与浮条夹取的数学。
- 失去 iframe 隔离的取舍见 §14.1，这是一次有意识的权衡，不是疏忽。
- `/read` 没有做分页：超长页面一次性返回全部块。2MB 正文上限由 `READER_MAX_BYTES` 兜着。
