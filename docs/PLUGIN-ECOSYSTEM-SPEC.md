# 插件生态 v1 — 2026-10-14

## 交付范围
插件管理页 + 声明式远程 MCP 插件底座 + GitHub 官方只读插件 + 主对话真实工具调用。
不是插件商店，不加载第三方 JavaScript，不接受自定义 stdio/本机命令；子 Agent 插件授权和 GitHub 写入后置。
安装版 GitHub 默认按 `DESKTOP-QUICK-CONNECT-SPEC.md` 点击打开浏览器 OAuth 授权并勾选仓库，只有这一固定且核验官方校验和的二进制可走 stdio；高级独立 Bearer Token 模式保留。已有 StudentBuddy 账号登录不等于插件仓库授权。

## 扩展契约
manifest schemaVersion=1，id/name/version/description/transport='streamable-http'/endpoint/tools。
JSON 可从管理页导入，不修改主程序即可增加公网 HTTPS MCP 插件；最多 8 个自定义插件、每插件 32 个显式工具名。
内置 github 身份、端点、只读工具白名单不可被导入覆盖。第三方插件一律 confirm_each_call；
readOnlyHint 不是授权事实源。常规连接测试只 initialize/tools/list，不执行 tools/call。浏览器授权使用 get_me 查询账号、search_repositories 填充勾选项，这两个辅助工具不向 AI 开放。
导入和保存均不默认启用。连接测试成功后用户显式启用；变更 Token/仓库范围会停用并清空验证状态。
停用、断开、删除会中止进行中的请求；在确认之后、真实外呼之前再次校验配置修订号。
未知、未启用、未发现、非 manifest 白名单的工具不可调用。暂停/重启不会自动重放外部调用。

## GitHub 权限
端点固定 https://api.githubcopilot.com/mcp/，强制 X-MCP-Readonly=true，限定工具集 repos/issues/pull_requests/actions。
本地白名单只允许已知只读工具与 method；每次均检查 owner/repo 在用户显式选择的仓库列表。
禁止跨仓搜索/全账号扫描、创建/评论/修改/合并/删除；不是仅靠提示词。
Token 建议为所选仓库的细粒度只读 PAT；Contents/Issues/Pull requests/Actions 按需 Read-only。
返回数据可以提交给当前配置的 AI，管理页明确告知；本机文件权限不随插件扩张。

## 执行与可见性
仅两个动态工具 plugin_tools / plugin_call，不向模型塞全部远端工具定义。
plugin_tools 按插件返回参数定义（标为不可信资料），plugin_call 复检归属、启用、白名单、范围及参数。
主对话现有 step 卡展示调用，插件页展示连接状态、工具清单与最近调用（归属隔离）。
自定义插件逐次确认卡显示服务域名、工具名和实际参数；即便点本会话允许，也仅消费为本次许可。
调用并发每用户最多 4；网络单次总限 30 秒、最多 1 MiB 报文、14k 字正文回灌。
连接列表分页最多 10 页/2000 条检查；仅保存显式白名单命中的工具，工具 schema 总量有界。
参数校验复用已有 JSON Schema 子集；未支持的 schema 条件由远端验证，GitHub 范围本地额外强检。

## 传输和数据
支持 Streamable HTTP JSON/SSE、初始化/协商、initialized、分页、session header、DELETE 清理。
不支持旧 HTTP+SSE、服务端采样/elicitation/MCP Apps；不自动执行服务端请求或资源外链。
普通文本块与报文内已返回的 resource.text 作为不可信文本读取；不使用 resource.uri 发起读取，不解码 blob，不加载图片/资源链接。兼容 GitHub get_file_contents 的“成功提示＋内嵌文件正文”返回形状，避免丢失正文。
新调用建立新 MCP 会话，不跨用户共享连接；遇过期/失败如实失败，下一次调用重新初始化，无自动重放。
HTTPS 公网端点，禁止用户信息/查询/hash/字面IP，DNS 地址检查后固定 IP 连接，TLS 验证域名；禁止重定向。
Token AES-GCM 加密保存，API 仅回 hasToken。Token 不放 manifest/前端存储/模型上下文/日志；输出及错误脱敏。
迁移 v62 plugin_connection/plugin_call_log、v63 auth_mode（条件加列可重放），owner_id 精确匹配（null 映射 ''，不豁免过滤）。
审计不保存参数/正文，只记插件、工具、状态、耗时与经过脱敏的简短错误。最多保留每用户最近 300 条。

## HTTP API
GET /api/plugins；POST /import {manifest}；PUT /:id {token?,repositories?,enabled?}；
POST /:id/test；POST /:id/disconnect；DELETE /:id（仅自定义）；GET /calls。
所有写入口受既有 Origin/auth 闸门保护，不对外暴露裸 tools/call HTTP 接口。
未配置 Token 且未完成浏览器连接的安装版显示未连接，不借用已有账号登录或 Codex 的 GitHub 授权。
桌面限定的快捷连接 API：GET /github/login；POST /github/connect、/github/cancel；POST /github/repositories {id,query}；POST /github/select {id,repositories}。id 绑定具体内存登录会话与 owner，旧 id 不能修改新连接。

## 验收
manifest 越权/坏配置，Token 密文与归属隔离，GitHub 仓库/method 双闸，
JSON/SSE/分页/session/报文上限/取消/重定向/DNS固定，连接测试不执行工具，
自定义确认拒绝零外呼，停用与配置变更中止，主对话工具循环真执行，管理页窄屏可用。

