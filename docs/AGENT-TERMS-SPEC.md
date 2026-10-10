# 外部 agent 词条接口

外部 coding agent 使用自己的搜索与整理能力，直接批量存入当前授权账号的词库；服务端不再调用模型抽词。设置页创建专用密钥即授权此能力，不沿用登录 cookie，不把账号或平台模型密钥交给 agent。

## 授权

- 设置页 `/api/settings/agent-keys` 提供 GET 列表、POST 创建（name 1–40 字、days 1–90，默认 30）、DELETE /:id 撤销。最多 5 个有效密钥；返回名称、掩码前缀、期限和最近使用时间，明文仅创建时返回一次，库内只存 SHA-256。
- 未显式授权的密钥仅允许读取本人词库和新增词条，不能修改/删除已有词条、访问聊天或设置、创建新密钥。创建时可选 `questionSeeds:true` 额外授权出题预产物，旧密钥不扩权，见 [QUESTION-SEEDS-SPEC](QUESTION-SEEDS-SPEC.md)。归属只取密钥记录，忽略 cookie；请求不接受 ownerId、owner_id、sourceSessionId 等归属字段。
- `/api/open/v1` 独立鉴权，只接受 `Authorization: Bearer sb_terms_...`，不要求 CLI 提供 Origin。现有 cookie 接口的 Origin 与登录检查保持。云端密钥必须属于现存用户；本地无主密钥只在本地形态可用。每个 owner 每分钟最多 60 次受保护请求，所有密钥共用计数。

## 接口

- GET `/api/open/v1/openapi.json`：公开机器接口说明；GET `/context`：授权账号的应试开关、范围摘要、允许来源域名和已有领域；GET `/terms?limit=100&offset=0`：本人全部词条分页，含当前应试范围外词条用于排重，最多 200 条/页。
- POST `/terms/import`：`{batchId, review?:boolean, terms:[{term,definition,domain?,importance?,aliases?,sourceUrls?,sourceNote?,source_host?,freq?}]}`。batchId 1–100 个 ASCII 字符（字母数字、点、冒号、下划线、连字符）；每批 1–100 条，JSON 最多 512 KiB；词名 1–100 字、释义 1–4000 字、领域 1–30 字（默认 general，统一小写），别名最多 8 个/每个 100 字，importance 0–1；最多 3 个 http(s) 来源 URL，每个 2000 字；来源注记最多 300 字。完整批次先严格校验，错误 400 带条目下标，零写入；不静默丢条或截短。
- 同账号、同 batchId、同规范化内容回放原回执，`replayed:true`；同 batchId 不同内容 409。词名同领域（忽略大小写）或已有别名命中时返回 skipped，保留释义、来源、复习状态及 usage；同一批内部也排重。新增条目复用现有存词与全文索引、领域登记；默认加入复习（review=true），false 时继承既有领域设置。导入不重置已有词条的 FSRS/复习阶段，也不把重复项重复记为学习事件。
- 回执包含 `added/skipped/results[{index,id,term,status,visibleInCurrentScope,warnings,sourceNote}]`，逐项可追踪。授权、撤销、过期失败 401；跨账号密钥撤销 404；限额 429，带 Retry-After；未知开放接口 404。错误不返回密钥、请求原文或服务器内部堆栈。

## 来源与应试范围

外部 agent 提供的 URL 标记 origin=agent，含义是「授权导入者提供的来源」，不冒充服务端已抓取/逐字核实的证据，不进行隐式联网验证。沿用现有白名单过滤：无来源或来源不在当前应试范围的词条仍存入词库，回执明确 visibleInCurrentScope=false 并提示原因。agent 应先读 context，在范围内检索；接口不替用户修改白名单。

桌面词条评审台导出的 term/definition/domain/source_host/freq 可直接用；source_host 只是原有来源注记，没有完整 URL 时不伪造成网址。附零依赖 Node 导入脚本，兼容评审台 JSON 与手选 t/d/g 清单，密钥从环境变量读取，批次按内容生成稳定 ID，支持 dry-run，网络重试保持批次 ID。

## 验证

真实 HTTP 验证：无 Origin 的授权写入；无 key/过期/撤销拒绝；key 不能调用普通业务与管理接口；跨账号隔离；坏批次零写入；同批回放与冲突；重复/别名不覆盖旧内容和复习状态；新增词可全文搜索与进入复习；来源/当前范围回执准确；设置页创建、复制说明与撤销。部署前在隔离库走桌面样例，生产用可清理的专用验证账号验证，原桌面候选集不自动整批导入用户账号。
