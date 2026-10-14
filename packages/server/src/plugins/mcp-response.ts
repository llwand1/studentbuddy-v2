import type { IncomingMessage } from 'node:http';
import { objectValue } from '@sb/shared';
const MAX_BYTES = 1024 * 1024;
function responseValue(raw: string, id: string): Record<string, unknown> | null {
  const v = objectValue(JSON.parse(raw) as unknown);
  if (v.jsonrpc !== '2.0') throw new Error('MCP 响应不是 JSON-RPC 2.0');
  // Never execute server-initiated requests, sampling or elicitation.
  if (v.id !== id || v.method !== undefined) return null;
  if (v.error) throw new Error('MCP 工具返回协议错误，请检查参数、权限或服务状态');
  return objectValue(v.result);
}
export function readMcpResponse(res: IncomingMessage, id: string | null): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const fail = (message: string) => { reject(new Error(message)); res.destroy(); };
    if (res.statusCode === 401) { fail('授权失效或 Token 无权限，请重新配置插件 Token'); return; }
    if (res.statusCode === 403) { fail('插件访问被拒绝，请检查仓库权限或组织授权'); return; }
    if (res.statusCode === 429) { fail('插件服务限流，请稍后手动重试'); return; }
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { fail(`插件 HTTP ${res.statusCode ?? 0}（不跟随重定向）`); return; }
    if (id === null) { res.resume(); resolve({}); return; }
    const type = res.headers['content-type'] ?? '';
    const sse = type.includes('text/event-stream');
    if (!sse && !type.includes('application/json')) { fail('MCP 响应类型不支持'); return; }
    let bytes = 0, pending = '', complete = false;
    res.setEncoding('utf8');
    const accept = (raw: string): boolean => {
      const value = responseValue(raw, id);
      if (!value) return false;
      complete = true; resolve(value); res.destroy(); return true;
    };
    res.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BYTES) { fail('MCP 报文超过 1 MiB，已停止读取'); return; }
      pending += chunk;
      if (!sse) return;
      pending = pending.replace(/\r\n/gu, '\n');
      let pos: number;
      while ((pos = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, pos); pending = pending.slice(pos + 2);
        const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try { if (accept(data)) return; } catch { fail('MCP SSE 响应无效或返回协议错误'); return; }
      }
    });
    res.on('end', () => {
      if (complete) return;
      try {
        if (sse || !accept(pending)) fail('MCP 未返回匹配本次请求的结果');
      } catch { fail('MCP JSON 响应无效或返回协议错误'); }
    });
    res.on('error', () => { if (!complete) reject(new Error('MCP 响应连接中断')); });
    res.on('aborted', () => { if (!complete) reject(new Error('MCP 响应读取中断')); });
  });
}

