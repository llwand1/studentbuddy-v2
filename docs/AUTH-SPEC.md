# 账号与会话契约（AUTH-SPEC）

> 版本：v0.1.0 | 状态：**M1 后端已落码（2026-09-17）· 前端登录 UI 与强制鉴权开关在途 · M2 数据隔离未开工** | 更新：2026-09-17
> 定位：studentbuddy 从**本地单用户**走向 **Web 多用户**的第一块地基——**邮箱 + 密码**账号体系与会话。
> 原则：**先立契约再改码**（AGENTS.md 已知约束）；契约先行、实现随后；前端登录 UI 与后端零耦合（只认 §2 的四个端点）。

---

## §0 为什么是邮箱（资质矩阵，本契约的成立前提）

微信 / 手机号登录**都需要企业资质**，个人开发者做不了——这不是偏好问题，是硬门槛：

| 登录方式 | 资质门槛 | 个人开发者可做 | 依据 |
|---|---|---|---|
| 微信网页登录（开放平台·网站应用） | 企业营业执照 + 已备案域名 + HTTPS；认证费 ¥300/年 | **否** | 开放平台明确「个人开发者无法创建网站应用」 |
| 手机号短信验证码 | 企业（短信签名需实名制报备，个人自用资质已停止受理） | **否** | 阿里云短信：个人认证账号无法以个人名义申请签名 |
| **邮箱 + 密码** | **无** | **是** | 无第三方依赖，自建即可 |

⇒ **MVP 走邮箱 + 密码**，零资质、零第三方依赖、边际成本为零。企业资质就绪后，微信 / 手机号作为
**M4 增强**接入，且**必须映射到同一 user**（用 openid / phone 关联，不新建账号）——否则同一人会有多个身份、
数据分裂。

### 范围（M1 做什么 / 不做什么）

- **做**：`users` / `auth_sessions` 两张表；邮箱密码注册、登录、登出、取当前用户四端点；
  httpOnly cookie 会话；登录失败限流；`requireAuth` 中间件（**开关 `SB_REQUIRE_AUTH` 默认关**）。
- **不做（本版）**：数据隔离（M2，给所有业务表加 `user_id`）、邮箱验证、密码找回、强制鉴权上线、微信/手机号登录。
- ⚠️ **为什么强制鉴权默认关**：只有账号、没有数据隔离时贸然强制鉴权＝**所有登录用户互相看到全部数据**
  （现有 `sessions`/`messages`/题库/笔记全是全局表，见 §6）。开关默认关，等 M2 把隔离做完，
  两者**同一批开**。

---

## §1 数据模型（迁移 v21）

### users

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `u-<uuid>`（与 PK 的 `pk_users.id` 同前缀，便于 M4 合并身份时对账） |
| `email` | TEXT NOT NULL **UNIQUE** | **写入前归一化**（trim + 小写，见 `normalizeEmail`）；UNIQUE 是库层兜底 |
| `password_hash` | TEXT NOT NULL | scrypt 派生串（见 §4.1）。**永不出接口** |
| `nickname` | TEXT NOT NULL DEFAULT '' | 不传则从邮箱派生（`nicknameFromEmail`） |
| `created_at` / `updated_at` | TEXT | `datetime('now')` |

### auth_sessions

| 列 | 类型 | 说明 |
|---|---|---|
| `token_hash` | TEXT PK | **SHA-256(token) 的十六进制**——★ 库里**不存明文 token**（同「密钥加密落库」取向：拖库拿不到可用的会话） |
| `user_id` | TEXT NOT NULL | 归属用户（**不设外键**：账号删除后会话行可被独立清理，且避免删号时的级联复杂度） |
| `created_at` | TEXT | `datetime('now')` |
| `expires_at` | INTEGER | ms 时间戳；`verify` 时比对，过期即失效 |
| `last_seen_at` | INTEGER | ms 时间戳；每次校验通过时刷新（**仅供观察，不参与过期判定**） |

索引：`idx_auth_sessions_user(user_id)`、`idx_auth_sessions_expires(expires_at)`（清理过期行用）。

---

## §2 API 契约

前缀 `/api/auth`。**会话走 httpOnly cookie**（名 `AUTH_COOKIE_NAME = 'sb_sid'`），
前端 fetch 同源自动携带、无需手动存 token。

### Web / 前端调用方式（用 `@sb/shared` 的密码规则校验，两端共用同一份——这是契约的一部分）。

| 端点 | 入参 | 成功 | 失败 |
|---|---|---|---|
| `POST /api/auth/register` | `{ email, password, nickname? }` | `200 { user }` + `Set-Cookie` | 400 `EMAIL_INVALID`\|`PASSWORD_WEAK`\|`NICKNAME_INVALID`；409 `EMAIL_TAKEN` |
| `POST /api/auth/login` | `{ email, password }` | `200 { user }` + `Set-Cookie` | 400 `EMAIL_INVALID`；401 `CREDENTIALS_INVALID`；429 `TOO_MANY_ATTEMPTS` |
| `POST /api/auth/logout` | — | `200 { ok: true }` + 清 cookie | — |
| `GET /api/auth/me` | —（读 cookie） | `200 { user }` | 401 `UNAUTHENTICATED` |

### 错误响应形状

`{ error: <人话>, code: <AuthError> }`（ADR-5：失败必须可读、可重试，不裸抛码）。

### 错误码 → HTTP 状态（映射只此一处，域层不碰 HTTP）

`EMAIL_INVALID`→400 / `EMAIL_TAKEN`→409 / `PASSWORD_WEAK`→400 / `NICKNAME_INVALID`→400 /
`CREDENTIALS_INVALID`→401 / `TOO_MANY_ATTEMPTS`→429 / `UNAUTHENTICATED`→401。

★ **`CREDENTIALS_INVALID` 把「邮箱不存在」与「密码错」合成一个码**：分开等于向攻击者确认
「这个邮箱已注册」（用户枚举漏洞）。

---

## §3 鉴权中间件与开关

- `requireAuth`：读 cookie（或 `Authorization: Bearer`，便于脚本/冒烟）→ 校验会话 → 把 `AuthUser`
  挂到请求对象。无有效会话 → `401 UNAUTHENTICATED`。
- `SB_REQUIRE_AUTH`：`'1'` 时对 `/api` 全量强制鉴权，**豁免** `/api/auth/*`、`/api/status`、`/api/health`。
  默认**不设**（＝不强制）。
- ★ **豁免清单是"必须公开"的白名单**：登录端点自身不能要求登录；`status`/`health` 是探活，也不该要登录。

---

## §4 安全约束（做不对就等于没做）

### §4.1 密码：scrypt（Node 内置，零新依赖）

- 格式 `scrypt$N$r$p$<saltB64>$<hashB64>`；`N=16384, r=8, p=1, keylen=64`，盐 16 字节随机。
- 校验用 `timingSafeEqual`（定长比较，防时序侧信道）。
- ❌ **绝不存明文、绝不回显** hash（`AuthUser` 契约层就没有这个字段）。
- 为什么不用 bcrypt/argon2：本仓偏好零依赖（ADR-2 简洁优先）；`node:crypto` 的 scrypt 是标准 KDF，
  够用且省一个原生依赖（`better-sqlite3` 已是唯一的原生模块，不再加第二个）。

### §4.2 会话 token

- 32 随机字节（`randomBytes(32).toString('base64url')`）；库里只存 `sha256` 十六进制。
- 属性：`HttpOnly`（JS 读不到，防 XSS 窃取）、`SameSite=Lax`、`Path=/`、`Max-Age=AUTH_SESSION_TTL_MS`；
  `Secure` 由 `SB_COOKIE_SECURE='1'` 打开（**生产 HTTPS 必须开**；本地 http 开发不能开，否则 cookie 不落）。

### §4.3 CSRF：复用既有 originCheck（不新造）

服务端 `security.ts` 的 `originCheck` 已对**非幂等方法强制合法 Origin**（继承 v1 SEC-09）。
cookie 会话 + 该闸门＝**跨站写请求被拦**，故无需再引 CSRF token。★ 这是「同源 Web + 写操作验 Origin」
这套组合的红利，别重复造轮子；但也意味着**这个闸门不能被削弱**。

### §4.4 登录限流（防撞库）

同一邮箱在 `AUTH_LOGIN_WINDOW_MS`（15 分钟）内失败达 `AUTH_MAX_LOGIN_FAILURES`（5 次）即锁定 →
`429 TOO_MANY_ATTEMPTS`。窗口内登录成功即清零。⚠️ 本版是**进程内内存计数**（重启清零）——
足够挡「在线暴力试」，挡不住分布式慢速撞库；后者需外部存储（列 M2 之后）。

---

## §5 验收判据（本版已跑 / 待跑如实标注）

| 判据 | 状态 |
|---|---|
| 注册 → 自动登录 → `/me` 回当前用户 | ✅ 单测 |
| 重复邮箱 → 409；大小写不同视为同一账号 | ✅ 单测 |
| 密码过短 / 邮箱非法 / 昵称超长 → 400 | ✅ 单测 |
| 登录密码错 → 401 `CREDENTIALS_INVALID`（不泄露邮箱是否存在） | ✅ 单测 |
| 连续失败 5 次 → 429；成功登录后清零 | ✅ 单测 |
| 会话过期 → `/me` 401 | ✅ 单测 |
| 库内不存明文 token、不存明文密码、不回显 hash | ✅ 单测 |
| cookie 属性 HttpOnly / SameSite=Lax | ✅ 单测 |
| `SB_REQUIRE_AUTH=1` 时无 cookie 访问业务端点 → 401；带 cookie → 放行 | ✅ 单测 |
| **浏览器真机走通注册/登录/登出** | ⏳ 待跑（前端 UI 在途） |
| **邮箱验证 / 密码找回** | ⏳ 本版未做（见 §6） |

---

## §6 本版未做（诚实记账）

1. **数据隔离（M2）**：`sessions`/`messages`/`quiz_bank`/`quiz_notes`/`term_library`/`user_memory`/`flow_*`/
   `knowledge_*` 等**全部是全局表、无 `user_id`** ⇒ 现在若强制鉴权，登录用户互相可见全部数据。
   **M2 给所有业务表补 `user_id` + 所有查询加 `WHERE user_id=?` + SSE 叠加 user 维度防串台**。
2. **邮箱验证**：注册即可用，不发验证邮件（需 SMTP / 邮件服务，本版未引）。
3. **密码找回**：需发信通道，同上未做 ⇒ **用户忘密码本版无法自助找回**（已知缺口）。
4. **多设备 / 会话管理**：不提供「登出其它设备」「查看登录设备」。
5. **微信 / 手机号登录**：M4，企业资质就绪后接入，映射到同一 user。
6. **限流的持久化**：进程内内存计数，重启清零（清单点见 §4.4）。

---

## §7 后续批次

- **M2**：数据隔离（`user_id` 全表 + 查询过滤 + SSE 用户维度）→ 与 `SB_REQUIRE_AUTH=1` **同批开**。
- **M3**：部署（Docker + Nginx/Caddy TLS + 备案域名 + `SB_DATA_DIR` 持久卷 + 备份）。
- **M4**：微信/手机号登录（企业资质后）+ 邮箱验证 + 密码找回。
