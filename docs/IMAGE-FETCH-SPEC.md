# IMAGE-FETCH-SPEC — `fetch_image` 图片搬运契约

> 版本：v1.0 | 状态：[已落地] | 日期：2026-09-20（`fetch_image` 图片搬运批，老板拍板「就直接搬图」）
> 关联：`docs/TOOL-ECOSYSTEM-SPEC.md` §5.3（fetch_page 同族网络读工具）｜`docs/QUIZ-IMAGE-SPEC.md`（出题配图，本批后的预期受益方）

## 0. 背景与动机

本批之前，studentbuddy 的图片链路是「**渲染口通、取图口断**」：

| 环节 | 本批之前的状态 |
|---|---|
| 渲染 | `web/src/lib/markdown-inline.ts` 已支持 `![alt](url)` 出 `<img>`（2026-09-20 补） |
| 取图 | **全断**：`fetch_page` 的 `TEXTUAL_CT` 白名单把 `image/*` 挡在门外（fetch-page.ts:42）；`looksBinary()` 在原始字节上嗅探 PNG/JPEG/GIF 魔数命中即拒（:59-72）；`search_web` 只回文本片段 |
| 结果 | 模型只能在正文里**编**图片 URL ⇒ 裂图 |

本批新增第三个网络读工具 `fetch_image`：模型给 URL → 服务端取图、判型、落盘缓存 → 回灌站内地址与「怎么写进正文」的用法。**零迁移、零新依赖**。

## 1. 工具契约 `fetch_image`

- **入参**：`{ url: string }` —— 图片的 http(s) 地址。
- **元数据**（§4.2 口径）：`kind='network'` + `idempotent`（⇒ 免确认、静默重试资格）；**不设** `timeoutMs`（内部 15s HTTP 超时是工具自己的事，拉高档位基线会污染三个消费方的共同事实源）；无 `planWrite`；`needsConfirm` 留空由 kind 推。
- **处理管道**：`search/ssrf-guard.ts` 的 `fetchSafe`（SSRF 同 fetch-page 禁区：内网地址拦下后**回灌文案不含该地址与端口**）→ 流式限长 **4MB**（超 `content-length` 当场拒；**不给 content-length 也按字节流限长**——谎报体量不该能打穿内存）→ **字节魔数判型** → 落盘缓存 → 回灌。
- **★ 判型在字节上、不在声明上**：图床把图片声明成 `application/octet-stream` 是常态；按 `content-type` 判会把真图全拒。白名单六种：PNG / JPEG / GIF / WebP（RIFF 容器必须同时有 WEBP 尾标，不把 .wav/.avi 当图收下）/ BMP / AVIF；残缺头不算命中。
- **★ 刻意不收 SVG**：SVG 是文本、无魔数可判；且同源直接打开会执行源站脚本（活动内容）。SVG 场景走既有 `quiz-image`（模型自绘）或 html 卡片通道，不并入本工具。
- **回灌口径（B-006 同族纪律）**：
  - 成功：**必须教「怎么写进正文」**——回灌含「用 `![说明](/api/images/<name>)` 写进正文」的用法说明。只说「取到了」，模型会裸写地址、学习者看不到图。
  - 非图片（HTML/文本）：如实说不是图片，**一个文件都不落**。
  - SVG：**单列说明**（它是文本、无魔数，不点明的话用户只会觉得工具坏了）。
  - 超大：文案带上限（4MB）与出处。
  - URL 空白：提示带 url 重调，且**一次请求都不发**。
  - HTTP 404：如实报状态码，且**显式禁止说成「这张图不存在」**（图床 404 ≠ 图不存在，可能是防盗链/临时故障）。

## 2. 存储层 `storage/image-cache.ts`

- 落盘目录：`DATA_DIR/images/`（`resolveDataDir` 解析，与库同 DATA_DIR）。
- 命名：**内容 sha256 派生**（`<32hex>.<扩展名>`）⇒ 同内容两次落盘同一文件（`created:false`），去重是**实现的**不是声明的；不按 URL 或时间命名。
- 读侧闸门（供路由复用）：`/api/images/` 之后的段必须是 `<32hex>.<白名单扩展名>` 的**强正则白名单**，穿越/绝对路径/错扩展名/大小写不符一律拒绝（路径穿越闸门＝白名单不是黑名单）。
- **为什么落盘不违反「AI 零写盘」红线**：该红线约束的是**让 AI 直接写用户文件系统**（词条库等业务数据都有确认门/审计）；图片缓存是服务端对**外部资源**的只读镜像，内容经魔数判型与哈希命名约束，既非用户数据也非模型自由输出，与 `preview` 内存暂存同属「服务端自管资产」。

## 3. 出图路由 `GET /api/images/:name`（`routes/images.ts`，index.ts 挂载 `/api/images`）

- `:name` 过存储层同一条强正则闸门后才读盘（**先验形状再碰文件系统**）。
- Content-Type 按扩展名映射返回**准确值**——全局安全头有 `X-Content-Type-Options: nosniff`，类型不准则浏览器拒绝渲染。
- 命名含内容哈希 ⇒ 内容不可变，响应带 `Cache-Control: public, max-age=31536000, immutable`（长缓存安全：同一地址永远是同一张图）。

## 4. 前端白名单（`web/src/lib/markdown-inline.ts` 的 `safeImgSrc`）

- 放行集合 = `http(s)://` + **站内缓存形态** `/api/images/<32hex>.<白名单扩展名>`（同源跟随部署域名与 vite 代理）。
- **形状卡死，不做宽容**：大写 hex 不认（合法写法只有一种，不留第二套）、扩展名只认白名单（`.svg` 不认——同源脚本面）、尾随穿越与查询串不认。
- 照旧挡下：`data:` / `javascript:` / `sb:incomplete-image` 流式占位（挡下后回落 alt 文字，不出破图不出内部串）。

## 5. 触发机制（成章单列——§N15：加工具不配触发层＝功能不存在）

`chat/system-prompt.ts` 联网段新增一条：**需要展示图片时（用户要图、你找到的网页带真图、配图能让解释更直观）调 `fetch_image` 取图，然后必须用 `![说明](/api/images/…)` 语法把图写进正文**；不要自己编造图片地址——编出来的必然裂图。工具回灌里的用法说明是第二重触发（模型每用一次都被教一遍格式）。

**预期收益接线**：`quiz-image` 出题配图、词条释义配图此后可搬真实图片，而非只靠模型手绘 SVG。

## 6. 已知边界（诚实记账）

1. **外网图 URL 仍可能拿不到**：`search_web` 的 Exa highlights 只回文本，不带图片来源 URL——模型目前只能从 `fetch_page` 的正文里「看见」图片地址之外的线索或用户给的 URL。「搜索引擎直接返回可搬的图」是后续批（需搜索 API 的 image 端点，如 Exa/DuckDuckGo images），本批不做。
2. **无缓存上限/清理**：`DATA_DIR/images/` 只进不出，靠内容哈希天然去重压体量；磁盘水位监控归 DATA_DIR 治理统一管，本批不单做。
3. **GIF 动图第一帧照搬**：魔数判型不校验帧结构，取回来是什么就是什么。
4. **不做图片转码/压缩**：超 4MB 直接拒，不做「压缩到能收」。

## 7. 测试与门禁登记

- 新增 `server/src/storage/image-cache.test.ts` **12 例**、`server/src/chat/tools/fetch-image.test.ts` **13 例**；`web/src/lib/markdown.test.ts` 35→**37**。逐条锁点见 `docs/dev/test-plan.md` §3 对应行（test-plan v0.2.87）。
- 本批红线内自检：新文件行数 212 / 141 / 38，均低于 server ≤400 红线。
