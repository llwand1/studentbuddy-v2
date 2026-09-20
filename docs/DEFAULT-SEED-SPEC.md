# DEFAULT-SEED-SPEC · 安装包默认服务商 seed 设计稿

> 版本：v0.1 设计稿（未实施）| 日期：2026-09-21 | 依据：老板拍板「默认模型 = 所有角色 agnes-2.5-flash」
> ★ 本稿只读代码写成，未动任何实现文件（`router.ts` 等归在途批次）。CHANGELOG 条目随实施批次同批补（多会话红线）。

## 0. 一句话

`seedIfEmpty()` 已经存在且机制正确，本需求 = **把种子的落点从 openai-default 换成 agnes，并把七角色的 model 从空串预填 `agnes-2.5-flash`**。改动集中一个函数，不是新造机制。

## 1. 实测事实（2026-09-21 现读代码 + 2026-09-20 agnes 实测账）

| 事实 | 出处 |
|---|---|
| 种子函数已存在：空库时插平台 provider `openai-default`（apiKey 空）+ 全角色绑该 provider、model 空串 | `packages/server/src/llm/router.ts:242-261` |
| 调用点在路由挂载处 ×3，幂等（`count>0` 即返；`INSERT OR IGNORE` 不回改用户已改值） | `packages/server/src/routes.ts:198/263/351` |
| 角色共 7 个：explain / quiz-generator / solver / analyzer / summarizer / judge / vision，数组驱动（`MODEL_ROLES`，router.ts:35-45）——加角色零迁移 | 同上 |
| agnes：type=openai 兼容，`base_url=https://api.agnes-ai.cn/v1`，唯一线上 provider `p-mt5x9z75-7snf` | 09-20 实测账 |
| `agnes-2.5-flash` 能看图（答题卡 5/5，1.9–5.8s，七角色通吃）；免费 $0（3.0-flash 促销价同为 $0 但抖动大）；**免费档限制=RPM/TPM+日周总量，同类 key 共享池** | 09-20 实测账 |
| 无启用服务商时报「没有可用的服务商」 | `router.ts:236` |

## 2. 设计

### 2.1 seed 改动（核心，全部在 `seedIfEmpty`）

```
provider:  id='agnes-default'  name='Agnes（默认）'
           base_url='https://api.agnes-ai.cn/v1'  type='openai'
           api_key=''（空，待首配向导填）  owner_id=NULL
role_bindings: 7 角色 × model='agnes-2.5-flash' × provider_id='agnes-default'
```

- 换 seed 落点而非追加：老用户库 `count>0` 直接短路，**零影响**；新装库直接得 agnes 形状。
- 升级路径（已有 `openai-default` 空种子的旧本机库）：**不迁移**。那是占位垃圾行，用户在设置页删不删随意；若 v0.1 前发过带旧 seed 的包再议。

### 2.2 「点开即用」的真实边界（必须写在前端文案里）

seed 完 ≠ 能发请求——`api_key` 为空仍会走到 `router.ts:236` 报错。安装包的首次体验设计为：
1. 首启检测 `providers` 里有无**带 key 的可用行**；
2. 无 → 弹**单字段向导**：「粘贴你的 Agnes API Key（agnes-ai.cn 注册即有免费档）」→ 写入 `agnes-default.api_key`（走既有 `storage/crypto.ts` 加密链，与线上同路径）；
3. 完成。**用户全程只做一个选择题之外的动作：贴一次 key。** 模型选择器不出现（已由 seed 预绑 2.5-flash），这正是「所有选项都选 agnes-2.5-flash」的落点。

### 2.3 风险与对策

| 风险 | 判定 | 对策 |
|---|---|---|
| 免费档共享限制池，多装机用户各用自己的 key ⇒ 单人撞限 | 低（各 key 独立池） | 429 报错文案指向 agnes 限额页 |
| agnes 服务停摆/改价 ⇒ 安装包默认档失效 | **中**（促销价「随时可恢复」是 09-20 账） | 安装包不做远端封死：设置页保留换服务商入口；发布前跑 `_probe` 复测（见 §3） |
| model 名改名（agnes-2.5-flash → 其他） | 低 | 设置页可改，非砖 |
| 密钥提取 | 不存在 | 包内不内置任何 key，seed 的是空串行 |

## 3. 实施前闸门（预言 + 复测）

- **预言**：改后新装形态首启，未贴 key 前每个 AI 功能给清晰引导文案（不是裸 500）；贴 key 后七角色全链路通。
- 复测（实施当日跑）：`_probe` 对 `agnes-2.5-flash` 打一发 chat + 一发看图——**09-20 账已过一天，可得性必须现测不追认**。
- 测试：`router.test.ts` 补两锁——①空库 seed 后 `role_bindings` 七行 model 均为 `agnes-2.5-flash`；②已有用户 provider 时 seed 不动任何行。

## 4. 涉及文件面（实施批次申报用）

`packages/server/src/llm/router.ts`（seedIfEmpty 本体）、`packages/web/`（首启向导单字段弹窗，具体挂点实施时定）、`packages/server/src/llm/router.test.ts`、CHANGELOG + docs/dev/test-plan 登记。**除 web 挂点外全部是在途批次（vision/coach/review）的活跃区之外，实施仍须开工前 re-grep。**
