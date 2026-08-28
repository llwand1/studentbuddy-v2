/**
 * search/ssrf-guard — SSRF 防护（port from v1 思路重写）：禁止回环/内网/链路本地地址。
 * 仅允许 http(s)；重定向逐跳复检由 fetchSafe 承担。
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

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

/** URL 合法性检查（协议/主机/解析 IP 全过才算安全） */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`非法 URL：${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅允许 http(s)');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (ipIsBlocked(host)) throw new Error(`目标地址被 SSRF 防护拦截：${host}`);
    return url;
  }
  const addrs = await lookup(host, { all: true }).catch(() => {
    throw new Error(`域名解析失败：${host}`);
  });
  for (const { address } of addrs) {
    if (ipIsBlocked(address)) throw new Error(`目标解析到内网/回环地址（SSRF 拦截）：${host} → ${address}`);
  }
  return url;
}

/** fetch + 重定向逐跳复检（每跳重新过 assertSafeUrl） */
export async function fetchSafe(raw: string, init?: RequestInit, maxRedirects = 4): Promise<Response> {
  let current = await assertSafeUrl(raw);
  let resp = await fetch(current, { ...init, redirect: 'manual' });
  let hops = 0;
  while ([301, 302, 303, 307, 308].includes(resp.status) && hops < maxRedirects) {
    const loc = resp.headers.get('location');
    if (!loc) break;
    current = await assertSafeUrl(new URL(loc, current).toString());
    resp = await fetch(current, { ...init, redirect: 'manual' });
    hops += 1;
  }
  return resp;
}
