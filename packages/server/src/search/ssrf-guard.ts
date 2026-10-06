/**
 * search/ssrf-guard — SSRF 防护（port from v1 思路重写）：禁止回环/内网/链路本地地址。
 * 仅允许 http(s)；重定向逐跳复检由 fetchSafe 承担。
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { examUrlAllowed } from '@sb/shared';

function ipIsBlocked(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true; // 回环/内网/本网段
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 内网
    if (a === 192 && b === 168) return true; // 内网
    if (a === 169 && b === 254) return true; // 链路本地（云元数据）
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
  // IPv4-mapped IPv6
  const m = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return ipIsBlocked(m[1] ?? '');
  return false;
}

/**
 * 主机名 → 一个**已通过防护**的 IP：字面 IP 直接判，域名解析后**每个**地址都得过（有一个落内网就整体拦）。
 * 2026-09-30 从 `assertSafeUrl` 抽出并导出：截图保底的守门代理（`sources/shot-proxy.ts`）要拿到解析结果
 * **钉住再连**，否则「检查时解析到公网、连接时解析到内网」（DNS 重绑定）会绕过防护。
 */
export async function resolveSafeAddress(hostname: string): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (ipIsBlocked(host)) throw new Error(`目标地址被 SSRF 防护拦截：${host}`);
    return host;
  }
  const addrs = await lookup(host, { all: true }).catch(() => {
    throw new Error(`域名解析失败：${host}`);
  });
  for (const { address } of addrs) {
    if (ipIsBlocked(address)) throw new Error(`目标解析到内网/回环地址（SSRF 拦截）：${host} → ${address}`);
  }
  const first = addrs[0]?.address;
  if (!first) throw new Error(`域名解析失败：${host}`);
  return first;
}

/** URL 合法性检查（协议/主机/解析 IP 全过才算安全） */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`非法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅允许 http(s)');
  await resolveSafeAddress(url.hostname);
  return url;
}

/** fetch + 重定向逐跳复检（每跳重新过 assertSafeUrl） */
export async function fetchSafe(raw: string, init?: RequestInit, maxRedirects = 4, allowHosts?: readonly string[]): Promise<Response> {
  const checkScope = (url: URL): void => {
    if (allowHosts !== undefined && !examUrlAllowed(url.href, allowHosts)) {
      throw new Error('该地址不在所选应试范围内');
    }
  };
  let current = await assertSafeUrl(raw);
  checkScope(current);
  let resp = await fetch(current, { ...init, redirect: 'manual' });
  let hops = 0;
  while ([301, 302, 303, 307, 308].includes(resp.status) && hops < maxRedirects) {
    const loc = resp.headers.get('location');
    if (!loc) break;
    current = await assertSafeUrl(new URL(loc, current).toString());
    checkScope(current);
    resp = await fetch(current, { ...init, redirect: 'manual' });
    hops += 1;
  }
  return resp;
}
