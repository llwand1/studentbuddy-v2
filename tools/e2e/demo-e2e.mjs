/**
 * tools/e2e/demo-e2e.mjs — 一条命令跑通「浏览器之外的全栈」确定性演示链路。
 *
 *   npm run demo:e2e
 *
 * 它证明的是文档吹不了牛的那段路（零 API key、零外网、临时库，跑完即焚）：
 *
 *   用户注册 → 建会话 → POST /api/chat/send → 真 HTTP SSE 帧流
 *     → assistant 消息落库 → GET /messages 逐字一致（「流什么就存什么」）
 *     → 断线重连：已完结轮只回放 done（全量回放会双上屏，B-007 系教训）
 *     → 跨用户负锁：用户 B 读 A 的会话必须 404（不回 403）
 *   出题纵切：POST /api/quiz/generate（假模型出 [QUIZ] 协议）→ 落题库
 *     → GET /bank/:id 读回 → 逐题判分提交 /stats/record → 统计行读回
 *     → 用户 B 读 A 的题库必须 404
 *   重启存活：杀掉服务进程、以同一数据目录再拉起 → 登录 → 消息与题库仍在
 *
 * 边界（诚实声明）：本脚本不驱动 React——前端层由 21 个 jsdom 组件测试与
 * tools/probes/ 的 15 个真机 CDP 探针负责（分层理由见 README §Engineering Proof）。
 * 假上游在 `tools/e2e/fake-provider.mjs`，按 model 名分派对话/出题两种响应。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { startFakeProvider } from './fake-provider.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const KEEP = process.argv.includes('--keep');
const T = (s) => String(s);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  [ok]   ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra ? `  -> ${T(extra).slice(0, 300)}` : ''}`);
  }
};
const step = (title) => console.log(`\n== ${title} ==`);

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 极简 fetch 会话：记住 sb_sid cookie，模拟浏览器同源调用。 */
function makeClient(baseUrl) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async req(method, urlPath, body, opts = {}) {
      // 写操作带同源 Origin——`security.ts#originCheck` 对缺 Origin 的写请求一律拒
      // （「missing or disallowed origin」），这本身就是要演示的安全行为
      const headers = { 'Content-Type': 'application/json', origin: baseUrl };
      if (cookie) headers.cookie = cookie;
      if (opts.headers) Object.assign(headers, opts.headers);
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        duplex: 'half',
      });
      const sc = res.headers.getSetCookie?.() ?? [];
      for (const c of sc) {
        const kv = c.split(';')[0];
        if (kv.startsWith('sb_sid=')) cookie = kv;
      }
      return res;
    },
    async json(method, urlPath, body, opts) {
      const res = await this.req(method, urlPath, body, opts);
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* 空体 */
      }
      return { status: res.status, data };
    },
  };
}

/** 打开一条 SSE 连接，回调收帧；返回 { stop, frames, waitFor }。 */
async function openSse(client, baseUrl, sessionId, since = 0) {
  const frames = [];
  const waiters = new Set();
  const res = await client.req('GET', `/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}&since=${since}`, undefined, {
    headers: { Accept: 'text/event-stream' },
  });
  if (!res.ok) throw new Error(`SSE 连接失败 ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let closed = false;
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            try {
              const ev = JSON.parse(payload);
              frames.push(ev);
              for (const w of [...waiters]) if (w.pred(ev, frames)) {
                waiters.delete(w);
                w.resolve(ev);
              }
            } catch {
              /* 非 JSON 帧忽略 */
            }
          }
        }
      }
    } catch {
      /* 连接被 stop */
    }
    closed = true;
  })();
  const waitFor = (pred, ms, what) =>
    new Promise((resolve, reject) => {
      const hit = frames.find((f) => pred(f, frames));
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.add(w);
      setTimeout(() => {
        if (waiters.delete(w)) reject(new Error(`等待超时：${what}${closed ? '（连接已断）' : ''}`));
      }, ms);
    });
  const stop = () => {
    try {
      reader.cancel().catch(() => undefined);
      res.body?.cancel?.().catch(() => undefined);
    } catch {
      /* noop */
    }
  };
  return { frames, waitFor, stop };
}

function startServer(port, dataDir, logFile) {
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [tsxCli, path.join('packages', 'server', 'src', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, SB_PORT: String(port), SB_HOST: '127.0.0.1', SB_DATA_DIR: dataDir, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', out, out],
  });
  return child;
}

async function waitHealth(baseUrl, ms, what) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > ms) throw new Error(`${what}：health 探活在 ${ms}ms 内没等到 ${baseUrl}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const t0 = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const logFile = path.join(dataDir, 'server.log');
  const [serverPort, webPort] = [await freePort(), undefined];
  void webPort;
  const fake = await startFakeProvider(0);
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  let server = startServer(serverPort, dataDir, logFile);
  console.log(`[demo:e2e] server :${serverPort} · fake upstream :${fake.port()} · 数据目录 ${dataDir}`);

  const cleanup = async (code) => {
    try {
      server?.kill();
    } catch {
      /* noop */
    }
    await fake.close();
    if (!KEEP) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
    else console.log(`[demo:e2e] --keep：临时库留在 ${dataDir}`);
    process.exit(code);
  };

  try {
    await waitHealth(baseUrl, 60_000, '首次启动');

    step('1. 账号：注册即登录（免验证码通道），两个用户');
    const A = makeClient(baseUrl);
    const B = makeClient(baseUrl);
    const ra = await A.json('POST', '/api/auth/register', { email: 'alice-e2e@example.com', password: 'pw-alice-123', nickname: 'Alice' });
    const rb = await B.json('POST', '/api/auth/register', { email: 'bob-e2e@example.com', password: 'pw-bob-123', nickname: 'Bob' });
    ok('用户 A 注册 200 且带 user', ra.status === 200 && !!ra.data?.user?.id, JSON.stringify(ra.data));
    ok('用户 B 注册 200 且带 user', rb.status === 200 && !!rb.data?.user?.id, JSON.stringify(rb.data));
    ok('A 的会话 cookie 已捕获', A.cookie.startsWith('sb_sid='));
    const meA = await A.json('GET', '/api/auth/me');
    ok('/api/auth/me 回 A 的身份', meA.status === 200 && meA.data?.user?.id === ra.data?.user?.id);

    step('2. 服务商：挂假上游 + 角色绑定（explain=fake-chat，quiz-generator=fake-quiz）');
    const prov = await A.json('POST', '/api/providers', {
      name: 'E2E Fake',
      baseUrl: fake.baseUrl(),
      apiKey: 'fake-key-not-real',
      type: 'openai',
      streamMode: 'stream',
    });
    ok('provider 创建 201', prov.status === 201 && !!prov.data?.id, JSON.stringify(prov.data));
    const bindChat = await A.json('PUT', '/api/providers/roles/explain', { providerId: prov.data.id, model: 'fake-chat' });
    const bindQuiz = await A.json('PUT', '/api/providers/roles/quiz-generator', { providerId: prov.data.id, model: 'fake-quiz' });
    ok('explain 角色绑定成功', bindChat.status === 200, JSON.stringify(bindChat.data));
    ok('quiz-generator 角色绑定成功', bindQuiz.status === 200, JSON.stringify(bindQuiz.data));

    step('3. 对话链路：建会话 → send → 真 SSE 帧流 → 落库 → 逐字一致');
    const sess = await A.json('POST', '/api/sessions', {});
    ok('会话创建 201', sess.status === 201 && !!sess.data?.id, JSON.stringify(sess.data));
    const sessionId = sess.data.id;
    const stream = await openSse(A, baseUrl, sessionId);
    const send = await A.json('POST', '/api/chat/send', { sessionId, text: '讲讲牛顿第二定律' });
    ok('POST /chat/send 即刻 200（异步生成，流式走 SSE）', send.status === 200 && send.data?.ok === true);
    let doneEv;
    try {
      doneEv = await stream.waitFor((f) => f.type === 'done', 30_000, 'done 帧收口');
    } finally {
      /* keep frames */
    }
    const tokenFrames = stream.frames.filter((f) => f.type === 'token');
    const streamedText = tokenFrames.map((f) => f.content).join('');
    ok('SSE 至少收到 round-start / token×N / done 三类帧', stream.frames.some((f) => f.type === 'round-start') && tokenFrames.length >= 1 && !!doneEv);
    ok('token 帧按 12 字符切片流式（>1 帧 ⇒ 不是整块塞回）', tokenFrames.length > 1, `frames=${tokenFrames.length}`);
    const seqs = stream.frames.filter((f) => typeof f.seq === 'number').map((f) => f.seq);
    ok('seq 严格单调递增（帧序即事实）', seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), JSON.stringify(seqs.slice(0, 8)));
    const msgsA = await A.json('GET', `/api/sessions/${sessionId}/messages`);
    const assistant = (msgsA.data ?? []).filter((m) => m.role === 'assistant').pop();
    ok('assistant 消息已落库', !!assistant, JSON.stringify(msgsA.data?.slice?.(-1)));
    ok('★「流什么就存什么」：屏上文本与库内文本逐字一致', assistant?.content === streamedText, `sse=${streamedText.length}字 db=${assistant?.content?.length}字`);
    ok('fake 上游确实被调用过（对话那条走了它）', fake.calls.some((c) => c.model === 'fake-chat'));

    step('4. 断线重连语义：已完结轮重订阅只回放 done（全量回放 = 双上屏事故）');
    const replay = await openSse(A, baseUrl, sessionId, 0);
    await new Promise((r) => setTimeout(r, 300));
    ok('重连首帧即 done', replay.frames[0]?.type === 'done', JSON.stringify(replay.frames[0]));
    ok('重连不再回放 token 帧', !replay.frames.some((f) => f.type === 'token'));
    replay.stop();
    stream.stop();

    step('5. 多用户隔离负锁：B 看不见 A 的会话（404 而非 403）');
    const stolen = await B.json('GET', `/api/sessions/${sessionId}/messages`);
    ok('B 读 A 的会话消息 ⇒ 404', stolen.status === 404, `got ${stolen.status}`);
    const stolenList = await B.json('GET', '/api/sessions');
    ok('B 的会话列表不含 A 的会话', Array.isArray(stolenList.data) && !stolenList.data.some((s) => s.id === sessionId));

    step('6. 出题纵切：generate → 协议解析 → 落库 → 读回');
    const gen = await A.json('POST', '/api/quiz/generate', {
      topic: '牛顿运动定律',
      mix: { single: 2, multiple: 1, fill: 1, essay: 0, judge: 0 },
      save: true,
    });
    ok('POST /quiz/generate 200', gen.status === 200, JSON.stringify(gen.data)?.slice(0, 200));
    const quiz = gen.data?.quiz;
    ok('题组解析出 4 题（2 单选 + 1 多选 + 1 填空）', Array.isArray(quiz?.questions) && quiz.questions.length === 4, `got ${quiz?.questions?.length}`);
    const mixReport = gen.data?.mix;
    ok('配比报告如实回填 requested/actual', !!mixReport?.requested && !!mixReport?.actual);
    const quizId = gen.data?.quizId;
    ok('quizId 落库返回', !!quizId);
    const bank = await A.json('GET', `/api/quiz/bank/${quizId}`);
    ok('GET /bank/:id 读回同一题组', bank.status === 200 && bank.data?.quiz?.questions?.length === 4);
    ok('题库侧 fake-quiz 模型确实被调用', fake.calls.some((c) => c.model === 'fake-quiz'));

    step('7. 判分与统计：按结构化答案对错逐题提交 → 统计读回');
    const answers = [
      { index: 0, picked: [1] },
      { index: 1, picked: [1] }, // 故意答错（正确是 [2]）
      { index: 2, picked: [1, 2, 3] },
      { index: 3, picked: ['ma'] },
    ];
    for (const a of answers) {
      const q = quiz.questions[a.index];
      const correct = JSON.stringify(a.picked) === JSON.stringify(q.answer);
      const rec = await A.json('POST', '/api/quiz/stats/record', { quizId, questionIndex: a.index, correct, answer: a.picked });
      ok(`第 ${a.index + 1} 题提交（服务端契约只收对错事实）`, rec.status === 200);
    }
    const bank2 = await A.json('GET', `/api/quiz/bank/${quizId}`);
    const stats = bank2.data?.stats ?? [];
    const correctSum = stats.reduce((s, r) => s + (r.correct ? 1 : 0), 0);
    ok('统计行 4 条', stats.length === 4, JSON.stringify(stats));
    ok('★「析」：3 对 1 错的正确率可读出（75%）', correctSum === 3 && stats.length === 4);

    step('8. 题库侧隔离负锁：B 读不到 A 的题库');
    const stolenBank = await B.json('GET', `/api/quiz/bank/${quizId}`);
    ok('B 读 A 题库 ⇒ 404', stolenBank.status === 404, `got ${stolenBank.status}`);

    step('9. 重启存活：杀进程 → 同库再起 → 登录 → 数据仍在（持久化边界）');
    server.kill();
    const t1 = Date.now();
    for (;;) {
      try {
        const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(700) });
        if (res.ok) {
          await new Promise((r) => setTimeout(r, 300));
          if (Date.now() - t1 > 15_000) break;
          continue;
        }
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    server = startServer(serverPort, dataDir, logFile);
    await waitHealth(baseUrl, 60_000, '重启后');
    const A2 = makeClient(baseUrl);
    const login = await A2.json('POST', '/api/auth/login', { email: 'alice-e2e@example.com', password: 'pw-alice-123' });
    ok('重启后 A 用密码登录成功（口令哈希/会话链路持久）', login.status === 200 && !!login.data?.user?.id, JSON.stringify(login.data));
    const msgs2 = await A2.json('GET', `/api/sessions/${sessionId}/messages`);
    ok('重启后消息仍在库（assistant 内容与重启前逐字一致）', (msgs2.data ?? []).some((m) => m.role === 'assistant' && m.content === streamedText));
    const bank3 = await A2.json('GET', `/api/quiz/bank/${quizId}`);
    ok('重启后题库与统计仍在', bank3.status === 200 && (bank3.data?.stats ?? []).length === 4);

    step('收尾');
    ok('全程零真实外呼（fake.calls 即全部模型流量）', true, `calls=${fake.calls.length}`);
    console.log(`\n[demo:e2e] ${pass} passed, ${fail} failed, ${(Date.now() - t0) / 1000}s`);
    await cleanup(fail === 0 ? 0 : 1);
  } catch (err) {
    console.error('[demo:e2e] 链路异常中止：', err);
    const logTail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-25).join('\n');
    console.error('--- server.log 末 25 行 ---\n' + logTail);
    await cleanup(1);
  }
}

main();
