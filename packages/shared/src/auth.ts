/**
 * auth — 账号与会话契约（docs/AUTH-SPEC.md，先契约后实现）。
 *
 * 定位：把「本地单用户」推向「Web 多用户」的第一块地基——**邮箱 + 密码**账号体系。
 * 为什么是邮箱（而非微信 / 手机号）：微信网页授权与短信验证码**都要求企业资质**，
 * 个人开发者做不了（见 SPEC §0 资质矩阵）；邮箱 + 密码零资质、零第三方依赖，
 * 是当前唯一能独立上线的登录方式。
 *
 * ★ 2026-09-18（M1.5）：**微信 / 手机号登录永久不做**（对个人主体是硬门槛，不是时间问题，
 *   SPEC §0.1），原「M4 增强」计划作废；同批补上**邮箱验证码登录**（§2.5 / §4.5）——
 *   它与密码登录**产出同一种会话**，不是第二套账号体系。
 *   ★ 两者是**双通道并存**、不是替代：密码登录不依赖邮件（§4.6 缓解第 5 条），
 *   邮件通道挂了用户仍能进；这也是「密码登录不能删」的唯一理由。
 *
 * ★ 单一事实源：常量 / 类型 / 校验一律在此定义，server 与 web 只引用不复制。
 *   **校验本身就是契约**——前端「提交前先拦」与服务端「写入前再拦」必须是同一份，
 *   各写一份必然漂成「表单放行、服务端拒绝」（同 `study-flow-params.ts` 那次的教训）。
 */

// ── 常量 ───────────────────────────────────────────────────

/**
 * 会话 cookie 名。**前后端同源**（web 经 vite proxy 打 /api，生产同域），故
 * httpOnly cookie 直接生效、无需 CORS credentials 协商。
 */
export const AUTH_COOKIE_NAME = 'sb_sid';

/** 邮箱长度上限：RFC 5321 的 254，超长一律拒（不引正则之外的 RFC 细节，MVP 够用）。 */
export const AUTH_EMAIL_MAX = 254;
/**
 * 密码长度区间。★ 下限 8 是**唯一**硬约束，不强制大小写/符号混排——
 * 复杂度规则会把用户逼向「Passw0rd!」这类可预测串，且本仓没有口令强度评估器。
 */
export const AUTH_PASSWORD_MIN = 8;
/** 上限 100：给 KDF 输入设上界（防超长口令把 scrypt 变成 DoS 面）。 */
export const AUTH_PASSWORD_MAX = 100;
/** 昵称上限（与 PK 的 `NICKNAME_MAX` 同口径，便于 M4 统一身份时合并）。 */
export const AUTH_NICKNAME_MAX = 20;
/** 会话有效期：30 天。到期即失效，前端下次请求收到 401 后回登录页。 */
export const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 登录失败容忍：同一账号在 `AUTH_LOGIN_WINDOW_MS` 内连续失败达到它即锁定（429）。
 * ★ 这是**防撞库**的最低门槛，不是可选优化——没有它，弱口令库一晚上就能试穿。
 */
export const AUTH_MAX_LOGIN_FAILURES = 5;
/** 失败计数窗口：15 分钟。窗口内成功登录即清零。 */
export const AUTH_LOGIN_WINDOW_MS = 15 * 60 * 1000;

// ── 邮箱验证码常量（M1.5，契约 §2.5 / §4.5）──────────────────

/**
 * 验证码位数：**6 位数字**（10^6 空间）。
 * ★ 位数不是随手定的：少一位空间掉一个数量级（5 位＝10 万，脚本秒级试穿），
 *   多一位用户抄错率上升。6 位是「用户抄得动 × 暴力成本够高」的交点——
 *   而**暴力成本够高有一半靠 `AUTH_CODE_MAX_ATTEMPTS`**，不是靠位数本身（见 §4.5）。
 */
export const AUTH_CODE_LEN = 6;
/**
 * 验证码有效期：5 分钟。
 * ★ 下限是「用户切到邮箱、抄回来」的物理时间；上限是攻击窗口——越长，爆破与
 *   「捡到别人旧邮件」的窗口越宽。5 分钟是常见取值，本版不做滑动续期。
 */
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
/**
 * 同一条码允许的最大校验失败次数，达到即作废（**不靠过期兜底**）。
 * ★★ **这是 6 位码的唯一防线**：10^6 空间对脚本是分钟级的事，限流只挡「发码」、
 *   挡不住「拿一条已发的码反复试」。此值必须与位数一起改（改小一位就要同步收紧）。
 */
export const AUTH_CODE_MAX_ATTEMPTS = 5;
/** 同邮箱两次发码的最小间隔：60 秒（防连点，也顺带防「点两次拿到两个可用码」）。 */
export const AUTH_CODE_RESEND_INTERVAL_MS = 60 * 1000;
/**
 * 同邮箱每小时最多发几封。
 * ★ 与发信厂商免费额度**是一套账**：Resend 免费 3000 封/月 ≈ 100 封/天，
 *   而本值 5 ⇒ **单个账号一小时就能吃掉 5% 的日额度**（SPEC §4.6 末条）。
 *   ⇒ 改这个数必须回头重算额度，反之亦然。
 */
export const AUTH_CODE_MAX_PER_HOUR = 5;
/** 同 IP 每小时最多发几封（防「换邮箱刷」——只按邮箱限流的话换个地址就绕过了）。 */
export const AUTH_CODE_MAX_PER_IP_HOUR = 20;
/**
 * ★ **`register` 用途单独一条更严的 IP 上限**（M1.6，契约 §2.7）。
 *
 * 为什么必须单独一条：`register` 是**唯一给「未注册地址」发信**的用途
 * （`login` / `reset` 只发给已注册邮箱）⇒ 它天然是**垃圾邮件与钓鱼的跳板**，
 * 滥用面与另外两个用途不是一个量级。20 封/小时对注册而言过宽——**正常人一小时内
 * 不会注册 5 次**，而脚本会。
 *
 * ⚠️ **与 20 共用同一个桶是错的**：那样「有人拿 register 刷满」会连带**掐死同一出口 IP
 * 上所有人的验证码登录**（校园网 / 公司网 / 运营商 NAT 全中招）。⇒ 实现上
 * IP 桶的键是 `${purpose}:${ip}`（见 `auth/code-limit.ts`），**各用途各有各的名额**。
 *
 * ⚠️ **真正的硬顶不是这个数，是 Resend 的免费额度**（100 封/天，§4.6）⇒ 攻击者能做到的
 * 最坏是**烧光当天额度**（配额 DoS），而不是发无限垃圾邮件。这个定性决定了本版
 * **不上人机验证**（§2.7 第 3 条：留作后备，有证据再加）。
 *
 * ⚠️⚠️ **必须承认的代价：这个数会误伤正常用户，而且伤到的正是目标用户。**
 * 5 封/小时是按**出口 IP** 计的，而校园网 / 宿舍网 / 运营商 NAT 下成百上千人共用一个出口 IP。
 * 后果是可复现的：**同一间教室 20 个人一起注册，第 6 个人开始收到 429**——
 * 而本项目的主要用户群体恰恰在校园网里（`docs/` 的产品定位）。这不是理论风险，
 * 是上线后第一个星期就会收到的反馈。
 *
 * 明知会误伤还这么定，理由是**两害相权**：放宽到 20 意味着「一个人 5 分钟烧光当天全部发信额度」，
 * 那会让**所有人**（含已注册用户的验证码登录）一起瘫掉——比误伤几个人严重得多。
 * ⇒ 本版**先按 5 上线**，并用下面两条来对冲：
 *   1. 429 的响应体带 `retryAfterMs`（毫秒，契约 §2.5；`code-limit.ts` 算 → `routes/auth.ts` 回）
 *      ⇒ 前端**能**提示「约 N 分钟后可重发」，而不是让人对着一个没有解释的失败干瞪眼。
 *      ⚠️ 前端**尚未**读这个字段（`AccountBox.tsx` 仍只显示服务端原文案），挂 `test-plan.md` §6；
 *   2. 前端在冷却期给「没收到？看看垃圾邮件」的提示（`AccountBox.tsx` 已实现）。
 *
 * ⚠️ **第 1 条曾经只是一句文档承诺**（2026-09-18 记账）：`admitSend` 一直在算 `retryAfterMs`、
 *   单测也一直在断言它，但 `sendCode` 把它丢掉、只翻成一个裸错误码 ⇒ **这个字段从未到达响应体**。
 *   所有单元测试都是绿的（它们只断言"算得对"，没人断言"到得了"），是 `_probe/auth-smoke.mjs`
 *   真机跑到第 11 节才把它揪出来。**教训：契约里写的"已实现"，指的是"用户能看见"，不是"某层算过"。**
 *
 * ★ **触发升级的条件**（有证据再动，不预先加复杂度）：
 *   - 若上线后「同一 IP 多账号注册被拦」成为高频反馈 ⇒ 把 IP 维度从**注册**上摘掉，
 *     改为**只按邮箱 + 全局日额度**限流（IP 限流对共享出口天生不适配）；
 *   - 若出现真实刷量证据（额度被异常消耗）⇒ 再上 Turnstile（§2.7 第 3 条）。
 *   两条都不在本版范围，写在这里是为了**让下一个改这个数的人知道当初为什么是 5**。
 */
export const AUTH_CODE_MAX_PER_IP_REGISTER_HOUR = 5;
/** 上述「每小时」类限流的统计窗口。单列常量，避免三处各写一个 `60 * 60 * 1000`。 */
export const AUTH_CODE_WINDOW_MS = 60 * 60 * 1000;

// ── 类型 ───────────────────────────────────────────────────

/**
 * 登录用户（`/api/auth/me` 响应主体）。
 * ★ **绝不包含 password_hash**——它是库内列，不是契约字段；契约层面就不给「不小心下发」留口子。
 */
export interface AuthUser {
  id: string;
  email: string;
  nickname: string;
  /** ISO 字符串（`datetime('now')` 的库内格式） */
  createdAt: string;
}

/**
 * 验证码用途。★ **按用途隔离不是洁癖**：登录的码若能拿去改密码，则「为登录而发」的
 * 码泄露一次 = 密码重置权泄露一次。库内 `auth_codes.purpose` 与校验时的入参必须同值。
 */
export type AuthCodePurpose = 'login' | 'register' | 'reset';

/** 用途全集（校验用；顺序即 UI 展示顺序）。 */
export const AUTH_CODE_PURPOSES: readonly AuthCodePurpose[] = ['login', 'register', 'reset'];

/**
 * 账号域错误码。**域层不碰 HTTP**——抛这个码，由薄路由映射状态码（同 `PkRoomError` 手法）。
 */
export type AuthError =
  /** 邮箱格式非法 / 超长 → 400 */
  | 'EMAIL_INVALID'
  /** 邮箱已被注册 → 409 */
  | 'EMAIL_TAKEN'
  /** 密码长度不合规 → 400 */
  | 'PASSWORD_WEAK'
  /** 昵称非法（超 `AUTH_NICKNAME_MAX`）→ 400 */
  | 'NICKNAME_INVALID'
  /** 邮箱或密码不对 → 401（**两情况合成一个码**：分开等于告诉攻击者「这个邮箱存在」） */
  | 'CREDENTIALS_INVALID'
  /** 失败次数超限、暂时锁定 → 429 */
  | 'TOO_MANY_ATTEMPTS'
  /** 未登录 / 会话失效 → 401 */
  | 'UNAUTHENTICATED'
  /** 验证码用途不是 `login`/`register`/`reset` → 400（M1.5） */
  | 'PURPOSE_INVALID'
  /** 发码过频（三道限流任一命中）→ 429（M1.5；★ 不区分是哪一道，理由见 SPEC §4.5） */
  | 'CODE_RATE_LIMITED'
  /** 验证码不对 / 不存在 / 已用过 / 尝试次数耗尽 → 400（M1.5） */
  | 'CODE_INVALID'
  /** 验证码已过期 → 400（M1.5；★ 与 `CODE_INVALID` 分开，因为用户动作不同：重发 vs 重输） */
  | 'CODE_EXPIRED'
  /** 验证码邮件没发出去（发信通道故障）→ 502（M1.5） */
  | 'MAIL_SEND_FAILED'
  /** GitHub OAuth 未配置（缺 SB_GITHUB_CLIENT_ID/SECRET）→ 503（M1.8，§2.8） */
  | 'GITHUB_NOT_CONFIGURED'
  /** GitHub 侧换 token / 拉身份失败 → 502（M1.8，§2.8） */
  | 'GITHUB_AUTH_FAILED'
  /** OAuth state 校验不过（CSRF 防线）→ 400（M1.8，§2.8） */
  | 'GITHUB_STATE_INVALID'
  /** GitHub 账号拿不到已验证邮箱 → 502（M1.8，§2.8） */
  | 'GITHUB_EMAIL_UNAVAILABLE';


// ── GitHub OAuth 常量（M1.8，契约 §2.8）──────────────────────

/**
 * OAuth state（CSRF 防线）的短期 cookie 名。
 * ★ 与会话 cookie `sb_sid` 分离：state 是**一次性的握手凭据**，10 分钟即过期，
 *   不该和 30 天的登录态共用命名空间——混用会让「清 state」误伤登录态（反之亦然）。
 */
export const AUTH_GITHUB_STATE_COOKIE = 'sb_gst';
/** state cookie 有效期：10 分钟。覆盖「跳 GitHub → 用户输入凭据 → 跳回来」的常规耗时。 */
export const AUTH_GITHUB_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * 登录方式可用性（`GET /api/auth/providers` 响应字段之一）。
 * ★ 前端据此决定渲染不渲染 GitHub 按钮——**按钮常在、点了 503** 是坏体验；
 *   服务端没配 GitHub 凭据时前端就不画这个入口（ADR-5：失败态能在第一时间被看见）。
 */
export interface AuthProviders {
  github: boolean;
}

/**
 * 部署形态（2026-09-20 拍板：本地与线上的行为从此是**显式分叉**，不是隐式巧合）。
 * · `local`  —— `SB_REQUIRE_AUTH` 关：**本地单人形态**，免登录直接可用（后端
 *   `ownerIdOf → null` = 不过滤/无主行，单人看到的就是全部历史）；后续本地专属功能
 *   （线上没有的）以这个值为分叉点。
 * · `cloud` —— `SB_REQUIRE_AUTH` 开：**线上多用户形态**，强制登录 + 落地页。
 */
export type DeployForm = 'local' | 'cloud';

/**
 * 登录面信息（`GET /api/auth/providers` 响应主体，端点职责从「GitHub 可用性探针」
 * 扩为「前端启动要问的全部 auth 面信息」——一次请求拿全，不为此再加第二个端点）。
 */
export interface AuthSurface {
  providers: AuthProviders;
  form: DeployForm;
}


// ── 纯校验（前后端共用一份）────────────────────────────────

/**
 * 邮箱归一化：去空白 + **转小写**（大小写不敏感，避免 `A@x.com` 与 `a@x.com` 建出两个账号）。
 * 非法（非字符串 / 空 / 超长 / 格式不符）返回 `null`——调用方据此回 400，不猜、不纠正。
 *
 * ★ 不追求 RFC 5322 全量：MVP 不发验证邮件，只认「有本地部分 + @ + 有域 + 有点」这一档，
 *   宁可宽进（真正送达与否由后续「邮箱验证」环节决定）。
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > AUTH_EMAIL_MAX) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/**
 * 密码合规判定：`null` = 通过，否则回错误码。
 * ★ 只判长度，不做「必须含大小写数字」这类复杂度硬规则（理由见 `AUTH_PASSWORD_MIN` 注释）。
 */
export function passwordProblem(raw: unknown): AuthError | null {
  if (typeof raw !== 'string') return 'PASSWORD_WEAK';
  if (raw.length < AUTH_PASSWORD_MIN || raw.length > AUTH_PASSWORD_MAX) return 'PASSWORD_WEAK';
  return null;
}

/**
 * 昵称归一化：可空字段——**不传即合法**（会自动从邮箱派生，见 `nicknameFromEmail`）。
 * 传了就必须 trim 后 1~`AUTH_NICKNAME_MAX` 字，否则 `null`（非法）。
 */
export function normalizeAuthNickname(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') return null;
  const nickname = raw.trim();
  if (!nickname || nickname.length > AUTH_NICKNAME_MAX) return null;
  return nickname;
}

/** 从邮箱派生默认昵称：取 `@` 前那段，超长截断；兜底「学习者」（邮箱本地部分为空时）。 */
export function nicknameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const trimmed = local.trim();
  if (!trimmed) return '学习者';
  return trimmed.slice(0, AUTH_NICKNAME_MAX);
}

// ── 验证码纯校验（M1.5，前后端共用一份）──────────────────────

/**
 * 用途归一化：命中 `AUTH_CODE_PURPOSES` 才返回，其余（含缺省 / 非字符串）一律 `null`。
 * ★ **不给缺省值**：默认成 `login` 看着方便，但「忘传 purpose」会被静默当成登录请求，
 *   而它本该是 400——**默认值要落在能被发现的那一侧**。
 */
export function normalizePurpose(raw: unknown): AuthCodePurpose | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  return (AUTH_CODE_PURPOSES as readonly string[]).includes(p) ? (p as AuthCodePurpose) : null;
}

/**
 * 验证码归一化：去空白后必须**恰好 `AUTH_CODE_LEN` 位且全是数字**，否则 `null`。
 *
 * ★ 为什么先 `trim` 再判长：用户从邮件里复制常带上首尾空格/换行，为此回 400
 *   属「把实现细节当用户错误」。
 * ★ 为什么**不做**「去掉中间空格 / 连字符」（`123 456`、`123-456`）：那是在猜用户意图，
 *   猜错就是把 `123456` 和 `123 456` 当成同一个码，白送一次尝试机会。
 */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  if (code.length !== AUTH_CODE_LEN) return null;
  return /^\d+$/.test(code) ? code : null;
}

/**
 * 由整数造 6 位码字符串（**补零**：`7` → `'000007'`）。
 * ★ 补零不是装饰：不补的话 `'7'` 与用户的 `'000007'` 对不上，且长度校验会把它拒掉。
 * ★ 取值上界由调用方给（`crypto.randomInt(0, 10 ** AUTH_CODE_LEN)`）——本函数是纯格式化，
 *   不负责随机性（随机源在 server 侧，见 `auth/codes.ts`，**绝不用 `Math.random()`**）。
 */
export function formatCode(n: number): string {
  return String(n).padStart(AUTH_CODE_LEN, '0');
}

