/**
 * auth — 账号与会话契约（docs/AUTH-SPEC.md，先契约后实现）。
 *
 * 定位：把「本地单用户」推向「Web 多用户」的第一块地基——**邮箱 + 密码**账号体系。
 * 为什么是邮箱（而非微信 / 手机号）：微信网页授权与短信验证码**都要求企业资质**，
 * 个人开发者做不了（见 SPEC §0 资质矩阵）；邮箱 + 密码零资质、零第三方依赖，
 * 是当前唯一能独立上线的登录方式。微信登录列为 M4 增强（企业资质就绪后接入，
 * 统一映射到同一 user，不新建账号）。
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
  | 'UNAUTHENTICATED';

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
