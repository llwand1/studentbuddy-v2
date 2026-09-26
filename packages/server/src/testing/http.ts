/**
 * testing/http.ts —— server 侧 HTTP 测试的**共享搭景**（测试削减档 1）。
 *
 * ★ 为什么要有它：39 个测试文件各自手抄同一段前置（建临时库 → 动态 import 起 app →
 *   注册账号 → 带 Origin 的 req 助具）。这些不是断言，是**每台机器上都长一样的脚手架**，
 *   抽出来一份，各文件只留自己那条不变量。
 *
 * ★ 三条设计约束（都是现查到的，不是口味）：
 *  1. **只出具名 `get`/`post`/`put`/`patch`/`delete`**，不做 `req(method, url)`——动态取方法
 *     会让 TS 丢掉 `Test` 类型、`.body` 就没法断言（原话与理由见
 *     `routes/settings-tenancy.test.ts` 顶注，这里照办而不是重新发明）。
 *  2. `SB_DATA_DIR` **必须早于** `import('../index.js')` 落进 env（index 一加载就开库），
 *     所以本模块内部一律动态 import；调用方写 `const { req } = await boot('tag')`。
 *  3. 账号由**调用方在模块顶层 await 一次**，本模块不缓存 ⇒ 谁需要 A/B 两个账号自己点；
 *     `users` 表通常不在 `beforeEach` 的清理范围内，同邮箱重复建号第二次起撞
 *     `EMAIL_TAKEN`，会把整个文件的用例一起拖成"没跑起来"。
 *  4. `signUp` **直落「账号 + 会话」两层，不借道 `POST /api/auth/register`**（这条原先写在
 *     `routes/tenancy.test.ts` 的夹具注释里，档 1 把夹具收进本模块时把理由一起移了过来）：
 *     注册端点自 2026-09-22 起免验证码（契约 §2.7 作废），但那条路仍要吃
 *     `register-limit.ts` 的 **5/小时 IP 名额**，而测试全走同一个出口 IP ⇒ 借道注册等于让
 *     "注册阈值一改，这些文件跟着红"。附带好处是省掉一次发信打桩（登录码只能从邮件里拿）。
 *     注册端点本身的端到端覆盖留在 `routes/auth.test.ts`，不在这里重复。
 *
 * ★ 本模块只收搭景，**不收断言**：把断言搬进公共件等于把锁的口径藏起来，
 *   红的时候没人知道守的是哪条不变量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

/** 合法前端源：写操作要过跨源闸门，所有 HTTP 测试都要带上它。 */
export const TEST_ORIGIN = 'http://localhost:5173';

/** 过 `auth/password.ts` 强度校验的固定口令（不是运行态配置，测试里不涉口令策略）。 */
export const TEST_PASSWORD = 'good-password-1';

export interface SignedUp {
  cookie: string;
  id: string;
  nickname: string;
}

/**
 * 搭景包的形状。**故意不手写各成员签名**：`@types/supertest` 是 `export =` 形式，
 * 在 `module: NodeNext` 下既不能 `import supertest = require(...)`、也没法写
 * `typeof import('supertest').default`（TS2694）。而这里要守的那条约束——
 * `req.get/post/...` 必须带得出 `Test` 类型好让调用方断言 `.body`——
 * 由 `boot()` 返回值的**推断结果**天然满足（见文件头约束 1）。
 */
export type HttpKit = Awaited<ReturnType<typeof boot>>;

/**
 * 起一个独立的临时库 + 整个 Express 实例。
 *
 * @param tag 临时目录后缀（沿用 `sb-` 前缀，`tools/test-tmp.mjs` 的整根回收才认得它）
 * @param opts.requireAuth 置 true 时写 `SB_REQUIRE_AUTH=1`（全站要登录的那档）
 */
export async function boot(tag: string, opts: { requireAuth?: boolean } = {}) {
  process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `sb-${tag}-`));
  if (opts.requireAuth) process.env.SB_REQUIRE_AUTH = '1';

  const { app } = await import('../index.js');
  const { getDb, closeDb } = await import('../storage/db.js');
  const { createUser } = await import('../auth/users.js');
  const { createSession } = await import('../auth/session.js');
  const request = (await import('supertest')).default;

  async function signUp(email: string, nickname?: string): Promise<SignedUp> {
    const user = await createUser(email, TEST_PASSWORD, nickname);
    const { token } = createSession(user.id);
    return { cookie: `${AUTH_COOKIE_NAME}=${token}`, id: user.id, nickname: user.nickname };
  }

  /** 带 Origin 的薄助具；cookie 省略即"不登录"（匿名请求要能表达）。 */
  const req = {
    get: (url: string, cookie?: string) => {
      const r = request(app).get(url).set('Origin', TEST_ORIGIN);
      return cookie ? r.set('Cookie', cookie) : r;
    },
    post: (url: string, cookie?: string, body?: unknown) => {
      const r = request(app).post(url).set('Origin', TEST_ORIGIN);
      if (cookie) r.set('Cookie', cookie);
      return body === undefined ? r : r.send(body as object);
    },
    put: (url: string, cookie?: string, body?: unknown) => {
      const r = request(app).put(url).set('Origin', TEST_ORIGIN);
      if (cookie) r.set('Cookie', cookie);
      return body === undefined ? r : r.send(body as object);
    },
    patch: (url: string, cookie?: string, body?: unknown) => {
      const r = request(app).patch(url).set('Origin', TEST_ORIGIN);
      if (cookie) r.set('Cookie', cookie);
      return body === undefined ? r : r.send(body as object);
    },
    delete: (url: string, cookie?: string) => {
      const r = request(app).delete(url).set('Origin', TEST_ORIGIN);
      return cookie ? r.set('Cookie', cookie) : r;
    },
  };

  return { app, request, getDb, closeDb, signUp, req };
}
