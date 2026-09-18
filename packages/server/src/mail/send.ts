/**
 * mail/send — 验证码邮件的发信通道（契约 docs/AUTH-SPEC.md §4.6）。
 *
 * ★★ 本仓**第一次引入第三方服务**（Resend），故刻意做成两层：`MailSender` 接口 +
 *    两个实现（Resend / 控制台兜底）。接口存在的理由很实在——**单测与本地开发不该依赖外部服务**，
 *    否则"跑个用例要联网、要额度、还可能给真人发信"。
 *
 * ★ 为什么只能用海外服务商：服务器在海外（不备案）⇒ 国内发信厂商（阿里云 / 腾讯云）
 *   **全部要求域名备案**，出局。代价是**送达率**：国内厂商的看家本领恰恰是对 QQ / 163 做白名单优化，
 *   而目标用户是国内学生、QQ 邮箱占绝大多数 ⇒ 送达率是本批最大的未验风险（SPEC §4.6）。
 *   缓解五条（独立发信子域 / SPF+DKIM+DMARC / 三档实测 / 文案避特征 / 密码兜底）见契约。
 *
 * ⚠️ **兜底通道只在没配 key 时生效**，且会打一条显眼警告。生产若误配成兜底，
 *    症状是「点了发送、界面说成功、邮箱里永远没有」——**这是最难查的一类故障**
 *    （服务端一切正常、日志里连错误都没有）。⇒ M3 部署清单必须验 `RESEND_API_KEY` 在位。
 */
import { AUTH_CODE_TTL_MS, type AuthCodePurpose } from '@sb/shared';

/** 发信请求体。**纯文本**，刻意不带 HTML——§4.6 缓解第 4 条：文案要避开垃圾邮件特征。 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** 发信通道。**失败必须抛**——静默吞掉会让"邮件没发出去"变成"用户干等"（ADR-5 同源）。 */
export interface MailSender {
  /** 通道名（日志用，**不含任何凭据**）。 */
  readonly name: string;
  send(msg: MailMessage): Promise<void>;
}

/** 发信超时。★ 必须有：`fetch` 没有默认超时 ⇒ 上游 hang 住时请求会**无限静默等待**
 *  （本仓在 LLM 上游上为这条付过一次学费，见 `llm/upstream-timeout.ts`）。 */
const MAIL_TIMEOUT_MS = 15_000;

/** Resend 发信端点。写成常量而非配置项：换厂商是**换实现**（新写一个 `MailSender`），不是改 URL。 */
const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** 控制台兜底：把邮件正文打到日志（本地开发从终端抄验证码）。 */
const consoleSender: MailSender = {
  name: 'console',
  send(msg: MailMessage): Promise<void> {
    // eslint-disable-next-line no-console -- 开发通道的**唯一**输出口，就是给人看的
    console.log(`[sb-mail] (未配发信通道，仅打印) to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return Promise.resolve();
  },
};

/** Resend HTTP 通道。 */
function resendSender(apiKey: string, from: string): MailSender {
  return {
    name: 'resend',
    async send(msg: MailMessage): Promise<void> {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text }),
        signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
      });
      // ⚠️ 只记状态码，**不记响应体**：出错时它可能回显请求内容，而日志比库更容易被翻。
      if (!res.ok) throw new Error(`resend http ${res.status}`);
    },
  };
}

/** 测试注入用。`null` = 撤销注入、回到按环境变量解析。 */
let override: MailSender | null = null;

export function setMailSender(sender: MailSender | null): void {
  override = sender;
}

let warnedAboutFallback = false;

/**
 * 解析当前发信通道：注入优先 → `RESEND_API_KEY` + `SB_MAIL_FROM` → 控制台兜底。
 * ★ **不缓存结果**：环境变量在测试里是逐个用例改的，缓存会让"改了 env 不生效"成为一个静默陷阱。
 */
export function getMailSender(): MailSender {
  if (override) return override;
  const apiKey = process.env.RESEND_API_KEY ?? '';
  const from = process.env.SB_MAIL_FROM ?? '';
  if (apiKey && from) return resendSender(apiKey, from);
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    // ★ 这条警告是"生产误配"的唯一现场证据，措辞必须能被搜到、能指路。
    console.warn(
      '[sb-mail] 未配置 RESEND_API_KEY / SB_MAIL_FROM ⇒ 验证码邮件只打印到日志，**不会真的发出**。' +
        '本地开发可忽略；生产环境必须配齐，否则用户永远收不到验证码（表现为「发送成功但邮箱没信」）。',
    );
  }
  return consoleSender;
}

/** 清掉"已警告"标记（**仅测试用**：避免用例之间互相吞掉那条警告）。 */
export function resetMailWarnings(): void {
  warnedAboutFallback = false;
}

/** 用途 → 邮件主题后缀。★ 三者措辞刻意不同：用户收件箱里一眼能分辨这封信是干什么的。 */
const SUBJECT_BY_PURPOSE: Record<AuthCodePurpose, string> = {
  login: '登录验证码',
  register: '邮箱验证',
  reset: '重置密码验证码',
};

/**
 * 拼验证码邮件。★ 三条刻意的写法（都服务于送达率）：
 *  ① **不带任何链接**——正文里出现 URL 是最典型的垃圾邮件特征，而验证码信**本来就不需要链接**；
 *  ② **给纯文本**、不用 HTML 模板（§4.6 缓解第 4 条）；
 *  ③ **把码单独成行**且**在开头就出现**——用户一眼能抄，也降低"这是营销邮件"的判定概率。
 * ★ 有效期文案由常量算出来（`AUTH_CODE_TTL_MS`），**不写死"5 分钟"**：改了常量文案跟着变，
 *   否则用户会按过期的说法理解（而这类不一致永远不会被测试发现）。
 */
export function buildCodeMail(to: string, code: string, purpose: AuthCodePurpose): MailMessage {
  const minutes = Math.round(AUTH_CODE_TTL_MS / 60_000);
  const text = [
    `${code}`,
    '',
    `这是你的${SUBJECT_BY_PURPOSE[purpose]}，${minutes} 分钟内有效。`,
    '请勿把验证码告诉任何人，我们不会向你索要它。',
    '如果不是你本人操作，忽略这封邮件即可。',
  ].join('\n');
  return { to, subject: `studentbuddy ${SUBJECT_BY_PURPOSE[purpose]}`, text };
}
