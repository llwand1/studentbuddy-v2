import { parsePluginManifest, parsePluginRepositories, type PluginCallLog, type PluginTool, type PluginView } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { encryptSecret, decryptSecret } from '../storage/crypto.js';
import { ownerForWrite } from '../auth/ownership.js';
import { BUILTIN_PLUGINS } from './catalog.js';
import { clearBilibiliVideo } from './bilibili-material.js';
interface Row {
  auth_mode: 'token' | 'browser';
  manifest: string; token: string; enabled: number; repositories: string; tools: string;
  tested_at: number | null; error: string; revision: number;
}
export interface PluginConnection extends PluginView { token: string; revision: number }
const changes = new Set<(owner: string | null, id: string) => void>();
export function onPluginChange(cb: (owner: string | null, id: string) => void): void { changes.add(cb); }
function changed(owner: string | null, id: string): void { for (const cb of changes) cb(owner, id); }
export function connection(owner: string | null, id: string): PluginConnection {
  const row = getDb().prepare('SELECT * FROM plugin_connection WHERE owner_id=? AND plugin_id=?')
    .get(ownerForWrite(owner), id) as Row | undefined;
  if (!row && !BUILTIN_PLUGINS[id]) throw new Error('插件不存在');
  const manifest = BUILTIN_PLUGINS[id] ?? parsePluginManifest(JSON.parse(row!.manifest));
  return { manifest, builtin: !!BUILTIN_PLUGINS[id], policy: id === 'github' ? 'github_read_only' : id === 'bilibili' ? 'bilibili_public_learning' : 'confirm_each_call',
    authMode: row?.auth_mode ?? 'token',
    token: row ? decryptSecret(row.token) : '', revision: row?.revision ?? 0,
    enabled: row?.enabled === 1, hasToken: !!row?.token,
    repositories: row ? parsePluginRepositories(JSON.parse(row.repositories)) : [],
    tools: row ? JSON.parse(row.tools) as PluginTool[] : [], testedAt: row?.tested_at ?? null, error: row?.error ?? '' };
}
export function pluginView(c: PluginConnection): PluginView {
  const { token: _token, revision: _revision, ...view } = c;
  return view;
}
export function listPlugins(owner: string | null): PluginView[] {
  const ids = getDb().prepare("SELECT plugin_id FROM plugin_connection WHERE owner_id=? AND plugin_id NOT IN ('github','bilibili') ORDER BY plugin_id")
    .all(ownerForWrite(owner)) as Array<{ plugin_id: string }>;
  return [...Object.keys(BUILTIN_PLUGINS), ...ids.map(x => x.plugin_id)].map(id => pluginView(connection(owner, id)));
}
function ensureRow(owner: string | null, id: string): void {
  if (BUILTIN_PLUGINS[id]) getDb().prepare('INSERT OR IGNORE INTO plugin_connection(owner_id,plugin_id,manifest) VALUES(?,?,?)')
    .run(ownerForWrite(owner), id, JSON.stringify(BUILTIN_PLUGINS[id]));
}
export function importPlugin(owner: string | null, raw: unknown): PluginView {
  const m = parsePluginManifest(raw);
  if (BUILTIN_PLUGINS[m.id]) throw new Error('不能覆盖内置插件');
  const rows = listPlugins(owner);
  if (rows.some(p => p.manifest.id === m.id)) throw new Error('插件 id 已存在；端点不可静默更换，请先删除旧插件');
  if (rows.filter(p => !p.builtin).length >= 8) throw new Error('最多导入 8 个自定义插件');
  getDb().prepare('INSERT INTO plugin_connection(owner_id,plugin_id,manifest) VALUES(?,?,?)')
    .run(ownerForWrite(owner), m.id, JSON.stringify(m));
  return pluginView(connection(owner, m.id));
}
export function updatePlugin(owner: string | null, id: string, patch: Record<string, unknown>): PluginView {
  const c = connection(owner, id);
  if (Object.keys(patch).some(k => !['token','repositories','enabled'].includes(k))) throw new Error('不支持的插件配置字段');
  let token = c.token, repos = c.repositories;
  const dirty = patch.token !== undefined || patch.repositories !== undefined;
  if (patch.token !== undefined) {
    if (id === 'bilibili') throw new Error('B站公开学习插件不需要账号 Token');
    if (typeof patch.token !== 'string' || !/^[\x21-\x7e]{8,4096}$/u.test(patch.token) || patch.token.startsWith('enc:')) throw new Error('Token 应为 8–4096 个可见 ASCII 字符，不接受密文或空白');
    token = patch.token;
  }
  if (patch.repositories !== undefined) {
    if (id !== 'github') throw new Error('仓库范围仅用于 GitHub 插件');
    repos = parsePluginRepositories(patch.repositories);
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('enabled 必须为布尔值');
  if (dirty && patch.enabled === true) throw new Error('变更配置后请先测试连接，再启用');
  const enabled = dirty ? false : typeof patch.enabled === 'boolean' ? patch.enabled : c.enabled;
  if (enabled && (!c.testedAt || !c.tools.length || (id === 'github' && ((!token && c.authMode !== 'browser') || !repos.length)))) throw new Error('请先配置仓库范围并成功测试连接，再启用');
  ensureRow(owner, id);
  if (patch.token !== undefined) getDb().prepare("UPDATE plugin_connection SET auth_mode='token' WHERE owner_id=? AND plugin_id=?").run(ownerForWrite(owner), id);
  getDb().prepare(`UPDATE plugin_connection SET token=?, repositories=?, enabled=?, tools=?, tested_at=?, error=?, revision=revision+1 WHERE owner_id=? AND plugin_id=?`)
    .run(encryptSecret(token), JSON.stringify(repos), enabled ? 1 : 0, JSON.stringify(dirty ? [] : c.tools),
      dirty ? null : c.testedAt, '', ownerForWrite(owner), id);
  changed(owner, id);
  return pluginView(connection(owner, id));
}
export function saveDiscovery(owner: string | null, id: string, revision: number, tools: PluginTool[], error = ''): void {
  ensureRow(owner, id);
  const result = getDb().prepare('UPDATE plugin_connection SET tools=?,tested_at=?,error=?,enabled=0 WHERE owner_id=? AND plugin_id=? AND revision=?')
    .run(JSON.stringify(tools), error ? null : Date.now(), error, ownerForWrite(owner), id, revision);
  if (!result.changes) throw new Error('插件配置已改变，请重新测试');
}
export function disconnectPlugin(owner: string | null, id: string): PluginView {
  connection(owner, id); ensureRow(owner, id);
  getDb().prepare("UPDATE plugin_connection SET token='',auth_mode='token',enabled=0,tools='[]',tested_at=NULL,error='',revision=revision+1 WHERE owner_id=? AND plugin_id=?")
    .run(ownerForWrite(owner), id);
  if (id === 'bilibili') clearBilibiliVideo(owner);
  changed(owner, id); return pluginView(connection(owner, id));
}
export function prepareGithubBrowser(owner: string | null): void {
  ensureRow(owner, 'github');
  getDb().prepare("UPDATE plugin_connection SET auth_mode='browser',token='',enabled=0,tools='[]',tested_at=NULL,revision=revision+1 WHERE owner_id=? AND plugin_id='github'").run(ownerForWrite(owner));
  changed(owner, 'github');
}
export function deletePlugin(owner: string | null, id: string): void {
  if (BUILTIN_PLUGINS[id]) throw new Error('内置插件不可删除，可以停用或断开');
  connection(owner, id);
  getDb().prepare('DELETE FROM plugin_connection WHERE owner_id=? AND plugin_id=?').run(ownerForWrite(owner), id);
  changed(owner, id);
}
export function recordPluginCall(owner: string | null, pluginId: string, tool: string, status: PluginCallLog['status'], durationMs: number, error: string): void {
  const db = getDb(), who = ownerForWrite(owner);
  db.transaction(() => {
    db.prepare('INSERT INTO plugin_call_log(owner_id,plugin_id,tool,status,duration_ms,error,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(who, pluginId, tool.slice(0,128), status, durationMs, error.slice(0,500), Date.now());
    db.prepare('DELETE FROM plugin_call_log WHERE owner_id=? AND id NOT IN (SELECT id FROM plugin_call_log WHERE owner_id=? ORDER BY id DESC LIMIT 300)').run(who, who);
  })();
}
export function pluginCalls(owner: string | null): PluginCallLog[] {
  return getDb().prepare('SELECT id,plugin_id AS pluginId,tool,status,duration_ms AS durationMs,error,created_at AS createdAt FROM plugin_call_log WHERE owner_id=? ORDER BY id DESC LIMIT 50')
    .all(ownerForWrite(owner)) as PluginCallLog[];
}

