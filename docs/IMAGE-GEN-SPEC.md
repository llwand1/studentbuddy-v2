# IMAGE-GEN-SPEC — 聊天内生图契约

> 版本：v1.0 ｜ 状态：[活跃] ｜ 日期：2026-09-27
> 来源：老板点单「让 studentbuddy 真正的接入生图模型」，范围经选择题四项裁定：**聊天内画图** ＋ **复用 BYOK/平台双通道** ＋ **平台通道每日每用户限额** ＋ 先契约再落码。
> 上游事实：聚合通道现役生图模型 `agnes-image-2.5-flash`，OpenAI 兼容端点 `/v1/images/generations`（v0.2.91 批曾因误绑到 vision 角色暴露过该端点）。

---

## 0. 一句话与范围

**给聊天 AI 一把新工具 `generate_image`**：模型判断"这里画一张图更清楚"就调用，服务端走既有 provider 双通道打生图端点，产物落进既有 image-cache，正文用既有 Markdown 图片语法渲染。**前端渲染零改动、零数据库迁移。**

**做**：工具 `generate_image`（文生图单张）／第 9 个模型角色 `image`／平台通道日张数闸／错误翻译器 `image-error.ts`。
**不做**：图生图/局部重绘/批量；词条配图、知识大陆 sprite、笔记配图（二批评估）；前端新组件；数据库迁移。

## 1. 复用清单（本批只铺"最后一段"）

| 既有设施 | 复用方式 |
|---|---|
| provider 双通道 + `routeRole` 三档查序 | `image` 角色一次普通绑定；凭据 env 注入规则一字不改 |
| `MODEL_ROLES` 数组驱动 | 设置页自动出「生图（画图）」行、一键默认自动带上 |
| `storage/image-cache.ts` | `saveImage(bytes, ext)` + 魔数嗅探 + 内容 hash 命名 |
| `GET /api/images/:name` | 出图零改动（名字正则天然放行 png，长缓存） |
| 正文渲染 `![alt](url)` | 前端零改动 |
| `chat/tools` 注册表 / 分档超时 / 工具统计 | `kind:'network'`（60s 档）；`tool_called` 事件自动落 `tool_stats` |
| 两层并发闸 + 250 次/5h 次数表（upstream-gate） | 生图照走（平台真金，同一条闸） |

## 2. 数据与通道契约（零迁移）

**不新增表、不新增列。**平台凭据依旧只在 env（`SB_PLATFORM_API_KEY`），平台行 `api_key` 恒空串。

### 2.1 新角色 `image`

- `shared/domain.ts` 的 `ModelRole` 追加 `'image'`；`router.ts` 的 `MODEL_ROLES` 追加 `{ role: 'image', label: '生图（画图）' }`（数组驱动 ⇒ 设置页/一键默认/默认绑定 INSERT 全自动）。
- **仅 OpenAI 兼容服务商可绑**（anthropic 原生协议无生图端点）：写口 `PUT /roles/:role` 400 断言 ＋ 运行时 `RoutedTarget.type` 二判，双闸。
- **默认模型与聊天角色分家**：`defaultModelFor('image')` → `imagePlatformDefaultModel()`（env `SB_IMAGE_MODEL` > 常量 `agnes-image-2.5-flash`）。★ 不能共用 `platformDefaultModel()`——聊天默认名打生图端点必 404，且是「一键默认配完就挂、报错全是上游英文」的最难查形态。
- 未绑定不是错误：`roleReady` 的可读理由 + 「去设置页给生图绑模型」的指引回灌。
- 既有库升级后 `role_bindings` 没有 image 行 ⇒ 走三档查序的 ③（平台默认 provider + 角色感知默认模型），行为照常。

### 2.2 上游端点

```
POST {provider.base_url 去尾斜杠}/images/generations
Body: { model, prompt, n: 1, size, response_format: 'b64_json' }
```

- 响应**双兼容**：`b64_json` 直解；`url` 则经 `fetchSafe`（SSRF 逐跳复检不豁免——上游给的地址也是第三方地址）下载。
- `size` 白名单 `1024x1024 / 1024x1792 / 1792x1024`，白名单外回落方形，不透传。
- 超时：内部总时长 **50s**，**必须短于**调度层 network 档 60s——内部先响，回灌文案才不被 `工具执行失败：…` 的壳包走。

## 3. 工具契约 `generate_image`

| 项 | 值 |
|---|---|
| 参数 | `prompt`（必填，截 1000 字符）、`size`（可选，白名单回落） |
| kind | `network`（60s 档超时） |
| idempotent | **`false`**——每次调用真金白银出新图，network 档"同参重放免费重试"资格被它挡住 |
| description | B-006 口径：正面陈述能力＋触发场景＋「地址必须 `![说明](地址)` 写进正文」＋失败不许编造 |
| 回灌成功 | 同 `fetch_image.okText` 结构：站内地址＋用法示范 |
| 回灌失败 | 原因（见 §6）＋「你具备这能力，只是这次没成」＋不许编造护栏句 |

## 4. 落盘与出口

`sniffImage` 判**原始字节**（不信任自报类型，B-011 同款）→ `saveImage` → `/api/images/<32hex>.<ext>`；出口零改动，历史回放天然可渲染。响应既无 b64 也无 url / 字节不是图 → 如实报错不落盘。

## 5. 配额与风控（`llm/image-quota.ts`）

| 通道 | 限制 |
|---|---|
| BYOK | 不限张数（用户付钱）；仅并发 1 |
| 平台（登录用户） | **每用户每日 N 张**，env `SB_IMAGE_DAILY_LIMIT` 默认 **15**；`0` ＝ 平台生图整体关闭（已知状态，文案说清不是坏了）；非法值回落默认，**配置错误不许悄悄拆闸** |
| 本地单人模式（`ownerId === null`） | 不计张数——与 LLM 侧 `meteredOwner` 的既有口径逐字一致 |

- **计次落点 ＝ `tool_stats`**（不是 event_log——它没有 owner 列）：`tool / owner_id / ok / created_at` 四要素恰好够，**零迁移**，且与设置页「工具」卡同表同数。
- **只数 `ok = 1`**：上游 429 没出图，不该让用户白付张数。
- **日界按本地日历日**：`localDayStartUtc()` 算本地零点的 UTC 串与 `created_at`（`datetime('now')`）比较——「每天 15 张」按用户本地午夜重置，不是东八区早上 8 点。
- **并发 1**（进程内 Set，单机部署口径同 upstream-gate「已知边界」）：封 check-then-act 竞态（日限 15 能并发打出 29 张的洞）＋ 防轰炸上游。
- **判定顺序不可换**：没配 → 协议不对 → 张数闸 → 并发坑 → 上游。到顶**不发起上游请求**。
- ⚠️ **已知保守偏置**：同用户同日 BYOK+平台混用时（绑定 provider 停用会整条回落平台），计数分不出通道，BYOK 成功张数也占平台额度——宁紧勿松；解开来要迁移，收益不抵。
- 生图调用同时受 LLM 侧 250 次/5h 次数表约束（同一条 acquireUpstream），与聊天共用平台成本闸。

## 6. 错误翻译器 `llm/image-error.ts`

`explainImageGenerationFailure(status, body, model)` 纯函数，分支**最具体的排前面**：内容策略拒绝（可包在任何状态码里，故在状态码前判）＞ 模型不像生图模型（model 特征 + 404/400 → 指去设置页换绑）＞ 401（密钥失效）＞ 403（欠费/无权限）＞ 429（等十几秒）＞ 404（地址没生图接口）＞ 5xx（他们的问题）＞ 兜底不猜病因。每条末行附 `上游原文：`（压平、截 240 字）——翻译不是掩埋。反向锁（遮特征不得误判）由测试钉住。

## 7. 前端影响面

渲染零改动；设置页角色行数组驱动自动出现「生图（画图）」行。**绑定 UX 三件**（老板点单补齐，否则没法测）：① `GET /providers` 出站加 `type` 字段（shared `Provider` 同批加列，`getProviders` 唯一构造点）；② `providersForRole()` 纯函数——image 角色只给 OpenAI 兼容服务商（与服务端 `PUT` 断言同口径，缺 `type` 的旧形状按可绑处理向后兼容）；③ 分区提示语写明"生图只能绑 OpenAI 兼容服务商，绑平台留空模型即用平台默认生图"。**最省的测试路径＝生图行绑平台服务商 + 模型选「（用默认模型）」→ 自动落到 `agnes-image-2.5-flash`。**

## 8. 测试与验收

45 例新锁（后 +4＝设置页过滤批）：image-quota 8（env 解析含 `Number('')` 陷阱／日界边界／计数四则／并发坑）、image-error 11（七分支＋截断＋两条反向锁）、image-gen 15（b64/url 双路径真落盘／size 回落／env 优先／BYOK 豁免／到顶不发上游／limit0／并发 busy／429 翻译／anthropic 挡下／没绑定／坏响应／嗅探丢弃）、generate-image 7（元数据／B-006 提示词锁／description 用法锁／回灌与事件序列）、RoleRow.test +3 与 image-gen.test +1（providersForRole 过滤／type 出站／缺 type 向后兼容）。

**实现期逮到的真坑（已修并锁死）**：`Number('') === 0`——`SB_IMAGE_DAILY_LIMIT` 未配时被当成 `0`（整体关闭），零配置部署的生图会一行没跑就全灭。`normalizeImportance` 同族（AGENTS.md 记过），`imageDailyLimit` 先拦空串。

**真机验收欠账**：真 key 打真上游的端到端未跑（沙箱无凭据），收工时如实登记；首张真机图出来前，本功能按「未真机验收」对待。

## 9. 二批展望（只立项不承诺）

词条库配图（`POST /api/terms/:id/illustrate`）→ 知识大陆素材（像素风格一致性先做小样本实验）→ 复习笔记配图 → 前端生图服务商过滤。
