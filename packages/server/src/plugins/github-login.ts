import { randomUUID } from 'node:crypto';
import { objectValue, parsePluginRepositories, type GithubLoginState, type PluginTool } from '@sb/shared';
import { GithubStdio } from './github-stdio.js';
import { connection, disconnectPlugin, prepareGithubBrowser, saveDiscovery, updatePlugin, onPluginChange } from './store.js';
interface Login { id: string; client: GithubStdio; controller: AbortController; state: GithubLoginState; tools: PluginTool[]; offered: Set<string> }
const sessions = new Map<string, Login>();
process.once('exit', () => { for (const s of sessions.values()) s.client.stop(); });
const who = (owner: string | null) => owner ?? '';
export function githubLoginState(owner: string | null): GithubLoginState {
  const s = sessions.get(who(owner));
  if (s?.state.status === 'connected' && !s.client.alive) s.state = { ...s.state, status: 'error', error: '连接已结束，请重新连接 GitHub' };
  return s?.state ?? { status: 'disconnected', id: '', login: '', error: '' };
}
export function stopGithubLogin(owner: string | null): void {
  const s = sessions.get(who(owner));
  if (s) { sessions.delete(who(owner)); s.controller.abort(); s.client.stop(); }
}
onPluginChange((owner, id) => {
  if (id === 'github' && connection(owner, id).authMode !== 'browser') stopGithubLogin(owner);
});
export function startGithubLogin(owner: string | null): GithubLoginState {
  stopGithubLogin(owner);
  if (sessions.size >= 8) throw new Error('GitHub 连接数量已达上限');
  disconnectPlugin(owner, 'github'); prepareGithubBrowser(owner);
  const client = new GithubStdio(owner), controller = new AbortController(), id = randomUUID();
  const s: Login = { id, client, controller, tools: [], offered: new Set(), state: { status: 'authorizing', id, login: '', error: '' } };
  sessions.set(who(owner), s);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
  void (async () => {
    await client.initialize(signal); s.tools = await client.tools(signal);
    const profile = objectValue(JSON.parse((await client.call('get_me', {}, signal)).text));
    if (typeof profile.login !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(profile.login)) throw new Error('未取得 GitHub 账号，请重新连接');
    if (sessions.get(who(owner)) !== s || controller.signal.aborted) return;
    s.state = { status: 'connected', id, login: profile.login, error: '' };
  })().catch(() => {
    if (sessions.get(who(owner)) !== s) return;
    client.stop(); s.state = { status: 'error', id, login: '', error: '浏览器授权未完成或连接失败；请取消后重试（5 分钟内完成授权）' };
  });
  return s.state;
}
function current(owner: string | null, id?: string): Login {
  const s = sessions.get(who(owner));
  if (!s || githubLoginState(owner).status !== 'connected' || id && s.id !== id) throw new Error('GitHub 登录已结束或页面已过期，请重新连接');
  return s;
}
export async function githubRepositoryChoices(owner: string | null, id: string, query: string): Promise<string[]> {
  const s = current(owner, id), q = query.trim().slice(0, 100) || `user:${s.state.login}`;
  const result = await s.client.call('search_repositories', { query: q, perPage: 30, minimal_output: true }, AbortSignal.any([s.controller.signal, AbortSignal.timeout(30000)]));
  current(owner, id);
  const data = objectValue(JSON.parse(result.text));
  const repos = (Array.isArray(data.items) ? data.items : []).map(item => objectValue(item).full_name).filter((v): v is string => typeof v === 'string');
  const names = parsePluginRepositories(repos);
  for (const name of names) s.offered.add(name);
  if (s.offered.size > 500) { s.offered = new Set(names); }
  return names;
}
export function selectGithubRepositories(owner: string | null, id: string, raw: unknown) {
  const s = current(owner, id), names = parsePluginRepositories(raw);
  if (!names.length || names.some(n => !s.offered.has(n) && !connection(owner, 'github').repositories.includes(n))) throw new Error('请勾选当前账号查到的仓库（1–50 个）');
  updatePlugin(owner, 'github', { repositories: names });
  const c = connection(owner, 'github');
  if (!s.tools.length) throw new Error('GitHub 未提供可用的只读工具');
  saveDiscovery(owner, 'github', c.revision, s.tools);
  return updatePlugin(owner, 'github', { enabled: true });
}
export function githubBrowserClient(owner: string | null, signal: AbortSignal) {
  const s = current(owner);
  return { initialize: async () => { current(owner, s.id); signal.throwIfAborted(); },
    tools: async () => s.tools, call: (name: string, args: Record<string, unknown>) => s.client.call(name, args, signal), close: async () => {} };
}
