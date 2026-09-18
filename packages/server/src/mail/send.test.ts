/**
 * mail/send 测试：邮件拼装 + 通道解析 + Resend 请求形状（契约 docs/AUTH-SPEC.md §4.6）。
 *
 * ★ 这层是**本仓第一次引入第三方服务**，故两件事必须在测试里钉死：
 *   ① **兜底通道不会静默冒充成功**——没配 key 时走控制台，且打显眼警告；
 *   ② **发信失败必须抛**（不能吞）——吞掉会让"邮件没发出去"变成"用户干等"。
 * ★ 网络用 `vi.stubGlobal('fetch', …)` 打桩，**绝不真发信**（会烧 Resend 额度、给真人发邮件）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AUTH_CODE_TTL_MS } from '@sb/shared';
import {
  buildCodeMail,
  getMailSender,
  setMailSender,
  resetMailWarnings,
  type MailMessage,
  type MailSender,
} from './send.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  setMailSender(null);
  resetMailWarnings();
  delete process.env.RESEND_API_KEY;
  delete process.env.SB_MAIL_FROM;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.RESEND_API_KEY = ORIGINAL_ENV.RESEND_API_KEY;
  process.env.SB_MAIL_FROM = ORIGINAL_ENV.SB_MAIL_FROM;
  setMailSender(null);
});

describe('mail/send — 邮件正文拼装（送达率的三条写法都在这里）', () => {
  it('验证码出现在**正文首行**（用户一眼能抄），且有效期文案由常量算出', () => {
    const msg = buildCodeMail('a@example.com', '042317', 'login');
    expect(msg.to).toBe('a@example.com');
    expect(msg.text.split('\n')[0]).toBe('042317');
    expect(msg.text).toContain(`${Math.round(AUTH_CODE_TTL_MS / 60_000)} 分钟内有效`);
  });

  it('★ 正文**不含任何链接**（正文出现 URL 是最典型的垃圾邮件特征，而验证码信本不需要链接）', () => {
    for (const purpose of ['login', 'register', 'reset'] as const) {
      const msg = buildCodeMail('a@example.com', '042317', purpose);
      expect(msg.text).not.toMatch(/https?:\/\//);
      expect(msg.text).not.toMatch(/<[a-z]/i); // 也不带 HTML 标签：§4.6 要纯文本
    }
  });

  it('三种用途的主题**互不相同**（用户收件箱里一眼能分辨这封信是干什么的）', () => {
    const subjects = (['login', 'register', 'reset'] as const).map((p) => buildCodeMail('a@example.com', '042317', p).subject);
    expect(new Set(subjects).size).toBe(3);
    for (const s of subjects) expect(s).toContain('studentbuddy');
  });

  it('正文不把验证码写进主题（主题会出现在锁屏预览里，泄露面更大）', () => {
    const msg = buildCodeMail('a@example.com', '042317', 'login');
    expect(msg.subject).not.toContain('042317');
  });
});

describe('mail/send — 通道解析', () => {
  it('没配 key / from ⇒ 控制台兜底，且**打一条显眼警告**（生产误配的唯一现场证据）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getMailSender().name).toBe('console');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('RESEND_API_KEY');
  });

  it('只配了 key 但没配 from ⇒ 仍走兜底（Resend 必须有合法发件人，半配不能当配好）', () => {
    process.env.RESEND_API_KEY = 're_fake';
    expect(getMailSender().name).toBe('console');
  });

  it('key + from 齐备 ⇒ 走 resend 通道', () => {
    process.env.RESEND_API_KEY = 're_fake';
    process.env.SB_MAIL_FROM = 'studentbuddy <no-reply@mail.example.com>';
    expect(getMailSender().name).toBe('resend');
  });

  it('注入优先于环境变量（测试与本地开发的替换口）', () => {
    process.env.RESEND_API_KEY = 're_fake';
    process.env.SB_MAIL_FROM = 'a@b.com';
    const stub: MailSender = { name: 'stub', send: () => Promise.resolve() };
    setMailSender(stub);
    expect(getMailSender()).toBe(stub);
  });
});

describe('mail/send — Resend 请求形状与失败处置', () => {
  function armResend(): void {
    process.env.RESEND_API_KEY = 're_fake';
    process.env.SB_MAIL_FROM = 'studentbuddy <no-reply@mail.example.com>';
  }

  it('POST /emails：Bearer 头 + from/to/subject/text 四字段，**不夹带别的字段**', async () => {
    armResend();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    await getMailSender().send(buildCodeMail('a@example.com', '042317', 'login'));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_fake');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'text', 'to']);
    expect(body.to).toEqual(['a@example.com']); // ★ 数组形态（Resend 的契约），不是字符串
    expect(String(body.text)).toContain('042317');
  });

  it('**非 2xx 必须抛**（吞掉会让"没发出去"变成"用户干等"），且错误消息只带状态码', async () => {
    armResend();
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"message":"bad key"}', { status: 401 })));
    await expect(getMailSender().send(buildCodeMail('a@example.com', '042317', 'login'))).rejects.toThrow('resend http 401');
  });

  it('★ 超时是显式设的（`fetch` 无默认超时 ⇒ 上游 hang 住会无限静默等待）', async () => {
    armResend();
    let sawSignal = false;
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      sawSignal = init.signal instanceof AbortSignal;
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    await getMailSender().send(buildCodeMail('a@example.com', '042317', 'login'));
    expect(sawSignal).toBe(true);
  });

  it('控制台兜底把正文打进日志（本地开发从终端抄码），且**返回成功**', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const msg: MailMessage = buildCodeMail('a@example.com', '042317', 'login');
    await expect(getMailSender().send(msg)).resolves.toBeUndefined();
    expect(String(log.mock.calls[0]?.[0])).toContain('042317');
  });
});
