/** Declarative remote plugins; no executable code or credentials in manifests. */
export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  transport: 'streamable-http';
  endpoint: string;
  tools: string[];
}
export interface PluginTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface PluginView {
  authMode?: 'token' | 'browser';
  manifest: PluginManifest;
  builtin: boolean;
  policy: 'github_read_only' | 'confirm_each_call';
  enabled: boolean;
  hasToken: boolean;
  repositories: string[];
  tools: PluginTool[];
  testedAt: number | null;
  error: string;
}
export interface GithubLoginState { status: 'disconnected' | 'authorizing' | 'connected' | 'error'; id: string; login: string; error: string }
export interface PluginCallLog {
  id: number; pluginId: string; tool: string;
  status: 'done' | 'error' | 'denied' | 'cancelled';
  durationMs: number; error: string; createdAt: number;
}
export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象');
  return value as Record<string, unknown>;
}
export function parsePluginManifest(raw: unknown): PluginManifest {
  const x = objectValue(raw);
  const permitted = ['schemaVersion','id','name','version','description','transport','endpoint','tools'];
  if (Object.keys(x).some(k => !permitted.includes(k))) throw new Error('插件声明含不支持的字段（不允许脚本、密钥或自定义请求头）');
  if (x.schemaVersion !== 1 || x.transport !== 'streamable-http') throw new Error('仅支持 schemaVersion=1 的 Streamable HTTP 插件');
  const str = (key: string, limit: number) => {
    const v = x[key];
    if (typeof v !== 'string' || !v.trim() || v.length > limit || [...v].some(c => c.charCodeAt(0) < 32)) throw new Error(`插件 ${key} 无效`);
    return v.trim();
  };
  const id = str('id', 48);
  if (!/^[a-z][a-z0-9-]{1,47}$/u.test(id)) throw new Error('插件 id 只能使用小写字母、数字和短横线（2–48 字符）');
  const endpoint = str('endpoint', 1000);
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !url.hostname.includes('.') || /^[\d.[\]:]+$/u.test(url.hostname)) throw new Error('端点必须是公网 HTTPS 域名，不含账号、查询参数或片段');
  if (!Array.isArray(x.tools) || !x.tools.length || x.tools.length > 32 ||
      x.tools.some(t => typeof t !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/u.test(t))) throw new Error('必须声明 1–32 个合法工具名');
  return { schemaVersion: 1, id, name: str('name', 64), version: str('version', 32),
    description: str('description', 500), transport: 'streamable-http', endpoint: url.href,
    tools: [...new Set(x.tools as string[])] };
}
export function parsePluginRepositories(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 50 || raw.some(v => typeof v !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/([a-zA-Z0-9_.-]{1,100})$/u.test(v) || /\/\.{1,2}$/u.test(v))) {
    throw new Error('仓库填写 owner/repo，每次最多 50 个');
  }
  return [...new Set((raw as string[]).map(v => v.toLowerCase()))];
}

