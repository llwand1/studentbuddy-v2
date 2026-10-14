/** Only the pinned official GitHub binary is executable; no user command/args. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { objectValue, type PluginTool } from '@sb/shared';
import { GITHUB_PLUGIN } from './catalog.js';
import { redactPluginText } from './mcp-http.js';
import { mcpTextContent } from './mcp-content.js';
import { githubBrowserEnvironment } from '../desktop/browser-launch.js';
export const GITHUB_STDIO_TOOLS = [...GITHUB_PLUGIN.tools, 'get_me', 'search_repositories'];
export function githubProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Never inherit a PAT, custom OAuth client, app key, host, or log-file override.
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^GITHUB_|^GH_|^MCP_/i.test(k)));
}
type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; clean: () => void };
export class GithubStdio {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private buffer = '';
  private stopped = false;
  constructor(owner: string | null = null) {
    if (process.platform !== 'win32' || process.env.SB_DESKTOP !== '1') throw new Error('浏览器连接仅支持 Windows 安装版');
    const root = resolve(process.env.SB_WEB_DIST ?? 'web', '..', 'integrations', 'github');
    const executable = resolve(root, 'github-mcp-server.exe');
    const expected = '1bbf1cd5be216d5c622ccb0da4529d747c983fcf6bbf76f9c3e6c3b32877c1df';
    if (!/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(readFileSync(executable)).digest('hex') !== expected) throw new Error('GitHub 连接组件校验失败，请重新安装');
    this.child = spawn(executable, ['stdio', '--read-only', '--tools', GITHUB_STDIO_TOOLS.join(','), '--oauth-scopes', 'repo,read:user'],
      { windowsHide: true, shell: false, env: githubBrowserEnvironment(owner, root, githubProcessEnvironment(process.env)), stdio: 'pipe' });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    // Drain but NEVER log OAuth URLs, codes or tokens, including provider diagnostics.
    this.child.stderr.resume();
    this.child.on('error', () => this.stop()); this.child.on('exit', () => this.stop());
    this.child.stdin.on('error', () => this.stop());
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) { this.stop(); return; }
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!raw.trim()) continue;
      try {
        const msg = objectValue(JSON.parse(raw));
        if (msg.jsonrpc !== '2.0') { this.stop(); return; }
        if (msg.method !== undefined) {
          if (msg.id !== undefined) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
            error: { code: -32601, message: 'Host callbacks are not available' } }) + '\n');
          continue;
        }
        const p = this.pending.get(String(msg.id));
        if (!p) continue;
        const result = msg.error ? {} : objectValue(msg.result);
        p.clean(); this.pending.delete(String(msg.id));
        if (msg.error) p.reject(new Error('GitHub 工具请求失败，请检查权限或重新连接'));
        else p.resolve(result);
      } catch { this.stop(); return; }
    }
  }
  async request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (this.stopped) throw new Error('GitHub 登录连接已结束，请点击重新连接');
    if (this.pending.size >= 8) throw new Error('GitHub 连接繁忙');
    return new Promise((resolveResult, reject) => {
      const id = randomUUID();
      const cancel = () => {
        this.pending.delete(id); signal.removeEventListener('abort', cancel);
        if (!this.stopped) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) + '\n');
        reject(new Error('GitHub 请求已停止或超时'));
      };
      this.pending.set(id, { resolve: resolveResult, reject, clean: () => signal.removeEventListener('abort', cancel) });
      signal.addEventListener('abort', cancel, { once: true });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      if (signal.aborted) cancel();
    });
  }
  async initialize(signal: AbortSignal): Promise<void> {
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'StudentBuddy', version: '1.0.0' } }, signal);
    if (!['2025-03-26', '2025-06-18', '2025-11-25'].includes(String(init.protocolVersion))) throw new Error('GitHub MCP 协议不兼容');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async tools(signal: AbortSignal): Promise<PluginTool[]> {
    const out: PluginTool[] = []; let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, signal);
      if (!Array.isArray(result.tools) || result.tools.length > 200) throw new Error('GitHub 工具清单无效');
      for (const raw of result.tools) {
        const t = objectValue(raw);
        if (typeof t.name !== 'string' || !GITHUB_PLUGIN.tools.includes(t.name)) continue;
        const schema = objectValue(t.inputSchema);
        if (schema.type !== 'object' || JSON.stringify(schema).length > 12000) throw new Error('GitHub 参数定义无效');
        out.push({ name: t.name, description: String(t.description ?? '').slice(0, 700), inputSchema: schema });
      }
      if (!result.nextCursor) return out;
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 1000 || cursor === result.nextCursor) break;
      cursor = result.nextCursor;
    }
    throw new Error('GitHub 工具分页超过上限');
  }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; ignoredBlocks: number }> {
    if (!GITHUB_STDIO_TOOLS.includes(name)) throw new Error('GitHub 工具不在白名单');
    const result = await this.request('tools/call', { name, arguments: args }, signal);
    if (result.isError) throw new Error('GitHub 未完成请求，请检查授权、仓库范围或重新连接');
    const { chunks, ignoredBlocks } = mcpTextContent(result);
    if (result.structuredContent && (name === 'get_me' || name === 'search_repositories')) { chunks.length = 0; chunks.push(JSON.stringify(result.structuredContent)); }
    else if (!chunks.length && result.structuredContent) chunks.push(JSON.stringify(result.structuredContent));
    const text = redactPluginText(chunks.join('\n'), '');
    // Never let a failed authentication fallback leak a device code into the model.
    if (/github\.com\/login\/(?:device|oauth)|user_code|verification_uri|authorize the GitHub MCP/i.test(text)) throw new Error('请在插件页面重新连接 GitHub 并完成浏览器授权');
    return { text: !['get_me','search_repositories'].includes(name) && text.length > 14000 ? text.slice(0, 13900) + '\n[结果已截断，请缩小范围]' : text, ignoredBlocks };
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of this.pending.values()) { p.clean(); p.reject(new Error('GitHub 连接已结束')); }
    this.pending.clear(); this.child.kill();
  }
  get alive(): boolean { return !this.stopped; }
}
