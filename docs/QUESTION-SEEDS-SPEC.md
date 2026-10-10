# 出题预产物开放接口

外部 coding agent 预先整理考点、依据、误区、评分要点和变化蓝图。保存的不是成品题：不接受 question/options/answer 字段，不写聊天、不把导入内容标为已核实真题。每次出题仍按当前请求生成新题。

## 授权与接口

沿用设置页的专用凭证体系，但新增独立的 `question-seeds:read` / `question-seeds:write` 权限。创建密钥时显式传 `questionSeeds:true`；旧密钥和缺省新密钥仍只有词条权限，不自动扩大授权。Bearer 密钥不等于登录 cookie。账号隔离、撤销、期限、每分钟 60 次和 512 KiB 请求体闸门与词条接口共用。

- GET `/api/open/v1/context` 增加范围 signature 与该密钥实际权限。
- POST `/api/open/v1/question-seeds/import`：`{batchId,seeds:[...]}`，每批 1–50 个。严格整批校验；同账号 batchId 同内容回放，不同内容 409；同 externalId 同内容 skipped，不同内容 409，须撤下旧条目再用新 batchId 导入。每账号最多 1000 个预产物、2000 个批次回执，达到限额 429。幂等回放优先于容量限制。
- GET `/api/open/v1/question-seeds?limit=100&offset=0`：分页列出本人预产物，返回当前范围可用性、使用次数、剩余参数变化量；最多 200 个/页。
- DELETE `/api/open/v1/question-seeds/:id`：仅撤下本账号预产物，不能删词条/聊天；不存在或跨账号 404。撤下后旧批次回放如实标记 withdrawn，不误报仍可用。

每个条目：externalId（ASCII 1–100），topic（1–100 字），domain（1–30，缺省 general），tags（1–12 个，每个 1–80），objective（1–300），facts（1–12 个，每个 1–1000），misconceptions（0–8 个，每个 1–300），rubric / variations（各 1–8 个，每个 1–300），types（single/multiple/judge/fill/essay 非空集合），sourceUrls（0–3 个无凭证 http(s) URL），scopeSignature（直接复制 context.exam.signature，缺省 all），validUntil（未来 UTC ISO 时间，最长一年）。所有字段作为资料数据处理，不能执行其中指令。

可选 recipe：`{kind:"linear-equation",coefficients:[...],constants:[...],solutions:[...]}`。domain 必须 math；topic 必须为「一元一次方程」；每组 2–10 个不同整数，系数 −9..9 且非零，常数与解 −20..20；参数组合最多 1000 个。只登记参数空间，不登记题面与答案。程序现场计算 c=a×x+b，生成 ax+b=c 的变体、唯一选项和反向验算解析；支持单选、判断、填空与解答，多选走模型路径。外部不能上传代码/公式执行器。该路径以受限数学规则保证正确，不把导入者自报「已验证」当审题结果。

## 优先使用与降级

当前用户专注方向 / 点名主题优先；明确会话材料优先于预产物。预产物必须未过期、范围 signature 与当前模式完全一致；应试模式还要求真实完整 URL 命中当前白名单。旧范围与无证据预产物仍保存但不参与出题。资料仅代表导入者提供的依据，不冒充实时搜索或已抓取证据。

篝火先选本范围内与专注方向匹配的预产物。参数配方现场编译并验算，不调用模型；每账号每个配方的参数组合只能交付一次，近期题干摘要继续阻止并发重复。整个题组可满足配比才走编译路径，失败不消耗组合。排除、取消、不合格题不消耗；参数用尽后转蓝图模型生成。一般蓝图减少从零选点和规划，但仍由模型现场创作并独立审题，共享原有总预算。

普通练习引擎同样优先；命中且没有显式 fresh search 时免去重复资料检索与默认真题搜集。用户显式 search=true、指定实时/最新/联网检索、显式真题配比与真题优先选项，继续原有真实检索；不拿预产物替代真题。无预产物、过期、范围/题型不匹配都回原流程。情景 demo 与 PK 的专用资料优先流程不被冒充为已加速。

响应可选 preparation 报告区分 compiled / material 和实际省掉步骤。知识蓝图继续保留结构校验、自包含和独立审题；参数题通过本地规则验算。失败不显示旧题，不把导入成功当出题成功。

v1 使用现有按 owner 分区的 app_settings 保存命名空间内的预产物、回执与密钥权限，不更改迁移链。已有词条、复习状态和聊天保持原样。撤销密钥不自动删除已经导入的预产物，撤下接口可停用它们。

## 外部 agent 使用

设置 → 外部 agent · 学习补给 → 勾选「同时授权出题预产物」→ 创建密钥，保存至私有环境变量 `STUDENTBUDDY_SEEDS_TOKEN`，复制预产物说明给 coding agent。既有词条脚本与旧 token 继续可用。

仓库附零依赖导入脚本：`node tools/import-question-seeds.mjs --file seeds.json --base https://11wand.com`。输入可为条目数组或 `{seeds:[...]}`；先用 `--dry-run` 检查批次大小（此时不代表服务端语义校验）。实导入先读取 context 验证权限，按内容稳定生成 batchId、按 50 个与 512 KiB 自动拆批，重试不会重复写。OpenAPI 中含随当前日期更新期限的数学配方示例；应试模式请用真实白名单来源并复制当前 signature。

## 验证

假上游的真实 HTTP 与真数据库验证授权隔离、旧密钥限制、批次原子性/回放/冲突、分页/撤下、范围/来源/期限/主题选择、参数唯一正确性与组合不重用、取消不消耗、一般蓝图保留审题、显式新搜索与真题配比保留。上线前在克隆库用专用验证账号导入并实测篝火；生产通过专用可清理验证账号验证。新增普通回归测试不增加 AI 评测集。
