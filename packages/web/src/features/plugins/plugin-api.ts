import type { PluginManifest, PluginView, PluginCallLog, GithubLoginState } from '@sb/shared';
import { request } from '../../lib/api-request';
const base = '/api/plugins';
export const pluginApi = {
  githubState: () => request<GithubLoginState>(base+'/github/login',{timeoutMs:8000}),
  githubConnect: () => request<GithubLoginState>(base+'/github/connect',{method:'POST',body:'{}',timeoutMs:15000}),
  githubCancel: () => request<PluginView>(base+'/github/cancel',{method:'POST',body:'{}'}),
  githubRepos: (id:string,query:string) => request<{repositories:string[]}>(base+'/github/repositories',{method:'POST',body:JSON.stringify({id,query}),timeoutMs:35000}),
  githubSelect: (id:string,repositories:string[]) => request<PluginView>(base+'/github/select',{method:'POST',body:JSON.stringify({id,repositories})}),
  list: (signal?: AbortSignal) => request<{plugins:PluginView[]}>(base,{signal,timeoutMs:10000}),
  calls: () => request<{calls:PluginCallLog[]}>(base+'/calls',{timeoutMs:10000}),
  import: (manifest: PluginManifest) => request<PluginView>(base+'/import',{method:'POST',body:JSON.stringify({manifest})}),
  update: (id:string, patch:{token?:string;repositories?:string[];enabled?:boolean}) => request<PluginView>(base+'/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(patch)}),
  test: (id:string) => request<PluginView>(base+'/'+encodeURIComponent(id)+'/test',{method:'POST',body:'{}',timeoutMs:40000}),
  disconnect: (id:string) => request<PluginView>(base+'/'+encodeURIComponent(id)+'/disconnect',{method:'POST',body:'{}'}),
  remove: (id:string) => request(base+'/'+encodeURIComponent(id),{method:'DELETE'}),
};

