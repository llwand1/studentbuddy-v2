# 工程文档（ENGINEERING）

> 更新：2026-09-27
> 面向：读码的人、复验工程的人、想看「难在哪、怎么证的」的人。
> 契约正文在 `docs/*SPEC*.md`（**改行为先改契约**）；本文讲工程约定、复验方式与仓库结构。

---

## 1. 工程约定

这些约定由 CI 强制，不是口号。

**代码规模**
- `packages/server/src` 单文件 ≤400 行；`packages/web/src` 的 `.tsx` ≤300 行，超过就拆文件——`chat/flow.ts` 贴线开新文件是常态。
- 理由很实际：一个文件里同时放着协议解析、编排与错误上报时，改动的影响面用眼睛估不出来。

**类型与样式**
- 全仓禁 `any`（`: any` 与 `as any` 都不许），tsc 与 eslint 双拦，门禁再兜底扫一遍。
- `packages/web` 禁内联 `style={{`，一律走 `tokens.css` 的 token；数据驱动的动态值可加 `gates:style-ok` 行注释显式豁免。

**测试**
- 改代码必带测试。每个 `*.test.ts(x)` 都必须在 [`TEST-PLAN.md`](TEST-PLAN.md) §3 成行——新增测试文件未登记则门禁直接红；登记了但文件不在，幽灵行同样红。
- 测试清单里的基线数由 `node tools/metrics.mjs --tests` 当场产出，**不许手抄**。

**契约先行**
- 改行为先改契约：`docs/*SPEC*.md` 是行为契约，契约落定后才动实现。
- 契约与实现冲突时，以**代码 + 测试**为准，并回头把契约改对。

**改动记录**
- 每个已发布版本的对外说明见 [`CHANGELOG.md`](../CHANGELOG.md) 与 GitHub Releases，两者同源。

## 2. 四条复验命令

> 立场：**文档说的任何话都可以不信，下面四条命令的输出可以当场信。**

| # | 命令 | 证明什么 | 耗时量级 |
|---|---|---|---|
| ① | `npm run check` | tsc×3 ＋ eslint ＋ vitest 全量 ＋ 四项门禁一次跑绿 | 分钟级 |
| ② | `npm run demo:e2e` | **确定性全栈**：注册 → 假 LLM → SSE → 落库 → 杀进程重启后逐字仍在；零 API key、零真实外呼 | ~3 秒 |
| ③ | `node tools/metrics.mjs --tests --check` | README 与首屏的每个可核对数字对代码实测对账，漂移即退出码 1 | 十秒级 |
| ④ | `node tools/guard-audit.mjs` | **每条守门逐个改坏、证明它真的会红**（含审计器自证 `--selftest`），全程在隔离副本里跑、不碰工作树 | 分钟级 |

## 3. 三道最难的工程问题

> 每道只留「问题一句话 / 解法一句话 / 怎么复验」；完整版（Problem → Design → Implementation → Test → Trade-off，含被否掉的方案与代价）见 [`INTERVIEW.md`](INTERVIEW.md) §3。

**① 模型输出不可靠，但学生不能拿不到题**
- **问题**：出题协议要求模型一次产出结构化题组，而它会少括号、坏转义、SVG 不闭合、把解析塞进题干——批量生成里这是常态不是异常。
- **解法**：五级解析阶梯（无损补括号 → 原样 parse → 剥图重试 → 截断逐题回退 → 回退后再剥图）＋ **丢图保题**（残缺的几何图比没图更糟，会教错学生 ⇒ 只删该题 `svg` 字段，题目照常交付）＋ 图片交付状态四态如实上报（绝不拿「开关已开」冒充「图已交付」）＋ 缺几题说几题、不补题。
- **复验**：阶梯各级有单测；`npm run demo:e2e` 跑出题 → 作答 → 判分 → 统计全链。

**② 流式输出不许丢字、不许重字，断线还要能接上**
- **问题**：网络抖动或标签页休眠会断流；重连时上游会把 token 再推一遍；上游自己挂起则会让会话永久卡住。
- **解法**：轮内序号严格 +1（回放去重的地基）＋ 重连只回放已完成轮（不重放 token）＋ 空闲超时 120s / 一次性总时长 180s（超时抛可读错误）＋ 两层并发闸门（每用户 2 路 ＋ 全站封顶，超额明确拒绝而非无限排队）＋ 「流什么就存什么」不变量。
- **复验**：`npm run demo:e2e` 把「序号单调」「屏上与库内逐字相等」「重连不重放」三条断言变成机器证据。

**③ 多用户数据的归属要彻底，不能靠到处写 WHERE**
- **问题**：读「一批行」与读「一个聚合值」是两种形状——只用一把过滤锁，前者会串出别人的行，后者会**静默返回任意一行**（不报错，直接串台）。
- **解法**：读写按形状分两把锁（`ownerFilter` / `ownerForWrite`）；跨用户访问一律 **404 不回 403**（403 等于承认「这个 id 存在」）；成本归属 `providers.owner_id IS NULL` ＝ 平台通道、业务表 `''` ＝ 无主——两种「没有主人」的可见性刻意相反，因为语义本来就相反。
- **复验**：见 [`TENANCY-SPEC.md`](TENANCY-SPEC.md) §8；`npm run demo:e2e` 现场演示 B 读 A 撞 404。

（第四类——**AI 产出内容的安全**：模型写的 ` ```html ` 在 `CSP: sandbox` ＋ iframe 双层沙箱里跑、页面源为 `null`；SVG 净化剥 `<image>` 外链防信标泄露 IP；外部搜集结果逐字锚点锁 ＋ 两段确认才入库。证据见 [`INTERVIEW.md`](INTERVIEW.md) §3-D。）

## 4. 目录结构与代码地图

**顶层**

| 路径 | 是什么 |
|---|---|
| `packages/shared/src/` | 契约与纯函数，前后端共用一份。约 50 个源文件，扁平结构 |
| `packages/server/src/` | 全部业务域，按域分目录：`chat/`（对话编排与工具，最重的一块）· `learning/`（出题、词条、复习、文档检索）· `llm/`（供应商抽象与闸门）· `routes/`（HTTP 入口）· `storage/`（迁移与仓储）· `auth/` · `pk/` · `search/` · `growth/` · `events/` · `mail/` |
| `packages/web/src/` | React 18 前端，**零第三方运行时依赖**。`features/`（按功能分目录）· `app/`（应用壳与一级视图）· `seo/`（静态页与词条页生成）· `lib/` · `components/` · `styles/` |
| `tools/` | `gates/` 门禁 · `e2e/` 全栈演示 · `probes/` 真机 CDP 探针 · `metrics.mjs` 量化产出 · `guard-audit.mjs` 守门自检 · `deploy.sh`、`docker/` 部署 |
| `docs/` | 行为契约（`*SPEC*.md`）与工程文档 |

**想看 X，打开这里**（更细的一份见 [`INTERVIEW.md`](INTERVIEW.md) §5）

| 主题 | 入口 |
|---|---|
| 一轮对话的完整编排 | [`chat/flow.ts`](../packages/server/src/chat/flow.ts) ＋ [`chat/context-segments.ts`](../packages/server/src/chat/context-segments.ts) |
| SSE 帧序与断线恢复 | [`chat/sse-bus.ts`](../packages/server/src/chat/sse-bus.ts) |
| 出题的可靠性阶梯 | [`learning/quiz.ts`](../packages/server/src/learning/quiz.ts) |
| LLM 供应商抽象与并发闸门 | [`llm/router.ts`](../packages/server/src/llm/router.ts) ＋ [`llm/upstream-gate.ts`](../packages/server/src/llm/upstream-gate.ts) |
| 账户与归属隔离 | [`server/src/auth/`](../packages/server/src/auth) ＋ [`routes/tenancy.test.ts`](../packages/server/src/routes/tenancy.test.ts) |
| 数据库迁移（40+ 版本可重放） | [`storage/migrations.ts`](../packages/server/src/storage/migrations.ts) ＋ 分片 `migrations-list-v*.ts` |
| AI 内容消毒 | [`lib/svg-utils.ts`](../packages/web/src/lib/svg-utils.ts) ＋ [`routes/preview.ts`](../packages/server/src/routes/preview.ts) |
| 工程门禁本身 | [`tools/gates/check.mjs`](../tools/gates/check.mjs) ＋ [`tools/guard-audit.mjs`](../tools/guard-audit.mjs) |

## 5. 门禁与扩展模式

`npm run check` ＝ `lint`（tsc×3 ＋ eslint）＋ `test`（vitest）＋ `gates`。四项门禁：

1. 行数红线（server ≤400 / web `.tsx` ≤300）
2. 禁 `any`
3. web 禁内联 `style={{`
4. 每个测试文件必须在 [`TEST-PLAN.md`](TEST-PLAN.md) §3 成行

**加一项新功能时的扩展顺序**（哪一步漏了，后面都会返工）：

1. **先写/改契约**（`docs/*SPEC*.md`）：接口形状、边界、错误码、不变量。
2. 在 `packages/shared` 落纯函数与类型，前后端同源。
3. 在 `packages/server` 落域逻辑与路由；带写副作用的能力必须实现 `planWrite`（**只算不改**）走确认门。
4. 在 `packages/web` 落 UI；自绘渲染器优先，不引第三方 UI / Markdown / 图表库。
5. **测试**：单测放实现旁边（`*.test.ts`），新文件同步登记进 [`TEST-PLAN.md`](TEST-PLAN.md) §3。
6. **对外说明**：已发布时补 [`CHANGELOG.md`](../CHANGELOG.md) 与线上更新页。

## 6. 配置说明

- **运行形态由一处判定**：`packages/server/src/auth/form.ts` 是形态的唯一事实源（`SB_REQUIRE_AUTH` 开 ＝ cloud、关 ＝ local）。「本地有、线上没有」的行为一律从这里判断，不许各处自己读 env。
- **AI 服务商 / 搜索 key / 生图模型绑定**都在设置页配置；密钥 AES-GCM 密文入库，接口只回布尔，不回明文。
- **部署相关**（端口、TLS、备份、回滚、环境变量清单）见 [`DEPLOY.md`](../DEPLOY.md) 与 [`tools/docker/`](../tools/docker)。
