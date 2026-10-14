/** Minimal bounded Streamable HTTP client. New session per operation, never shared between owners. */
import https from 'node:https';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { objectValue, type PluginManifest, type PluginTool } from '@sb/shared';
import { resolveSafeAddress } from '../search/ssrf-guard.js';
import { readMcpResponse } from './mcp-response.js';
import { mcpTextContent } from './mcp-content.js';
const VERSIONS = ['2025-06-18', '2025-03-26', '2025-11-25'];
export function redactPluginText(text: string, token: string): string {
  return (token ? text.split(token).join('[已隐藏密钥]') : text).replace(/(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/gu, '[已隐藏密钥]');
}
export async function pluginAddress(endpoint: string): Promise<string> {
  const u = new URL(endpoint);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || net.isIP(u.hostname) ||
      !u.hostname.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/iu.test(u.hostname)) throw new Error('插件端点必须是公网 HTTPS 域名');
  const ip = await resolveSafeAddress(u.hostname);
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split('.').map(Number);
    if (a! >= 224 || (a === 100 && b! >= 64 && b! <= 127) || (a === 198 && (b === 18 || b === 19))) throw new Error('插件端点解析到非公网地址');
  } else if (!/^[23][0-9a-f]{3}:/iu.test(ip)) throw new Error('插件端点解析到非公网 IPv6 地址');
  return ip;
}
export class McpHttpClient {
  private address = '';
  private session = '';
  private version = VERSIONS[0]!;
  private initialized = false;
  constructor(private manifest: PluginManifest, private token: string, private signal: AbortSignal) {}
  private async post(method: string, params: Record<string, unknown>, notification = false): Promise<Record<string, unknown>> {
    this.signal.throwIfAborted();
    const id = notification ? null : randomUUID(), url = new URL(this.manifest.endpoint);
    const ip = await new Promise<string>((resolve,reject) => {
      const abort = () => reject(new Error('插件域名解析已停止或超时'));
      this.signal.addEventListener('abort',abort,{once:true});
      void pluginAddress(url.href).then(resolve,reject).finally(()=>this.signal.removeEventListener('abort',abort));
      if (this.signal.aborted) abort();
    });
    this.address = ip;
    this.signal.throwIfAborted();
    const body = JSON.stringify({ jsonrpc: '2.0', ...(id ? {id} : {}), method, params });
    const headers: Record<string, string> = { 'Content-Type':'application/json', Accept:'application/json, text/event-stream' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.initialized) headers['MCP-Protocol-Version'] = this.version;
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    if (this.manifest.id === 'github') {
      headers['X-MCP-Readonly'] = 'true';
      headers['X-MCP-Toolsets'] = 'repos,issues,pull_requests,actions';
      headers['X-MCP-Tools'] = this.manifest.tools.join(',');
    }
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method:'POST', headers, signal:this.signal, family:net.isIP(ip),
        lookup: (_host, _options, cb) => cb(null, ip, net.isIP(ip)) }, res => {
        const session = res.headers['mcp-session-id'];
        if (method === 'initialize' && typeof session === 'string') {
          if (!/^[\x21-\x7e]{1,4096}$/u.test(session)) { res.destroy(); reject(new Error('MCP 会话标识无效')); return; }
          this.session = session;
        }
        void readMcpResponse(res, id).then(resolve, reject);
      });
      req.on('error', () => reject(new Error(this.signal.aborted ? '插件请求已停止或超时' : '插件网络连接失败')));
      req.end(body);
    });
  }
  async initialize(): Promise<void> {
    const init = await this.post('initialize', { protocolVersion: this.version, capabilities:{},
      clientInfo:{name:'StudentBuddy',version:'1.0.0'} });
    if (typeof init.protocolVersion !== 'string' || !VERSIONS.includes(init.protocolVersion)) throw new Error('MCP 协议版本不兼容');
    this.version = init.protocolVersion; this.initialized = true;
    await this.post('notifications/initialized', {}, true);
  }
  async tools(): Promise<PluginTool[]> {
    const found = new Map<string, PluginTool>(); let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const result = await this.post('tools/list', cursor ? {cursor} : {});
      if (!Array.isArray(result.tools) || result.tools.length > 200) throw new Error('MCP 工具列表无效或过大');
      for (const item of result.tools) {
        const x = objectValue(item);
        if (typeof x.name !== 'string' || !this.manifest.tools.includes(x.name)) continue;
        const schema = objectValue(x.inputSchema);
        if (schema.type !== 'object' || JSON.stringify(schema).length > 12000) throw new Error('MCP 参数定义无效或过大');
        found.set(x.name, {name:x.name, description:typeof x.description === 'string' ? x.description.slice(0,700) : '', inputSchema:schema});
      }
      if (result.nextCursor === undefined || result.nextCursor === '') return [...found.values()];
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 1000 || cursors.has(result.nextCursor)) throw new Error('MCP 分页游标无效');
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw new Error('MCP 工具列表超过分页上限');
  }
  async call(name: string, args: Record<string, unknown>): Promise<{text: string; ignoredBlocks: number}> {
    const result = await this.post('tools/call', {name,arguments:args});
    if (result.isError === true) throw new Error('远端工具未执行成功，请检查参数、仓库或 Token 权限');
    const { chunks, ignoredBlocks } = mcpTextContent(result);
    if (!chunks.length && result.structuredContent) chunks.push(JSON.stringify(result.structuredContent));
    let text = redactPluginText(chunks.join('\n') || '工具已返回，但没有可用文本内容。', this.token);
    if (text.length > 14000) text = text.slice(0,13950) + '\n[结果超过 14k 字，已截断；请缩小查询范围]';
    if (ignoredBlocks) text += `\n[已忽略 ${ignoredBlocks} 个非文本块，不访问资源外链]`;
    return {text,ignoredBlocks};
  }
  async close(): Promise<void> {
    if (!this.session || !this.address) return;
    try {
      const url = new URL(this.manifest.endpoint), ip = this.address;
      await new Promise<void>((resolve) => {
        const req = https.request(url, {method:'DELETE', signal:AbortSignal.timeout(2000), family:net.isIP(ip),
          headers:{'Mcp-Session-Id':this.session,'MCP-Protocol-Version':this.version,
            ...(this.token ? {Authorization:`Bearer ${this.token}`} : {})},
          lookup:(_h,_o,cb)=>cb(null,ip,net.isIP(ip))}, res=>{res.destroy();resolve();});
        req.on('error',()=>resolve());req.end();
      });
    } catch { /* Cleanup cannot turn a completed read into failure. */ }
  }
}

