/**
 * sources/shot-proxy —— 截图保底用的**守门代理**（契约 docs/SOURCE-TRACE-SPEC.md §13.2）。
 *
 * 为什么要有它：截图靠系统里的 Chromium 去真的打开网页，而浏览器不走我们的 `fetchSafe`——
 * 它会自己解析域名、自己跟重定向、自己拉子资源。主网址在起浏览器前过一次 `assertSafeUrl` 只挡得住第一跳；
 * 页面里一个 `<img src="http://169.254.169.254/…">` 或一次 302 到 `http://10.0.0.1/` 就把服务器内网截成图交给用户了。
 * 所以每次截图起一个只听 127.0.0.1 的 HTTP 代理，浏览器带 `--proxy-server` + `--proxy-bypass-list=<-loopback>`
 * 把**所有**出站流量（含回环）都交给它，代理对每一个目标主机做与 `fetchSafe` 相同的解析 + 内网判定，
 * 过了才按**解析出的 IP** 连（钉住，不给 DNS 重绑定第二次机会）。
 *
 * 两条通道：`CONNECT host:port`（https，隧道透传，不解密）与绝对地址的普通请求（http，转发）。
 * 代理随截图起、随截图关，不常驻、不复用，零共享状态。
 *
 * 2026-09-30 首版。
 */
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { resolveSafeAddress } from '../search/ssrf-guard.js';

/** 主机名 → 通过防护的 IP；不通过就抛（测试里可换成放行本机的解析器） */
export type SafeResolve = (hostname: string) => Promise<string>;

export interface GuardProxy {
  port: number;
  /** 被拦下的目标（主机名），按发生顺序；截图失败时给日志与测试看 */
  blocked: string[];
  close(): Promise<void>;
}

const SOCKET_IDLE_MS = 30_000;

/** `host:port` / `[v6]:port` → 主机与端口；解析不了 ⇒ null */
export function splitHostPort(target: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(target.trim());
  if (!m) return null;
  const host = (m[1] ?? '').replace(/^\[|\]$/g, '');
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export function startGuardProxy(resolve: SafeResolve = resolveSafeAddress): Promise<GuardProxy> {
  const blocked: string[] = [];

  const server = http.createServer((req, res) => {
    // 普通请求：代理协议要求请求行是绝对地址（`GET http://host/path`）；相对地址不是代理请求，拒掉
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('bad proxy request');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end('only http through this channel');
      return;
    }
    void resolve(target.hostname).then(
      (ip) => {
        const headers = { ...req.headers, host: target.host };
        const up = http.request(
          { host: ip, port: target.port ? Number(target.port) : 80, path: `${target.pathname}${target.search}`, method: req.method, headers, setHost: false },
          (upRes) => {
            res.writeHead(upRes.statusCode ?? 502, upRes.headers);
            upRes.pipe(res);
          },
        );
        up.setTimeout(SOCKET_IDLE_MS, () => up.destroy(new Error('upstream idle')));
        up.on('error', () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(up);
      },
      () => {
        blocked.push(target.hostname);
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('blocked');
      },
    );
  });

  server.on('connect', (req, socket: Duplex, head: Buffer) => {
    const hp = splitHostPort(req.url ?? '', 443);
    if (!hp) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    void resolve(hp.host).then(
      (ip) => {
        const tunnel = net.connect(hp.port, ip, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) tunnel.write(head);
          tunnel.pipe(socket);
          socket.pipe(tunnel);
        });
        tunnel.setTimeout(SOCKET_IDLE_MS, () => tunnel.destroy());
        tunnel.on('error', () => socket.destroy());
        socket.on('error', () => tunnel.destroy());
        socket.on('close', () => tunnel.destroy());
      },
      () => {
        blocked.push(hp.host);
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      },
    );
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      ok({
        port,
        blocked,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
