/**
 * 真机冒烟：账号体系（契约 docs/AUTH-SPEC.md）——四端点闭环 + **验证码注册（M1.6）** + 库层核对。
 *
 * 用法（三步）：
 *   1) mkdir -p _probe/data-auth-smoke
 *   2) SB_PORT=18799 SB_DATA_DIR=<abs 同一目录> npx tsx packages/server/src/index.ts > <abs>/server.log 2>&1
 *   3) SB_DATA_DIR=<abs> node _probe/auth-smoke.mjs
 *
 * ★★ 第 2 步的重定向（`> …/server.log 2>&1`）自 M1.6 起是**必需**的，不是可选：
 *   `register` 现在**必带邮箱验证码**，而 `auth_codes` 里只存 `SHA-256(code)`
 *   ⇒ **码无法从库里读回**。唯一能拿到码的地方是"发信那一刻"——未配
 *   `RESEND_API_KEY` / `SB_MAIL_FROM` 时 `getMailSender()` 返回**控制台兜底**
 *   （`mail/send.ts:41`），它把邮件正文（**码在首行**）打进 stdout。
 *   ⇒ 本脚本从日志文件里抓码：**不需要域名、不需要 Resend key、不会给真人发信**。
 *   ⚠️ 但兜底通道也正是**生产误配**的那条路（症状：界面说发送成功、邮箱永远没有）
 *      ⇒ 本脚本能证的是**码的流转**，证不了**邮件能不能进收件箱**（见 `test-plan.md` §6）。
 *
 * ★★ 本脚本的**核心回归锁**（§1c）：`register` 刚发过码之后，**同一邮箱**立刻发 `login` 码
 *   必须回 **200**。修复前（M1.5 的 `emailBlockedUntil` 把"最小间隔"与"每小时封数"从同一个
 *   数组推导）这里会是 **429**——那正是本批修掉的那个真实缺陷（症状：拿已注册邮箱点注册
 *   → 409 → 切登录页点发送 → 429 等 60 秒）。反向锁在 §1c-2：**同一用途**连点仍必须 429
 *   （分开的是**用途**，不是取消间隔）。
 *
 * ★ 刻意**不覆盖**的一条：`send-code(register)` 对**已注册邮箱**回 409 `EMAIL_TAKEN`。
 *   要触发它得先有一个"已注册、且 `register:邮箱` 的 60 秒间隔已过"的邮箱，而本脚本里
 *   注册动作刚发生在几秒前 ⇒ 必被间隔闸拦成 429（**这是对的**，间隔闸刻意排在策略表之前）。
 *   硬测它要给脚本塞一次 60 秒空等，收益不抵成本 ⇒ 该分支由 `routes/auth.test.ts` 覆盖
 *   （它用**直接落库**造账号来绕开同一条间隔，见该文件该用例的注释）。
 *
 * ★ 隔离性依据：`resolveDataDir()` 里 `SB_DATA_DIR` 命中即 `return`（最高优先级，见
 *   `storage/db.ts:34`），故本脚本只写临时库；核对库层时也只读那个临时库文件。
 * ★ 边界：不调 LLM、不联网、不读生产库；输出全 ASCII（避免 Git Bash 下中文乱码）。
 *
 * ★★ 限流预算（全脚本共用**一个出口 IP**，故必须数着用）：
 *   `register` 的 IP 桶只有 **5/小时**（`AUTH_CODE_MAX_PER_IP_REGISTER_HOUR`），且
 *   **409 也占名额**（`sendCode` 顺序＝校验 → **限流** → 策略 → 发信，`code-flow.ts:131`）；
 *   而 **429 不占名额**（被拒的请求不记账）。⇒ 计数器只记 `status === 200` 的次数，
 *   且"验上限"那一节（§11）**必须放在最后**。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.SB_SMOKE_BASE ?? 'http://127.0.0.1:18799';
const DATA_DIR = process.env.SB_DATA_DIR ?? '/tmp/sbauth';
const MAX_FAILURES = 5;
/** 服务端日志。默认取隔离目录下的 `server.log`——与文件头第 2 步的重定向目标一致。 */
const LOG_FILE = process.env.SB_SMOKE_LOG ?? path.join(DATA_DIR, 'server.log');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  [ok]   ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra ? `  -> ${extra}` : ''}`);
  }
};
const head = (t) => console.log(`\n== ${t}`);

async function call(p, { method = 'GET', body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (origin !== null) headers.Origin = origin ?? BASE;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应（如 403 文本）留给断言看 text */
  }
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    json,
    text,
    setCookie: sc,
    cookie: sc.map((c) => c.split(';')[0]).join('; '),
    rawSetCookie: sc.join('\n'),
  };
}

const stamp = Date.now().toString(36);
const email = (tag) => `smoke-${tag}-${stamp}@example.com`;
const PASSWORD = 'passw0rd123';

// ---------- 从服务端日志里抓验证码 ----------
//
// ★ 只认控制台兜底那一行 + 紧跟着的正文首行：
//     [sb-mail] (未配发信通道，仅打印) to=<addr> subject=studentbuddy 邮箱验证
//     123456
//   ⚠️ `mail/send.ts` 里**发信失败**也打 `[sb-mail]` 前缀（`console.error`），
//      但它后面没有 `to=…\n<6 位码>` 这个形状 ⇒ 天然不会被误抓。
const MAIL_RE = /\[sb-mail\][^\n]*to=(\S+)[^\n]*\n(\d{6})/g;

/** 该邮箱在日志里出现过的所有码（按出现顺序）。 */
function codeBlocksFor(addr) {
  if (!fs.existsSync(LOG_FILE)) return [];
  const text = fs.readFileSync(LOG_FILE, 'utf8');
  const out = [];
  let m;
  MAIL_RE.lastIndex = 0;
  while ((m = MAIL_RE.exec(text)) !== null) {
    if (m[1] === addr) out.push(m[2]);
  }
  return out;
}

/**
 * 等到该邮箱的第 `minCount` 封邮件出现为止。
 * ★ 为什么要 `minCount` 而不是"拿最后一个"：同一邮箱会**多次**收码（register 一次、
 *   login 一次…），只取最后一个的话，在日志尚未刷新的窗口里会**静默拿到上一封的码**
 *   ⇒ 断言照样绿，而它验的根本不是这次发的那封（假绿）。
 */
async function waitForCode(addr, minCount = 1, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const codes = codeBlocksFor(addr);
    if (codes.length >= minCount) return codes[codes.length - 1];
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** register 用途**被放行**的发码次数（★ 429 不计：被拒的请求不记账）。 */
let registerAdmitted = 0;

/** 发一封 register 码（记放行次数）。返回原始响应，不等待抓码。 */
async function sendRegisterCode(addr) {
  const res = await call('/api/auth/send-code', { method: 'POST', body: { email: addr, purpose: 'register' } });
  if (res.status === 200) registerAdmitted += 1;
  return res;
}

/** 发一封 login 码并抓到它。 */
async function sendLoginCode(addr) {
  const before = codeBlocksFor(addr).length;
  const res = await call('/api/auth/send-code', { method: 'POST', body: { email: addr, purpose: 'login' } });
  if (res.status !== 200) return { res, code: null };
  return { res, code: await waitForCode(addr, before + 1) };
}

/** 走完整注册链路：发码 → 抓码 → 填码建号。 */
async function registerWithCode(addr, { password = PASSWORD, nickname } = {}) {
  const before = codeBlocksFor(addr).length;
  const sent = await sendRegisterCode(addr);
  const code = sent.status === 200 ? await waitForCode(addr, before + 1) : null;
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { email: addr, ...(code ? { code } : {}), password, ...(nickname ? { nickname } : {}) },
  });
  return { sent, code, reg };
}

// ---------- 0) 可达性 ----------
try {
  await fetch(`${BASE}/api/status`);
} catch (e) {
  console.log(`[FATAL] server not reachable at ${BASE}: ${e.message}`);
  process.exit(2);
}
console.log(`[smoke] base=${BASE} dataDir=${DATA_DIR} log=${LOG_FILE}`);

const dbFile = path.join(DATA_DIR, 'studentbuddy.db');
if (!fs.existsSync(dbFile)) {
  console.log(`[FATAL] 未找到隔离库：${dbFile}`);
  console.log('        ★ 别用 /tmp（Windows 的 node 会解成 C:\\tmp\\…）；用绝对 Windows 路径。');
  console.log('        先用同一个 SB_DATA_DIR 起隔离实例，再跑本脚本（见文件头用法）。');
  process.exit(2);
}
if (!fs.existsSync(LOG_FILE)) {
  console.log(`[FATAL] 未找到服务端日志：${LOG_FILE}`);
  console.log('        M1.6 起 register 必带验证码，而码只存在于"发信那一刻"的日志里');
  console.log('        （库里只有 SHA-256，读不回明文）⇒ 起服务时**必须**重定向输出：');
  console.log(`        SB_PORT=18799 SB_DATA_DIR=<abs> npx tsx packages/server/src/index.ts > ${LOG_FILE} 2>&1`);
  console.log('        （或用 SB_SMOKE_LOG 指向你重定向到的那份日志）');
  process.exit(2);
}
const db = new Database(dbFile, { readonly: true });
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const sessionRows = () => db.prepare('SELECT token_hash FROM auth_sessions').all();
const authSessionCount = () => db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n;
const codeRows = () => db.prepare('SELECT code_hash, purpose, consumed_at FROM auth_codes').all();

// ---------- 1) register（M1.6：发码 → 填码 → 建号）----------
head('1) POST /api/auth/send-code + /register（M1.6 注册即验证）');
const n0 = userCount();
const e1 = email('a');
const { sent: sent1, code: code1, reg } = await registerWithCode(e1, { nickname: 'Smoke' });
ok('send-code(register) -> 200', sent1.status === 200, `got ${sent1.status} ${sent1.text.slice(0, 120)}`);
ok('★ 从服务端日志抓到 6 位注册码', /^\d{6}$/.test(code1 ?? ''), `got ${code1}`);
ok('status 200', reg.status === 200, `got ${reg.status} ${reg.text.slice(0, 120)}`);
ok('Set-Cookie 有 sb_sid', /sb_sid=/.test(reg.rawSetCookie), reg.rawSetCookie.slice(0, 120));
ok('cookie 是 HttpOnly', /HttpOnly/i.test(reg.rawSetCookie), reg.rawSetCookie.slice(0, 120));
ok('body.user 四字段齐全',
  !!reg.json?.user && ['id', 'email', 'nickname', 'createdAt'].every((k) => typeof reg.json.user[k] === 'string' || typeof reg.json.user[k] === 'number'),
  JSON.stringify(reg.json)?.slice(0, 160));
ok('响应体不含 password_hash', !reg.text.includes('password_hash'));
ok('响应体不含 scrypt$（凭据不外泄）', !reg.text.includes('scrypt$'));
ok('users 行数 +1', userCount() === n0 + 1, `${n0} -> ${userCount()}`);

// 再建一个号：后面所有 login 用途的检查都改用它，**免得和 e1 抢同一个 60 秒间隔键**
const e2 = email('b');
const reg2 = await registerWithCode(e2);
ok('第二个账号也建成功（供 login 用途的检查用）', reg2.reg.status === 200, `got ${reg2.reg.status} ${reg2.reg.text.slice(0, 120)}`);

// ---------- 1b) ★ 无码注册 = 后门（M1.6 最要紧的回归锁）----------
head('1b) ★ 无码注册必须是死路（旧路径已删）');
const nNoCode = userCount();
const noCode = await call('/api/auth/register', { method: 'POST', body: { email: email('nocode'), password: PASSWORD } });
ok('不传 code -> 400 CODE_INVALID', noCode.status === 400 && noCode.json?.code === 'CODE_INVALID',
  `${noCode.status} ${noCode.text.slice(0, 120)}`);
ok('★ users 行数不变（后门真的封了）', userCount() === nNoCode, `${nNoCode} -> ${userCount()}`);

// ---------- 1c) ★★ 本批缺陷的回归锁：间隔按「用途:邮箱」分开 ----------
head('1c) ★★ 跨用途不共享 60 秒间隔（register 刚发过，login 立刻能发）');
const loginCodeForE1 = await sendLoginCode(e1);
ok('★★ register 刚发过码，同邮箱立刻发 login 码 -> 200（修复前这里必 429）',
  loginCodeForE1.res.status === 200, `got ${loginCodeForE1.res.status} ${loginCodeForE1.res.text.slice(0, 120)}`);
ok('抓到该 login 码', /^\d{6}$/.test(loginCodeForE1.code ?? ''), `got ${loginCodeForE1.code}`);

head('1c-2) ★ 反向锁：分开的是**用途**，不是取消间隔（同一用途连点照样挡）');
const againLogin = await call('/api/auth/send-code', { method: 'POST', body: { email: e1, purpose: 'login' } });
ok('同一邮箱同一用途立刻连发 -> 429 CODE_RATE_LIMITED',
  againLogin.status === 429 && againLogin.json?.code === 'CODE_RATE_LIMITED',
  `${againLogin.status} ${againLogin.text.slice(0, 120)}`);
ok('★ 被拒的请求不记账（429 不占名额）', registerAdmitted === 2, `registerAdmitted=${registerAdmitted}`);

head('1c-3) ★ 用途隔离（两个用途的码在库里是两条记录）');
// ★ 这封 login 码必须发给 **e2**，不能复用 §1c 给 e1 的那封：`consumeCode` 是**按
//   「邮箱 + 用途」查行**的，拿 e1 的码去查 e2 只会得到"查无此码"——那样测到的是
//   **邮箱不匹配**，而不是用途隔离（两条完全不同的防线）。
//   §7b 会**复用同一封码**：那次失败的 register 尝试不会消费它（见该节注释）。
const loginCodeForE2 = await sendLoginCode(e2);
ok('给 e2 发 login 码 -> 200', loginCodeForE2.res.status === 200, `got ${loginCodeForE2.res.status}`);
const nPurpose = userCount();
const crossUse = await call('/api/auth/register', {
  method: 'POST',
  body: { email: e2, code: loginCodeForE2.code, password: PASSWORD },
});
ok('拿 login 码去注册 -> 400 CODE_INVALID', crossUse.status === 400 && crossUse.json?.code === 'CODE_INVALID',
  `${crossUse.status} ${crossUse.text.slice(0, 120)}`);
ok('users 行数不变', userCount() === nPurpose, `${nPurpose} -> ${userCount()}`);

// ---------- 1d) 库层：只存哈希，不存明文码 ----------
head('1d) auth_codes 存储形态');
const allCodes = codeRows();
ok('库里有码行', allCodes.length > 0, `rows=${allCodes.length}`);
ok('★ 库里无明文码（只有 code_hash）', !allCodes.some((r) => r.code_hash === code1));
ok('register 码已核销（consumed_at 非空）',
  allCodes.some((r) => r.purpose === 'register' && r.consumed_at !== null));

// ---------- 2) /me 用注册下发的 cookie（契约一致锁）----------
head('2) GET /api/auth/me （注册 cookie 直查）');
const me = await call('/api/auth/me', { cookie: reg.cookie });
ok('status 200', me.status === 200, `got ${me.status}`);
ok('★ 与 register 响应体逐字段相等（createdAt 同源）',
  JSON.stringify(me.json?.user) === JSON.stringify(reg.json?.user),
  `${JSON.stringify(reg.json?.user)} vs ${JSON.stringify(me.json?.user)}`);

// ---------- 3) 会话表：只存 SHA-256 ----------
head('3) auth_sessions 存储形态');
const token = reg.cookie.split('=')[1];
const rows = sessionRows();
ok('库里有会话行', rows.length > 0);
ok('★ 库里无明文 token（只有 token_hash）', !rows.some((r) => r.token_hash === token));

// ---------- 4) 参数校验失败一律 400 且一行不落库 ----------
head('4) 参数校验（失败不落库、且不占名额）');
const nBeforeBad = userCount();
const admittedBeforeBad = registerAdmitted;
const badEmail = await call('/api/auth/register', { method: 'POST', body: { email: 'not-an-email', password: PASSWORD } });
ok('非法邮箱 -> 400', badEmail.status === 400, `got ${badEmail.status}`);
const weak = await call('/api/auth/register', { method: 'POST', body: { email: email('w'), password: 'short' } });
ok('弱口令(<8) -> 400', weak.status === 400, `got ${weak.status}`);
const long = await call('/api/auth/register', { method: 'POST', body: { email: email('l'), password: 'x'.repeat(101) } });
ok('超长口令(>100) -> 400', long.status === 400, `got ${long.status}`);
const longNick = await call('/api/auth/register', { method: 'POST', body: { email: email('n'), password: PASSWORD, nickname: 'n'.repeat(21) } });
ok('昵称 >20 -> 400', longNick.status === 400, `got ${longNick.status}`);
ok('四条失败后 users 行数不变', userCount() === nBeforeBad, `${nBeforeBad} -> ${userCount()}`);
ok('★ 四条失败都**没占** register 名额（校验在限流之前）', registerAdmitted === admittedBeforeBad, `registerAdmitted=${registerAdmitted}`);

// ---------- 5) ★ 纯校验失败不烧码 ----------
head('5) ★ 纯校验失败不烧码（校验在核销之前）');
const eOrder = email('order');
const orderSend = await sendRegisterCode(eOrder);
const codeOrder = orderSend.status === 200 ? await waitForCode(eOrder, 1) : null;
ok('拿到 register 码', /^\d{6}$/.test(codeOrder ?? ''), `got ${codeOrder}`);
const orderWeak = await call('/api/auth/register', { method: 'POST', body: { email: eOrder, code: codeOrder, password: 'short' } });
ok('弱口令 -> 400 PASSWORD_WEAK', orderWeak.status === 400 && orderWeak.json?.code === 'PASSWORD_WEAK',
  `${orderWeak.status} ${orderWeak.text.slice(0, 120)}`);
const orderOk = await call('/api/auth/register', { method: 'POST', body: { email: eOrder, code: codeOrder, password: PASSWORD } });
ok('★ 同一个码还能建号 -> 200（没被那次失败吃掉）', orderOk.status === 200, `${orderOk.status} ${orderOk.text.slice(0, 120)}`);

// ---------- 6) 登录：两种失败回同一个域码 ----------
head('6) POST /api/auth/login 失败码语义');
const wrongPw = await call('/api/auth/login', { method: 'POST', body: { email: e1, password: 'wrongpass123' } });
ok('密码错 -> 401', wrongPw.status === 401, `got ${wrongPw.status}`);
ok('密码错 code=CREDENTIALS_INVALID', wrongPw.json?.code === 'CREDENTIALS_INVALID', JSON.stringify(wrongPw.json));
const noUser = await call('/api/auth/login', { method: 'POST', body: { email: email('ghost'), password: PASSWORD } });
ok('邮箱不存在 -> 401', noUser.status === 401, `got ${noUser.status}`);
ok('★ 与「密码错」同一个 code（不泄露邮箱是否注册）',
  noUser.json?.code === 'CREDENTIALS_INVALID' && noUser.json?.code === wrongPw.json?.code,
  `${noUser.json?.code} vs ${wrongPw.json?.code}`);

// ---------- 7) 登录成功 + 归一化 + 会话闭环 ----------
head('7) 登录成功、邮箱归一化与会话闭环');
const login = await call('/api/auth/login', { method: 'POST', body: { email: e1.toUpperCase(), password: PASSWORD } });
ok('★ 大写变体邮箱也能登录 -> 200（归一化生效）', login.status === 200, `got ${login.status} ${login.text.slice(0, 120)}`);
ok('下发新 cookie', /sb_sid=/.test(login.rawSetCookie));
const me2 = await call('/api/auth/me', { cookie: login.cookie });
ok('新 cookie 查 /me -> 200', me2.status === 200, `got ${me2.status}`);
ok('登录 body.user 与 /me 相等', JSON.stringify(me2.json?.user) === JSON.stringify(login.json?.user));

// ---------- 7b) 验证码登录：两套登录方式、一种会话 ----------
//
// ★ 复用 §1c-3 那一封给 **e2** 的 login 码：那次 `/register` 是拿它去 register 用途查，
//   查不到 ⇒ **码原封不动**（没被消费），故这里还能用来登录。
head('7b) POST /api/auth/login-by-code');
const byCode = await call('/api/auth/login-by-code', { method: 'POST', body: { email: e2, code: loginCodeForE2.code } });
ok('正确码 -> 200 + Set-Cookie', byCode.status === 200 && /sb_sid=/.test(byCode.rawSetCookie),
  `${byCode.status} ${byCode.text.slice(0, 120)}`);
const meByCode = await call('/api/auth/me', { cookie: byCode.cookie });
ok('★ 该 cookie 直查 /me 与响应体逐字段相等（归属逻辑不必分支的前提）',
  meByCode.status === 200 && JSON.stringify(meByCode.json?.user) === JSON.stringify(byCode.json?.user),
  `${JSON.stringify(byCode.json?.user)} vs ${JSON.stringify(meByCode.json?.user)}`);
const replay = await call('/api/auth/login-by-code', { method: 'POST', body: { email: e2, code: loginCodeForE2.code } });
ok('★ 同一个码用第二次 -> 400（一次性）', replay.status === 400, `got ${replay.status} ${replay.text.slice(0, 120)}`);

// ---------- 8) 跨源写闸门 ----------
head('8) Origin 闸门（跨源写防护）');
const admittedBeforeOrigin = registerAdmitted;
const noOrigin = await call('/api/auth/register', { method: 'POST', body: { email: email('o'), password: PASSWORD }, origin: null });
ok('无 Origin 的 register -> 403', noOrigin.status === 403, `got ${noOrigin.status}`);
const badOrigin = await call('/api/auth/login', { method: 'POST', body: { email: e1, password: PASSWORD }, origin: 'http://evil.example.com' });
ok('非白名单 Origin 的 login -> 403', badOrigin.status === 403, `got ${badOrigin.status}`);
ok('★ 两条 403 都没占 register 名额（闸门在限流之前）', registerAdmitted === admittedBeforeOrigin, `registerAdmitted=${registerAdmitted}`);

// ---------- 9) 登出：撤会话 + 幂等 ----------
head('9) POST /api/auth/logout');
const beforeLogout = authSessionCount();
const out = await call('/api/auth/logout', { method: 'POST', cookie: login.cookie });
ok('登出 -> 200', out.status === 200, `got ${out.status}`);
const afterLogout = await call('/api/auth/me', { cookie: login.cookie });
ok('登出后同一 cookie 查 /me -> 401', afterLogout.status === 401, `got ${afterLogout.status}`);
ok('会话行被撤除', authSessionCount() < beforeLogout, `${beforeLogout} -> ${authSessionCount()}`);
const outAgain = await call('/api/auth/logout', { method: 'POST' });
ok('无 cookie 再登出 -> 200（幂等）', outAgain.status === 200, `got ${outAgain.status}`);

// ---------- 10) 撞库限流 ----------
head(`10) 连续失败 ${MAX_FAILURES} 次后限流`);
const e3 = email('rl');
const reg3 = await registerWithCode(e3);
ok('第三个账号建成功', reg3.reg.status === 200, `got ${reg3.reg.status}`);
const codes = [];
for (let i = 0; i < MAX_FAILURES + 1; i += 1) {
  const r = await call('/api/auth/login', { method: 'POST', body: { email: e3, password: 'wrongpass123' } });
  codes.push(r.status);
}
ok(`前 ${MAX_FAILURES} 次均 401`, codes.slice(0, MAX_FAILURES).every((c) => c === 401), JSON.stringify(codes));
ok(`第 ${MAX_FAILURES + 1} 次 -> 429 TOO_MANY_ATTEMPTS`, codes[MAX_FAILURES] === 429, JSON.stringify(codes));
const locked = await call('/api/auth/login', { method: 'POST', body: { email: e3, password: PASSWORD } });
ok('锁定期间连正确口令也拒（429）', locked.status === 429, `got ${locked.status}`);

// ---------- 11) register 用途的 IP 桶 5/小时（必须放最后）----------
head('11) ★ register 的 IP 桶收紧到 5/小时，且与 login 分桶');
while (registerAdmitted < 5) {
  const r = await sendRegisterCode(email(`cap${registerAdmitted}`));
  ok(`第 ${registerAdmitted} 个名额放行 -> 200`, r.status === 200, `got ${r.status} ${r.text.slice(0, 120)}`);
}
ok('★ 本脚本共用同一出口 IP，已放行 5 次', registerAdmitted === 5, `registerAdmitted=${registerAdmitted}`);
const sixth = await sendRegisterCode(email('cap6'));
ok('★ 第 6 个地址 -> 429 CODE_RATE_LIMITED',
  sixth.status === 429 && sixth.json?.code === 'CODE_RATE_LIMITED',
  `${sixth.status} ${sixth.text.slice(0, 120)}`);
ok('429 带 retryAfterMs（前端能显示"还需等 N 分钟"）',
  typeof sixth.json?.retryAfterMs === 'number' && sixth.json.retryAfterMs > 0,
  JSON.stringify(sixth.json));
// ★ 用 eOrder 而不是 e1：e1 的 `login:邮箱` 键在 §1c/§1c-2 刚用过，还在 60 秒间隔里
const loginStill = await call('/api/auth/send-code', { method: 'POST', body: { email: eOrder, purpose: 'login' } });
ok('★★ register 桶被刷满**不掐死**同一出口 IP 的验证码登录（分桶的全部理由）',
  loginStill.status === 200, `got ${loginStill.status} ${loginStill.text.slice(0, 120)}`);

db.close();
console.log(`\n[smoke] PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
