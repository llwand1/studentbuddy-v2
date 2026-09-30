#!/usr/bin/env node
/**
 * tools/loadtest/sse-load.mjs — 单进程 SSE 容量探针（契约 docs/SCALING.md §3）。
 *
 * 回答一个具体问题：**一个 Node 进程同时给多少个用户流式出字，才开始变差？**
 * 「变差」看三个数：首帧延迟 p95、整轮时长 p95（相对上游节奏的膨胀）、常驻内存。
 *
 * 做法（零真实网络、零 API key）：
 *   1. 起 `tools/e2e/fake-provider.mjs`，按 `--token-delay-ms` 逐帧出字（模拟真上游节奏）；
 *   2. 起一份隔离的 server（临时库、`SB_TRUST_PROXY=1`）；
 *   3. 注册 N 个用户（各带不同 `X-Forwarded-For`，绕开 5/小时/IP 的注册限流——这是压测夹具，不是线上行为），
 *      各自 BYOK 挂假上游（BYOK 不受「全站封顶 8」的外层闸门约束，量的才是 Node 本身，不是配额策略）；
 *   4. 每人建会话、挂 SSE，**同时**发一条消息，收齐 `done`；
 *   5. 另开 `--idle` 条纯挂着的 SSE，量「一条空闲连接值多少内存」；
 *   6. 全程轮询 `/api/health` 取 `sse.clients` 与 `rssMb`。
 *
 * 用法：node tools/loadtest/sse-load.mjs [--users 50] [--idle 200] [--token-delay-ms 40] [--reply-chars 1200] [--json]
 *   退出码 0 = 全部轮次收到 done；1 = 有轮次失败 / 超时。
 * ⚠️ 结果只对「跑它的那台机器」有效——SCALING.md 里的数字标了机器与日期，换机器请重跑。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startFakeProvider } from '../e2e/fake-provider.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const USERS = Number(arg('users', 50));
const IDLE = Number(arg('idle', 0));
const TOKEN_DELAY = Number(arg('token-delay-ms', 40));
const REPLY_CHARS = Number(arg('reply-chars', 1200));
const JSON_OUT = process.argv.includes('--json');
const ROUND_TIMEOUT_MS = Number(arg('timeout-ms', 120_000));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

function startServer(port, dataDir, logFile) {
  const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const out = fs.openSync(logFile, 'a');
  return spawn(process.execPath, [tsxCli, path.join('packages', 'server', 'src', 'index.ts')], {
    cwd: ROOT,
    env: { ...process.env, SB_PORT: String(port), SB_HOST: '127.0.0.1', SB_DATA_DIR: dataDir, SB_TRUST_PROXY: '1', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', out, out],
  });
}

async function waitHealth(baseUrl, ms) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > ms) throw new Error(`health 探活 ${ms}ms 内没等到 ${baseUrl}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 一个模拟浏览器：记 cookie、写请求带同源 Origin、带独立的 X-Forwarded-For。 */
function makeClient(baseUrl, ip) {
  let cookie = '';
  return {
    async json(method, urlPath, body) {
      const headers = { 'Content-Type': 'application/json', origin: baseUrl, 'x-forwarded-for': ip };
      if (cookie) headers.cookie = cookie;
      const res = await fetch(`${baseUrl}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const kv = c.split(';')[0];
        if (kv.startsWith('sb_sid=')) cookie = kv;
      }
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* 非 JSON */
      }
      return { status: res.status, data };
    },
    headers() {
      return { cookie, 'x-forwarded-for': ip };
    },
  };
}

/** 挂一条 SSE：解析 `data:` 帧，回调每一帧；返回 { firstPingAt, stop }。 */
async function openSse(baseUrl, headers, sessionId, onFrame) {
  const ac = new AbortController();
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/api/chat/stream?sessionId=${encodeURIComponent(sessionId)}`, { headers, signal: ac.signal });
  if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
  const state = { firstPingMs: null, connectMs: performance.now() - t0 };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (ev.type === 'ping' && state.firstPingMs === null) state.firstPingMs = performance.now() - t0;
          onFrame?.(ev, performance.now());
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { state, stop: () => ac.abort() };
}

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-load-'));
  const fake = await startFakeProvider(0, { tokenDelayMs: TOKEN_DELAY, replyChars: REPLY_CHARS });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port, dataDir, path.join(dataDir, 'server.log'));
  const health = [];
  let healthTimer = null;
  const cleanup = async () => {
    if (healthTimer) clearInterval(healthTimer);
    try {
      server.kill();
    } catch {
      /* noop */
    }
    await fake.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  };
  const log = (s) => !JSON_OUT && console.log(s);
  try {
    await waitHealth(baseUrl, 60_000);
    const pollHealth = async () => {
      try {
        const h = await (await fetch(`${baseUrl}/api/health`)).json();
        health.push({ t: Date.now(), clients: h.sse?.clients ?? 0, rssMb: h.rssMb ?? 0 });
      } catch {
        /* 忙时漏一拍无所谓 */
      }
    };
    await pollHealth();
    const rssIdleMb = health[0]?.rssMb ?? 0;
    healthTimer = setInterval(pollHealth, 500);

    log(`[sse-load] server :${port} · fake upstream 每帧 ${TOKEN_DELAY}ms · 回复 ≥${REPLY_CHARS} 字 · users=${USERS} idle=${IDLE}`);
    // ── 1. 建 N 个用户（分批，避免把「建账号」的开销混进「出字」的测量）──
    const users = [];
    const tSetup = performance.now();
    for (let start = 0; start < USERS; start += 20) {
      const batch = [];
      for (let i = start; i < Math.min(USERS, start + 20); i++) {
        batch.push(
          (async () => {
            const c = makeClient(baseUrl, `10.${(i >> 8) & 255}.${i & 255}.${(i % 250) + 1}`);
            const r = await c.json('POST', '/api/auth/register', { email: `load-${i}@example.com`, password: 'pw-load-12345', nickname: `L${i}` });
            if (r.status !== 200 && r.status !== 201) throw new Error(`register #${i} → ${r.status} ${JSON.stringify(r.data)}`);
            const prov = await c.json('POST', '/api/providers', { name: 'load fake', baseUrl: fake.baseUrl(), apiKey: 'fake-key', type: 'openai', streamMode: 'stream' });
            if (prov.status !== 201) throw new Error(`provider #${i} → ${prov.status} ${JSON.stringify(prov.data)}`);
            const bind = await c.json('PUT', '/api/providers/roles/explain', { providerId: prov.data.id, model: 'fake-chat' });
            if (bind.status !== 200) throw new Error(`bind #${i} → ${bind.status}`);
            const sess = await c.json('POST', '/api/sessions', {});
            if (sess.status !== 201) throw new Error(`session #${i} → ${sess.status}`);
            return { i, c, sessionId: sess.data.id };
          })(),
        );
      }
      users.push(...(await Promise.all(batch)));
    }
    const setupMs = Math.round(performance.now() - tSetup);
    log(`[sse-load] ${USERS} 个用户就绪（注册+挂上游+建会话）用时 ${setupMs}ms`);

    // ── 2. 空闲连接（可选）：只挂不发，量每条连接的内存 ──
    const idles = [];
    if (IDLE > 0) {
      const u0 = users[0];
      for (let k = 0; k < IDLE; k++) idles.push(await openSse(baseUrl, u0.c.headers(), u0.sessionId));
      await new Promise((r) => setTimeout(r, 1500));
      await pollHealth();
    }
    const rssWithIdleMb = health.at(-1)?.rssMb ?? 0;
    const clientsSeenWithIdle = health.at(-1)?.clients ?? 0;

    // ── 3. 每人挂 SSE，同时发一条消息，收齐 done ──
    const rounds = users.map(() => ({ sentAt: 0, firstTokenMs: null, doneMs: null, tokens: 0, error: null }));
    const streams = [];
    for (const u of users) {
      const r = rounds[u.i];
      streams.push(
        await openSse(baseUrl, u.c.headers(), u.sessionId, (ev, now) => {
          if (ev.type === 'token') {
            r.tokens++;
            if (r.firstTokenMs === null) r.firstTokenMs = now - r.sentAt;
          } else if (ev.type === 'done') r.doneMs = now - r.sentAt;
          else if (ev.type === 'error') r.error = ev.message ?? 'error';
        }),
      );
    }
    const firstPing = streams.map((s) => s.state.firstPingMs).filter((x) => x !== null);
    const tFire = performance.now();
    await Promise.all(
      users.map(async (u) => {
        rounds[u.i].sentAt = performance.now();
        const r = await u.c.json('POST', '/api/chat/send', { sessionId: u.sessionId, text: `压测 #${u.i}：讲讲牛顿第二定律` });
        if (r.status !== 200) rounds[u.i].error = `send ${r.status} ${JSON.stringify(r.data)}`;
      }),
    );
    const t0 = Date.now();
    while (rounds.some((r) => r.doneMs === null && !r.error) && Date.now() - t0 < ROUND_TIMEOUT_MS) await new Promise((r) => setTimeout(r, 100));
    const wallMs = Math.round(performance.now() - tFire);
    await pollHealth();
    for (const s of [...streams, ...idles]) s.stop();

    const ok = rounds.filter((r) => r.doneMs !== null && !r.error);
    const failed = rounds.length - ok.length;
    const expectedFrames = Math.ceil(REPLY_CHARS / 12);
    const upstreamRoundMs = expectedFrames * TOKEN_DELAY; // 上游自己的节奏：一轮理论时长
    const result = {
      machine: `${os.cpus()[0]?.model ?? 'cpu'} ×${os.cpus().length} · node ${process.version} · ${os.platform()}`,
      config: { users: USERS, idle: IDLE, tokenDelayMs: TOKEN_DELAY, replyChars: REPLY_CHARS },
      setupMs,
      sse: { connectP50: pct(streams.map((s) => s.state.connectMs), 50), connectP95: pct(streams.map((s) => s.state.connectMs), 95), firstPingP95: pct(firstPing, 95) },
      rounds: {
        total: rounds.length,
        ok: ok.length,
        failed,
        firstTokenP50: pct(ok.map((r) => r.firstTokenMs), 50),
        firstTokenP95: pct(ok.map((r) => r.firstTokenMs), 95),
        doneP50: pct(ok.map((r) => r.doneMs), 50),
        doneP95: pct(ok.map((r) => r.doneMs), 95),
        upstreamRoundMs,
        inflationP95: ok.length ? Math.round((pct(ok.map((r) => r.doneMs), 95) / upstreamRoundMs) * 100) / 100 : null,
        wallMs,
        tokensPerSec: Math.round((ok.reduce((s, r) => s + r.tokens, 0) / (wallMs / 1000)) * 10) / 10,
      },
      memory: {
        rssIdleMb,
        rssWithIdleMb,
        perIdleConnKb: IDLE > 0 ? Math.round(((rssWithIdleMb - rssIdleMb) * 1024) / IDLE) : null,
        rssPeakMb: Math.max(...health.map((h) => h.rssMb)),
        clientsPeak: Math.max(...health.map((h) => h.clients)),
        clientsSeenWithIdle,
      },
      errors: rounds.filter((r) => r.error).slice(0, 5).map((r) => r.error),
    };
    if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('');
      console.log(`| 项 | 值 |`);
      console.log(`|---|---|`);
      console.log(`| 机器 | ${result.machine} |`);
      console.log(`| 并发用户 / 空闲连接 | ${USERS} / ${IDLE} |`);
      console.log(`| 上游节奏 | 每帧 ${TOKEN_DELAY}ms，≈${expectedFrames} 帧/轮 ⇒ 理论一轮 ${upstreamRoundMs}ms |`);
      console.log(`| SSE 建连 p50 / p95 | ${result.sse.connectP50} / ${result.sse.connectP95} ms |`);
      console.log(`| 首 token 延迟 p50 / p95 | ${result.rounds.firstTokenP50} / ${result.rounds.firstTokenP95} ms |`);
      console.log(`| 整轮时长 p50 / p95 | ${result.rounds.doneP50} / ${result.rounds.doneP95} ms（p95 是上游节奏的 ${result.rounds.inflationP95}×） |`);
      console.log(`| 全部 ${USERS} 轮墙钟 / 聚合出字 | ${wallMs} ms / ${result.rounds.tokensPerSec} 帧/s |`);
      console.log(`| 成功 / 失败 | ${ok.length} / ${failed} |`);
      console.log(`| RSS 空载 → 峰值 | ${rssIdleMb} → ${result.memory.rssPeakMb} MB |`);
      if (IDLE > 0) console.log(`| 每条空闲 SSE 连接 | ≈${result.memory.perIdleConnKb} KB（health 看到 ${clientsSeenWithIdle} 条） |`);
      console.log(`| health 峰值连接数 | ${result.memory.clientsPeak} |`);
      if (result.errors.length) console.log(`\n错误样本：${result.errors.join(' · ')}`);
    }
    await cleanup();
    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error(`[sse-load] ✗ ${e instanceof Error ? e.message : String(e)}`);
    try {
      console.error(fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8').split('\n').slice(-15).join('\n'));
    } catch {
      /* noop */
    }
    await cleanup();
    process.exit(1);
  }
}

main();
