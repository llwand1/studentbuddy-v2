# STUDY-FLOW-SPEC — 学习流（控制流 + 知识数据）v1.0

> 状态：**2026-09-16 立，码已落地**（v0.2.27）。契约先行（AGENTS.md 工程红线）本批**倒置**了：
> 老板的指示是「你都已经知道他是已经成熟的效果了，那么我建议你直接去仔细看看现成的代码为参考比较好」，
> 于是先读真实成熟实现（LangGraph / n8n / Dify）的源码定架构、再落地代码，**本文件随后补齐并与代码实况对齐**。
> ⚠️ **本文件是在代码之后写的**，故文中每一处都在描述**已发生的实现**；凡与代码不符，以代码为准并改本文件。
>
> 上游需求（老板原话，两段，意图有演进）：
> ① 「我想要一个『学习流』的功能……把每一轮对话或每一个词条成为一个节点……利用相关性或从属性去构建一个学习历程的图……
> 点击任意节点都可以看到节点内的词条或错题笔记……并且这些关系是一次对话中一轮轮对话中产生的……」
> ② 「我补充一点，那就是既要有控制流也要有知识数据，比如控制流可以按用户规定的方式来产出知识数据，也就可以让用户的
> 学习体验在一定程度上形成『流』……把学习过程给控制流化……每一个『点』都是一个自定义的学习交互体验，然后每一个交互
> 体验是可以被当成『点』去编排的，也就是用户可以自己定义下一步执行哪个学习交互体验」。

---

## §1 三层架构（本域的全貌）

学习流不是一个功能，是**三层东西叠在一起**。混讲就会把「用户编排的流」误建成「图结构」，本仓刻意不这么做。

| 层 | 是什么 | 谁定义 | 存在哪 |
|----|--------|--------|--------|
| ① **步骤注册表** | 预定义的「学习交互体验」清单（六种） | **代码**（本仓） | `shared/src/study-flow.ts` 的 `FLOW_STEP_METAS` + `server/src/learning/flow-registry.ts` 的执行器 |
| ② **控制流** | 用户把步骤连成的**流定义** + 每次**运行实例** | **用户** | 表 `flow_def`/`flow_step`/`flow_edge`（定义）+ `flow_run`/`flow_run_step`（运行） |
| ③ **知识数据图** | 控制流按用户规定的方式**产出**的学习产物 | **由 ① + ② 运行产生** | 表 `knowledge_node`/`knowledge_edge` |

### §1.1 ★★ 图静态、流动态（本域最重要的判断，改码前必读）

读 **LangGraph.js** 源码（`libs/langgraph-core/src/graph/state.ts`）得到的事实：`StateGraph` 的
`addNode`/`addEdge` **必须在 `compile()` 之前写完**，编译后拓扑固定；**只有节点内部**能靠 `Command({goto})`
动态决定下一步。即 **结构静态、逻辑动态**。

⇒ 由此推出本仓的核心设计：**用户编排的流不当成图结构，当成数据**。
`flow_step`/`flow_edge` 两张表就是这份数据，由一个**固定不变的运行器**（`study-flow-run.ts`）解释执行。
好处：用户随便拖多少节点、连成什么形状，**引擎代码一行不改**；也不会出现「用户编的流要在运行时
`addNode` 到 LangGraph 实例上」这种既不合法（compile 后不能改）又难维护的做法。

### §1.2 与两条外部实现的对应（不是自创）

| 外部 | 读到的源码事实 | 本仓落点 |
|------|----------------|----------|
| **n8n** `packages/workflow/src/interfaces.ts` | `INode{ id, name, type, typeVersion, position, parameters }`——节点类型是**注册表里的键**（非自由文本），**每个类型自带版本号**，属性与坐标均落库 | `flow_step` 的 `kind`（注册表键）+ `type_version` + `params` + `position_x/y`；连接用 **id 而非 name**（n8n 用 name 作连接键，改名即断链，**不学它**） |
| **Dify** `web/types/workflow.ts` | `FetchWorkflowDraftResponse.graph = { nodes, edges, viewport }` + `version`；**`WorkflowRunHistory` 把当次运行的 graph 整份存下来**；`NodeTracing` 逐节点轨迹；`workflow_paused` + `paused_nodes`；`NodesDefaultConfigs{type,config}[]` | `flow_run.def_snapshot`（定义快照）、`flow_run_step`（= NodeTracing）、`status='paused'` + `pause_reason`、`FlowStepMeta.params` |

### §1.3 范围红线（老板拍板的边界，越界即改判）

- **用户能自定义的是「选哪种交互 + 填什么参数 + 下一步连给谁」**，
  **不是「造一种新的交互体验」**。故 `FlowStepKind` 是**有限枚举**、不是自由文本。
- 想加第七种交互 ⇒ **加在注册表里**（shared 加一条元信息 + server 注册一个执行器），**不给用户开脚本口子**。
- 全图视图**本版不做**（大小与可读性都不成立），只做**局部邻域**（见 §3.3）。

---

## §2 控制流·定义层（用户编排的模板）

### §2.1 数据契约（v18 迁移，三张表）

```sql
flow_def (id PK, name, description, version, created_at, updated_at)
flow_step (id, def_id, kind, type_version, label, params, position_x, position_y,
           order_index, created_at, PRIMARY KEY (def_id, id))
flow_edge (id PK, def_id, from_step_id, to_step_id, from_port, label, created_at,
           UNIQUE(def_id, from_step_id, from_port, to_step_id))
```

★★ **`flow_step` 的主键是 `(def_id, id)` 复合，不是 `id` 单列**。步骤 id **只在所属流内唯一**
（n8n 的节点 name 同为「工作流内唯一」口径）。做成全局主键的后果本批实测踩到过：
画布按本地序号生成 id 时必然撞车，**连「克隆一条流」都会因 id 复制而 `UNIQUE constraint failed`**。
⚠️ 该主键是**就地修正**的（未另起 v19）——理由是学习流本批首次发布、v18 尚未应用于任何真实库。
**若已发布则绝不可如此**，那时必须新增迁移（已应用的版本号是历史锚点，改了只会让新库与老库结构分叉）。

### §2.2 出口端口

`from_port ∈ { next, correct, wrong }`：
- `next` —— 无条件顺序（默认值，绝大多数字段都用它）
- `correct` / `wrong` —— 条件分支，「答对走下一题、答错走复盘」这类流靠它成立

### §2.3 CRUD 语义（几个刻意选择）

| 操作 | 语义 | 为什么 |
|------|------|--------|
| `updateDef` | **整体替换**（步骤/边全量重写） | 画布保存本来就是整份提交；做成增量 patch 就要处理「先删后加的 id 复现」，得不偿失 |
| `updateDef` 成功 | **`version` 递增** | 运行快照据此区分新旧定义（§6.3） |
| 校验失败 | **拒绝且不写半截**（库里不留残行） | 半截定义比没有定义更糟：用户在画布上看到的与库里存的不一致 |
| `removeDef` | 删定义 + 删其步骤与边（**不留孤儿行**），**但不级联删运行** | 运行有自己的定义快照（§6.3），删定义后历史运行**照样能读完** |
| `cloneDef` | 新 id、步骤与边原样复制 | 「固定化复用」最常用的动作 |

#### §2.3.1 新建为什么给**模板**而不给空壳（2026-09-17 老板实测反馈）

**现象**：点「新建」→ 进配置面板 → 立刻是「必填」空着，一保存就被拒
「步骤「讲解」缺少必填参数：讲解主题（topic）」。

**归因**：**校验没错，是起点给错了**。原实现只给**一个 `explain` 空步骤**，而 `topic` 是
`required` 且没有默认值；更关键的是**服务端在保存期就校验参数**（`validateDefInput` →
`validateStepParams`），所以一个缺必填的空白起点**连存都存不下**。用户面对一条空白流，
无从知道「一条学习流长什么样、步骤怎么连、参数该填什么形式」。

**参考**（核过文档与源码，不是凭印象）：

- **Dify**：新建应用的第一步就是**选模板**（「从空白创建」只是选项之一），节点与参数都已配好；
- **n8n**：lint 规则 `node-param-default-missing` **强制每个参数必须有 `default`**
  （`required` 只约束执行期、不阻断配置），另有 workflow template 库可一键导入。

⇒ 两家共同的取舍：**先给一份能跑、可照抄的东西，再让用户改**。

**本仓落地**：`flow-templates.ts`（三个模板：四步课堂／错题重练／考前速通，各带示例参数与
`why`「为什么这么连」）+ `TemplatePicker.tsx`（「新建」先展开模板选择）。

★★ **硬约束：每个模板的每一步都必须能过 `validateStepParams`**
（`flow-templates.test.ts` 逐模板逐步骤钉住，用的是与服务端执行期**同一份**代码）——
「用模板新建出来的流开箱就能跑」是**机器可验的事实**，不是口头承诺。
**因此刻意不提供「空白起步」模板**：它必然被保存期校验拒掉，那正是本节开头那个现象。
要自定义就从现有模板上删步骤、改参数。

**另一处配套**：参数元信息加 `example?`——**它不是默认值**，只在输入框为空时显示、不参与提交，
用途是让「用户自己新加的那一步」也知道该填什么形式。**报错也随之可定位**：
`collectParamProblems` 返回带 `stepId` 的条目，保存时自动跳到出问题的那一步。

### §2.4 自动铺坐标

`FlowDefInput.steps[].position` 是**可选**的。缺失时按 `orderIndex` 顺序自动铺开——
用户只拖了节点、没来得及摆位置也能落库，**不因缺 `position` 报错**。

### §2.5 画布视口（缩放 / 平移）

`FlowCanvas` 的 `viewBox` 是**受控**的，**不在内容尺寸手里**。2026-09-17 之前用的是
「`contentBounds(...)` + `preserveAspectRatio="xMidYMid meet"`」，语义是**永远把内容整体塞进容器**：
内容一宽就自动缩（节点卡片的 10px 字缩到 6px 就读不了），而**用户没有任何手段拉回来**——
**缩放权在内容，不在用户**。这就是老板看到的那一幕：「构建的主图应该自带放大缩小的功能,不然看不清」。

- 视口状态 = `{ scale, cx, cy }`：`scale` = **1 用户单位占几个屏幕像素**（1 = 100%），
  `(cx, cy)` = 视口中心在用户坐标里的位置。
- **★ 硬约束**：`viewBox` 的宽高恒为「**容器像素 / scale**」⇒ **宽高比与容器严格相等**，
  `meet` 永不产生 letterbox。这不是洁癖：拖拽的坐标换算走 `getScreenCTM()`
  （`FlowCanvas.toSvg`），一旦出现 letterbox，「鼠标位置 → 用户坐标」会**整体偏移、拖拽发飘**。
- **默认 100%，不是默认适配**。看全貌是「适配窗口」按钮这个**显式动作**（对齐 Figma / Dify / n8n
  的通用取舍：自适应是用户要的一个动作，不该是默认行为）；适配**不放大超过 100%**
  （两三个步骤的小图被撑成巨图比看不清更怪）。
- 滚轮缩放**以光标为锚**——锚点下的那个用户坐标，缩放前后必须贴在同一个像素上
  （少了这条，滚轮会「越缩越偏」、想放大的地方跑到屏幕外）；按钮缩放以视口中心为锚；
  「百分比」按钮 = 回到 100%。
- 空白处拖动 = 平移（左键/中键）；位移**除以 scale**（放大 4 倍时鼠标移 1px 只走 0.25 用户单位，
  否则一拖就飞）。
- 滚轮**必须**用原生 `addEventListener({ passive: false })`：React 把 `wheel` 注册成 passive，
  `preventDefault()` 会失效 ⇒ 画布内滚轮会**同时缩放并滚动整页**。`deltaMode` 要折算成像素
  （火狐与部分鼠标只报「行」，照像素算一档只变 0.4% ＝ 用户以为滚轮坏了）。
- 视口**只在「换流」或「内容首次到位」时自动定位一次**，用户摸过之后一律不再自动改
  （否则一次 re-render 就把用户刚平移到的视角弹回中心）。
- 几何全在 `web/src/features/study-flow/flow-viewport.ts`（纯函数，**38 例回归锁**）；
  事件与状态在 `use-flow-viewport.ts`（hook）；控件在 `ZoomBar.tsx`
  （右下角**常驻**——滚轮若没有可见控件，用户会以为没这个功能）。

**本版未做**：触屏双指缩放；知识图页的邻域图（`NeighborhoodGraph`）仍无缩放/平移。

---

## §3 知识数据图·节点与邻域

### §3.1 节点只存引用 + 抗删快照

```sql
knowledge_node (id PK, kind, ref_id, ref_text, source_run_id, source_step_id, created_at,
                UNIQUE(kind, ref_id))
```

- `kind ∈ { term, note, turn, concept }`；`ref_id` 指向**源表主键**（`term_library.id` /
  `quiz_notes.id` / `messages.id`），`concept` 类为 `NULL`。
- **正文不复制**，仍留在源表；但 `ref_text` 存一份**抗删快照**——源行被删后图仍自洽可读。
  这与 `evolution_event.term_text` / `quiz_notes.quiz_title` / `pk_matches.snapshot_json` /
  `user_memory` 是同一手法，**本域是第五次复用**。
- **`UNIQUE(kind, ref_id)` 是幂等的落点**：同一个词条在两条流里跑出来**仍是同一个点**
  （图能连起来的前提）。SQLite 的 `UNIQUE` 允许多个 `NULL`，故 `concept` 节点可重复登记。

### §3.2 `ensureNode` 的语义

同 `(kind, ref_id)` 重复调用 ⇒ **返回既有节点**（不新增、不报错）。
故「跑了两遍同样的流」不会在图里造出两个同样的点。

### §3.3 `neighborhood` 只给局部子图

`neighborhood(nodeId, depth = 2)` 返回 `{ center, nodes, edges, truncated }`。

- **刻意不返回全图**：词条级全图到万级节点就会拖死前端渲染，而用户真正要看的是
  「当前这个词条跟谁有关系」。
- 上限：`NEIGHBORHOOD_MAX_DEPTH = 3`、`NEIGHBORHOOD_MAX_NODES = 60`。
- **超上限时 `truncated = true`**（ADR-5 不静默：截断了必须告诉用户，**不把局部图冒充全图**——
  同 `doc-rag` 的「不声称覆盖全文」口径）。
- 节点不存在 ⇒ 返回 `null`（路由据此回 404，见 §9）。

---

## §4 知识数据图·边与出处分层

### §4.1 边类型与出处

```sql
knowledge_edge (id PK, from_node_id, to_node_id, kind, origin, weight, evidence, created_at,
                UNIQUE(from_node_id, to_node_id, kind))
```

`kind ∈ { prereq, relates, derived_from, contains }`（前置 / 相关 / 由…引发 / 从属）。

### §4.2 ★★ 三值 `origin` 刻意不平权

| `origin` | 含义 | 处置 |
|----------|------|------|
| `user` | 用户手工确认 | **最高可信**；路由强制只能由「手工加边」产生（见 §8） |
| `ai` | 模型抽取 | **可能幻觉**——前端必须加视觉标记，用户可一键转正或删除 |
| `derived` | 结构推导（同域 / 同会话共现） | **可被规则重算、可被批量撤销** |

**若把三者混作一谈，模型幻觉出的关系就再也纠不回来。** 故：
- `purgeDerivedEdges()` **只删 `derived`**，`user` 与 `ai` 边一条不动；
- 结构推导（`deriveDomainEdges`）是 `derived` 的**唯一产地**，`evidence` 存**规则名**（如 `同域：算法`），
  便于将来换更聪明的推导时**一眼看出旧边是哪条规则留下的**。

### §4.3 边的其他约束

- **自环被静默丢弃**（`addEdge` 返 `null`，不抛错）；路由据此回 400（§9）。
- **两端节点必须都已存在**，否则路由 404——不留半截边。
- `weight` 越界**钳到 0~1**（排序用，不参与业务判定）。
- `UNIQUE(from,to,kind)` ⇒ 同一条边重复抽取走 `INSERT OR IGNORE`。

---

## §5 步骤执行器（注册表的行为半边）

### §5.1 与 shared 的分工（不可混）

| 位置 | 装什么 | 为什么在这 |
|------|--------|-----------|
| `shared/src/study-flow.ts` | **元信息**（label / params / produces / awaitsUser） | 前端要拿它渲染节点面板与参数表单 ⇒ **必须前后端同源** |
| `server/src/learning/flow-registry.ts` | **行为**（参数校验 + executor） | 只有服务端需要 |

两者由 `kind` 对齐。**加一种新交互 = shared 加一条元信息 + server 注册一个执行器**（两处，不多不少）。

### §5.2 参数校验（`validateStepParams`）

| 情形 | 处置 |
|------|------|
| 未知 `kind` | 拒绝，**错误里列出可用类型**（用户拼错时能自查） |
| **必填缺失** | **拒绝**，不静默落默认值（用户以为自己配了、实际没配，比报错更难查） |
| 选填缺失 | 落该参数声明的 `default` |
| 数值越界 | **钳到区间**，不报错（同 `normalizeTerms` 的 importance 手法：越界是笔误不是攻击） |
| `select` 非法值 | 拒绝 |
| 布尔参数 | 接受 `"true"` / `"false"` 字符串（前端表单常见形态） |

### §5.3 提示词构造（`buildStepPrompt`，纯函数）

按 `kind` 把参数翻译成**一句脚本化提问**，返回 `{ text, awaitUser, pauseReason }`。
纯函数 ⇒ 可单测（本批 19 例中的一半）。
**六种类型都必须能构造出非空提问**（注册表与翻译表**不漏项**：新增一种步骤忘写翻译会当场红，
而不是运行时给模型发一句空话）。

| kind | `awaitUser` | `pauseReason` |
|------|-------------|---------------|
| `explain` | false | — |
| `quiz` | **true** | 「题目已生成，请先作答；答完点『继续』进入下一步」 |
| `grade` / `review` / `digest` / `summary` | false | — |

### §5.4 `awaitsUser` 与「停等」= LangGraph 的 interrupt

注册表声明 `awaitsUser: true` 的步骤（当前只有 `quiz`），跑完会后把运行置为 **`paused`**
并写 `pause_reason`。**这不是错误态——它是「学习流」的正常中间态**：用户答完题再点「继续」，原地续跑。
本仓 `chat/choice.ts` 为 `ask_choices` 手写过一套同款的 interrupt + checkpointer；
**学习流不引入新的挂起式等待**——状态本来就在库里（§6.1）。

### §5.5 六种默认执行器与「委派既有编排」

`flow-executors.ts` 的 `registerDefaultExecutors()` 给六种 kind **注册同一个 `chatStep`**，
差异全部由 `buildStepPrompt` 承担。`chatStep` 做的事只有一件：
**把脚本化提问交给既有 `chat/flow.ts` 的 `handleMessage` 去跑**。

⇒ 工具循环、联网检索、文档 RAG、词条抽取、消息落库、思考链回放**一行都不用重写**；
引擎**零新增 LLM 调用路径**，也就不存在「学习流有自己的提示词、与主流程逐渐漂移」这个老毛病；
产出**天然是真实学习数据**（真的词条进 `term_library`、真的消息进 `messages`），不是引擎自己编的假记录。

代价（如实记录）：步骤产出是**一轮对话**而非结构化对象，`flow_run_step.output` 只存提问原文与那条回答的 id。
「步骤产出一张结构化卡片」是下一批的事（§12）。

**没有会话时如实抛错、不静默跳过**——学习流的全部价值就是产出学习数据，没有会话就没有地方产出，
静默跳过会让用户以为这一步跑了。

---

## §6 运行器语义（`study-flow-run.ts`）

### §6.1 ★★ 步进式，不是后台 while 循环

每次 `advanceRun` **只推进一步**，所需状态全在 `flow_run` 行里
（`current_step_id` / `cursor` / `step_count` / `status`），**进程内存不持有任何运行状态**。四个好处：

1. **进程重启不丢**——没有内存 Promise 会随进程消失，故**不需要 LangGraph 那套 checkpointer**。
2. **天然支持「停在任一步」**——前端每点一次「继续」走一步，用户看得见每一步的结果。
3. **无后台任务**——不需要定时器 / job 队列，也不受「关掉客户端即被终止」的进程托管限制。
   （对照本仓既有的常驻进程痛点：本域**不新增任何常驻依赖**。）
4. **可测**——注入 fake executor 后整个推进是确定性的同步可断言序列。

代价：**一步 = 一次 HTTP 请求里跑完一整轮 LLM 对话**，耗时可到数十秒 ⇒ **前端必须放宽超时**。
改 SSE 流式是后续的事（§12）。

### §6.2 状态机

`status ∈ { running, paused, done, failed, cancelled }`。

- **`running` 与 `paused` 都可推进**（paused 会自动翻回 running）。
  这条是**实跑才发现的红灯**：原实现只允许 `running`，导致第一步停在 `quiz` 之后**永远推不动**
  （用户答完也无路可走）。前端不需要先调一个单独的 resume 端点——多一个端点就多一处「前端忘了调」的坑，
  而状态语义并不因此更清楚。
- `done` / `failed` / `cancelled` 再推进 ⇒ **409**，错误里带上当前状态原文。
- `cancelRun` 只在 `running`/`paused` 生效；已结束的返回 `null`（路由 409，幂等不炸）。
  取向同 `chat/choice.ts` 的 `cancelChoicesBySession`——**事后可恢复**而非事前拦截。

### §6.3 ★★ `def_snapshot` 不可省

`createRun` 把定义的**当前版本快照**冻进 `flow_run.def_snapshot`；
**`getRun` 不读 `flow_def`**。理由（Dify `WorkflowRunHistory` 同款）：用户改完定义后，
**已经跑过的运行必须仍按当时的定义解释自己的轨迹**，否则历史回放张冠李戴。

⇒ 两个可观测后果，都有回归锁（`study-flow-run.test.ts`）：
- 创建运行后再改定义，运行仍按**当时的定义**走；
- **定义被删也照样能跑完**（运行只认自己的快照）。

### §6.4 下一步怎么选（`pickNextStep`）

1. 无 `current_step_id` ⇒ **入口** = 没有任何边指向它的步骤；多个（或成环导致没有）时取 `order_index` 最小者。
2. 有 `current_step_id` ⇒ 按 `cursor`（默认 `next`）找 `from_step_id + from_port` 匹配的边。
3. 找不到边 ⇒ **兜底线性推进**：取 `order_index` 大于当前者的第一个。

### §6.5 上限与失败（ADR-4 / ADR-5）

| 情形 | 处置 |
|------|------|
| `step_count >= FLOW_MAX_STEPS`（**30**） | 运行置 `failed`，错误**明说是防死循环保护**（不是静默截断）。口径对齐 LangGraph 的 `recursionLimit` 与本仓 `chat/flow.ts` 的 `MAX_TOOL_TURNS` |
| 步骤类型**没接执行器** | 运行置 `failed`，错误**点名是哪种类型 + 列出已接入的**（并指向 §7 待接清单）。**绝不静默跳过**——跳过会让用户以为跑了、知识数据却缺了 |
| 执行器抛错 | 该步 `flow_run_step` 置 `failed` 并**留错误原文**（截 500 字），运行置 `failed`，HTTP **502** |
| 定义快照损坏 | 运行置 `failed`，HTTP 500（不猜、不重建） |

### §6.6 产物落图（`emitTermNodes`）

`produces` 含 `term` 的步骤跑完后，把**本步新增的词条**登记成 `knowledge_node` 并补同域 `derived` 边。

- 定位办法：`term_library.source_session_id = 本会话` **且 `created_at >= 本步开始时刻`**。
  时间窗用的是 SQLite 自己的 `datetime('now')`（UTC、秒级），**与写入端同源**，故可直接字符串比较。
- **只做 `term`**：词条表有 `source_session_id`，可按「会话 + 时间窗」精确定位本步新增的行；
  `note` / `turn` 的定位**缺可靠锚点**（`quiz_notes` 无 session 列）⇒ **不猜**，列入 §7。
- `upstream`（前面各步的产出）由 `collectUpstream` 收集，是**步骤间传数据的唯一通道**。

---

## §7 待接执行器清单（`flow-registry.ts` 如实报错的依据）

| 项 | 状态 | 说明 |
|----|------|------|
| 六种步骤执行器 | **已接** | `registerDefaultExecutors()` 在服务启动块调用（接请求前） |
| `note` / `turn` 类知识节点的自动登记 | **未接** | 缺可靠的「本步新增」锚点（`quiz_notes` 无 session 列），**不猜** |
| `concept` 节点的自动产出 | **未接** | `summary` 步声明 `produces: ['concept']`，但目前只靠调用方手工 `POST /graph/nodes` 登记 |
| 步骤产出结构化卡片 | **未接** | 现为「一轮对话」，`output` 只存提问原文 + 回答 id |
| 单步执行改 SSE 流式 | **未接** | 现为一次 HTTP 请求跑完，前端需放宽超时 |

⇒ **「没接」一律以失败 + 点名的方式暴露**，不做静默降级。这也是 `/steps` 端点带 `wired` 标记的原因：
前端据此**禁用还没接执行器的步骤类型**，把错误挡在配置期而不是运行期。

---

## §8 安全与跨源闸门

- **写接口一律吃跨源闸门**（`originCheck`）：无合法 Origin 的 POST ⇒ **403**（与其余写接口同一道闸门）。
- ★ **手工加边的 `origin` 由路由强制为 `user`**，**不接受客户端自称**。
  若允许客户端自报，用户手画的一条边就能伪装成 `ai` 抽取的边，`origin` 的可信分层当场作废（§4.2）。
- 端点只做「取参 → 调域函数 → 定状态码」，**不含业务判定**（ADR-3 薄层原则）；
  域层已把「不存在 / 状态不对 / 参数非法」分清楚，路由**原样透传、不反推**。

---

## §9 路由清单（HTTP 状态码口径）

挂点：`app.use('/api/study-flow', studyFlowRouter)`。

| 方法 | 路径 | 说明 | 关键状态码 |
|------|------|------|-----------|
| GET | `/steps` | 六种步骤 + `maxSteps` + **`wired` 标记** | 200 |
| GET | `/defs` | 定义列表 | 200 |
| POST | `/defs` | 新建 | **201** / 校验不过 400 |
| GET | `/defs/:id` | 定义详情 | 200 / **404** |
| PUT | `/defs/:id` | 更新（版本递增） | 200 / 校验不过 **400** / 不存在 **404** |
| DELETE | `/defs/:id` | 删除（连步骤与边） | 200 / **404** |
| POST | `/defs/:id/clone` | 克隆 | **201** / **404** |
| GET | `/runs` | 运行列表（`limit` 缺省 50） | 200 |
| POST | `/runs` | 建立运行（自动建会话、冻快照） | **201** / 缺 defId **400** / 定义不存在 **404** |
| GET | `/runs/:id` | 运行详情（含逐步轨迹 + `producedNodes`） | 200 / **404** |
| POST | `/runs/:id/advance` | **推进一步**（rest 超时要放宽） | 200 / **404** / **409**（状态不可推进 / 未接执行器 / 超步数上限） / **502**（步骤执行失败） |
| POST | `/runs/:id/cancel` | 终止（仅 running/paused） | 200 / **409** |
| GET | `/graph/stats` | 节点/边总数与分组 | 200 |
| GET | `/graph/nodes` | 节点列表（`kind`、`limit` 缺省 200） | 200 |
| POST | `/graph/nodes` | 手工登记节点 | **201** / 缺 kind·refText **400** |
| GET | `/graph/neighborhood/:nodeId` | 邻域子图（`depth` 缺省 2） | 200 / **404** |
| POST | `/graph/edges` | 手工加边（**强制 `origin='user'`**） | **201** / 缺参 **400** / **两端不存在 404** / 自环 **400** |
| DELETE | `/graph/edges/:id` | 删边 | 200 / **404** |
| POST | `/graph/purge-derived` | 只删 `derived` | 200（回删了几条） |
| GET | `/graph/meta` | 可选 kind / origin 清单（前端下拉用） | 200 |

★ **404 与 400 分得开**（「没有这条流」与「这条流写错了」是两件事）；`DELETE` 后再删回 404，
**幂等语义如实反映**（不假装幂等成功）。

---

## §10 影响面

| 落点 | 性质 |
|------|------|
| `packages/shared/src/study-flow.ts`（新） | 前后端单一事实源（类型 + `FLOW_STEP_METAS` + `FLOW_MAX_STEPS`） |
| `packages/shared/src/study-flow-params.ts`（新，2026-09-17） | **参数校验**（`validateStepParams`）。前端表单要「提交前先拦」、服务端执行期要校验 ⇒ 必须同一份，否则口径漂移 |
| `packages/shared/src/index.ts` | 加两行 `export *` |
| `packages/server/src/learning/{flow-registry,study-flow,study-flow-run,knowledge-graph,flow-executors}.ts`（新，5 个） | 域层，单文件均未触 400 行红线；`flow-registry.ts` 自 2026-09-17 起**只 re-export 校验**，实现已上提 shared |
| `packages/server/src/routes/study-flow.ts`（新） | 薄路由 |
| `packages/server/src/index.ts` | 挂路由 + 启动块调 `registerDefaultExecutors()`（**在接请求前**） |
| `packages/server/src/storage/migrations-list-v10.ts` | 追加 v18（七张表，**纯加法**，不动既有表） |
| `packages/server/src/storage/migrations-list.ts` | 降为聚合出口（`[...V1_9, ...V10]`）；**清单按版本区间再拆**，零行为改动 |
| `shared/src/sse-events.ts` / 消息流 | **零改动**——本域不新增 SSE 事件类型 |
| `packages/web/src/features/study-flow/`（新，**2026-09-17 落 15 个文件**：8 个组件 + 6 个纯逻辑 `.ts` + 2 个 CSS） | 编排画布 / 步骤面板 / 运行面板 / 定义列表 / **模板选择（`TemplatePicker`）** / 知识图页 / 邻域图 / 节点详情 + 布局·表单·状态映射·**模板库（`flow-templates`）** 纯逻辑 |
| `packages/web/src/lib/api-study-flow.ts`（新）、`api-request.ts`（抽出 + 加超时）、`api.ts`（挂 `studyFlow` 分组） | 前端 API 层；`api-request.ts` 的抽出是为断掉 `api.ts ↔ api-study-flow.ts` 的环 |
| `packages/web/src/app/App.tsx`、`components/icons.tsx`、`features/terms/TermsPage.tsx` | 导航接线（新增「学习流」「知识图」两项 + 两个自绘图标）、词条库接 `initialKeyword` |

---

## §11 验收状态（2026-09-17 更新）

| 项 | 证据 | 状态 |
|----|------|------|
| 步骤参数校验与提示词构造 | `learning/study-flow.test.ts` **19** 例 | ✅ passed |
| 步进推进 + **定义快照隔离** | `learning/study-flow-run.test.ts` **11** 例 | ✅ passed |
| 知识图节点/边/邻域/结构推导 | `learning/knowledge-graph.test.ts` **13** 例 | ✅ passed |
| 路由状态码 + `origin` 强制 + 跨源闸门 | `routes/study-flow.test.ts` **15** 例 | ✅ passed |
| **知识图渲染纯逻辑**（分层摆位 / 边端点几何 / `origin` 分档） | `web/.../graph-visual.test.ts` **20** 例 | ✅ passed |
| **参数表单派生**（初值 / 即时钳制 / 摘要 / 提交前体检） | `web/.../flow-form.test.ts` **24** 例 | ✅ passed |
| **运行状态映射**（与服务端 advancing 判定逐条对齐） | `web/.../run-status.test.ts` **19** 例 | ✅ passed |
| **画布几何**（吸附 / 三端口不重合 / 边路径 / 视口） | `web/.../flow-layout.test.ts` **16** 例 | ✅ passed |
| 迁移链回放（v1~v18 连续、纯加法） | `storage/db.test.ts` **14/14** | ✅ passed |
| 全仓回归 | vitest **88 文件 / 1151 passed + 1 skipped**、tsc×3、eslint、gates **EXIT=0** | ✅ 全绿（2026-09-17 实测） |
| **真实模型跑一条完整学习流** | — | ❌ **未实测**（执行器在测试里被 fake 替身顶掉，`chatStep` 的真实 LLM 端到端路径未跑） |
| **前端页面**（画布 / 步骤面板 / 运行面板 / 邻域图 / 节点详情） | 文件与单测见 §10/§11 | ✅ **已落地**（2026-09-17） |
| **「图在屏幕上的样子」** | — | ⚠️ **可打开、需目检**——渲染层无自动化测（本仓无 jsdom），观感与拖拽手感的判定权在老板 |

---

## §12 本版未做（如实登记，不是欠账）

> **2026-09-17 更**：原第 1 条「前端全部」已落地（§10/§11），故下表换成**前端仍未做的部分**。

| 未做项 | 理由 |
|--------|------|
| **画布上「拖拽拉线」连边** | 现为**三出口下拉选目标**（面板里）。下拉更可靠、失败面小；拖拽拉线手感更好但交互细节多（悬停高亮合法目标、防连自环、防重复边），属下一批 |
| **全图视图** | 万级节点会拖死渲染，且用户真正要看的是局部邻域（§3.3） |
| **单步执行改 SSE 流式** | 先让状态机跑对；SSE 会让「一步 = 一请求」的简单模型复杂化 |
| **步骤产出结构化卡片** | 现为「一轮对话」，够用且零新调用路径 |
| **`note`/`turn`/`concept` 节点的自动登记** | 缺可靠锚点，**不猜**（§6.6、§7） |
| **节点详情里看正文** | 知识图只存**引用 + 抗删快照**（§3.1），正文在词条库/笔记页各自的表里。现给的是**跳转出口**（`onOpenSource` → 词条库带词），不复制一份会过期的正文 |
| **并行步骤 / 环** | 本版运行器是确定性线性推进 + 条件端口；并行分支会引入汇合语义，超出当前需求 |
| **引入 LangGraph.js** | 见 §6.1——本仓需要的只是「步进状态机 + 库里的状态」，`chat/choice.ts` 已手写过同款 interrupt。**等真出现「运行中动态插环/条件跳转」的需求再评估** |

---

## §13 未验账（诚实记账）

1. **真实 LLM 端到端未跑**：`chatStep` 走 `handleMessage`，测试里被 fake 顶掉。真实的「一步 = 数十秒、
   产出真的进 `term_library`」路径未被实测。⇒ 下一批跑一次真机学习流。
2. **时间窗定位法的边界**：`emitTermNodes` 靠 `created_at >= 本步开始时刻` 界定「本步新增」。
   **若两步在同一秒内完成**（或写入端与读取端时钟不一致），可能把下一步的词条算进本步。
   SQLite `datetime('now')` 是秒级 ⇒ 这是个**已知的理论边界**，未构造用例验证。
3. **`deriveDomainEdges` 是 O(n²)**：同域词条多时会有性能问题，故**由调用方限定同域节点数**（本版调用点
   只传本步新增的那几个节点）。**同域上千节点时的表现未测**。
4. **`FLOW_MAX_STEPS = 30` 是估值**：对齐 LangGraph `recursionLimit` 与本仓 `MAX_TOOL_TURNS` 取的，
   未按真实流的长度分布校准。
5. ~~**前端超时未定**~~ ⇒ **2026-09-17 已处置，且处置与原判断不同，值得记一笔**：
   原判断是「一步可跑数十秒，HTTP 客户端默认超时（常见 30s/60s）不够，要放宽」。实读 `api-request.ts`
   后发现本仓 `request` 用的是原生 `fetch`——**它根本没有默认超时**，所以真正的缺口不是「放宽」而是
   「**无限静默等待**」（用户会看着一个永不到来的响应）。故落地方案是给长任务（`advanceRun`）
   **显式** `LONG_TASK_TIMEOUT_MS = 180_000` + 可中断 `signal`，并新增 `NO_RESPONSE = 0` 状态码把
   「等太久/被取消」与真实 HTTP 错误（4xx/5xx）分开。**超时 ≠ 失败**：文案如实写「这一步在服务端
   可能仍在执行，可稍后在运行轨迹里查看结果」，且前端会回读一次运行状态（不猜）。
   ⚠️ **仍未验**：180s 这个数没有实测依据（按「比任何合理单步都长、又比用户以为页面死了短」估的）；
   **也没有真机跑过一次会超 180s 的步骤**。真实模型端到端跑过一次之后，这个值应据此校准。

---

## 附：本文件与代码的章节号对应（防改稿时错位）

代码注释里引用了本文件的章节号，**改本文件时必须同步核对**。
★ **2026-09-16 已做一次全仓核对并改准**：初稿曾有 5 处引用指向错误章节（3 处 `§2 范围红线` 实为 §1.3、2 处 `§8 未验边界` 实为 §13），已逐条改到下表的口径——
**宁可改代码注释，也不留一张需要对照才看得懂的映射表**（对照表本身就是下一次错位的温床）。

| 代码位置 | 引用 | 本文件对应 |
|----------|------|-----------|
| `shared/src/study-flow.ts` | §1 三层结构 / §1.3 范围红线 / §4 三值不平权 / §5 interrupt | §1 / §1.3 / §4.2 / §5.4 |
| `server/src/learning/study-flow.ts` | §1.3 范围红线 / §2 定义层 | §1.3 / §2 |
| `server/src/learning/knowledge-graph.ts` | §3 知识数据图 / §13 未验账 | §3 / §13 |
| `server/src/learning/flow-executors.ts` | §5 执行器 / §7 | §5 / §7 |
| `server/src/learning/study-flow-run.ts` | §5~§6 / §6 上限 / §7 待接清单 / §13 未验账 | §5~§6 / §6.5 / §7 / §13 |
| `server/src/learning/flow-registry.ts` | §7 待接清单 | §7 |
| `server/src/routes/study-flow.ts` | §9 路由 | §9 |
| `server/src/storage/migrations-list-v10.ts`（v18） | §1.3 范围红线 | §1.3 |
| **以下为 2026-09-17 前端批新增**（逐条按 `grep -o "§[0-9.]*"` 实测，不是凭印象填的） | | |
| `web/src/features/study-flow/graph-visual.ts` | §3 / §3.3 / §4 / §4.2 | §3 / §3.3 / §4 / §4.2 |
| `web/src/features/study-flow/graph-visual.test.ts` | §4.2 | §4.2 |
| `web/src/features/study-flow/flow-layout.ts` | §2.4 自动铺坐标 | §2.4 |
| `web/src/features/study-flow/flow-form.ts` | §5.2 参数校验 | §5.2 |
| `web/src/features/study-flow/flow-actions.ts` | §2.3 CRUD 语义 | §2.3 |
| `web/src/features/study-flow/run-status.ts` | §6.2 状态机 / §6.3 | §6.2 / §6.3 |
| `web/src/features/study-flow/run-status.test.ts` | §6.3 | §6.3 |
| `web/src/features/study-flow/DefList.tsx` | §2.3 | §2.3 |
| `web/src/features/study-flow/FlowCanvas.tsx` | §2 / §7 | §2 / §7 |
| `web/src/features/study-flow/StepPanel.tsx` | §2 / §5.2 / §7 | §2 / §5.2 / §7 |
| `web/src/features/study-flow/RunPanel.tsx` | §6 / §6.3 | §6 / §6.3 |
| `web/src/features/study-flow/FlowPage.tsx` | §2 / §2.3 / §6 | §2 / §2.3 / §6 |
| `web/src/features/study-flow/NeighborhoodGraph.tsx` | §3.3 局部子图 | §3.3 |
| `web/src/features/study-flow/NodeDetailCard.tsx` | §3 / §4 | §3 / §4 |
| `web/src/features/study-flow/KnowledgeGraphPage.tsx` | §3 / §4 | §3 / §4 |
| `web/src/lib/api-request.ts` | §13 未验账（超时） | §13 |
| `web/src/lib/api-study-flow.ts` | §3.3 / §4.2 / §7 / §8 / §9 | §3.3 / §4.2 / §7 / §8 / §9 |
| **以下为 2026-09-17 画布缩放批新增** | | |
| `web/src/features/study-flow/flow-viewport.ts` | §2.5 画布视口 | §2.5 |
| `web/src/features/study-flow/flow-viewport.test.ts` | §2.5 | §2.5 |
| `web/src/features/study-flow/use-flow-viewport.ts` | §2.5（滚轮非 passive / 自动定位一次） | §2.5 |
| `web/src/features/study-flow/ZoomBar.tsx` | §2.5（控件必须常驻） | §2.5 |
| `tools/probes/flow-canvas-zoom-cdp.mjs` | §2.5 真机核验 | §2.5 |
