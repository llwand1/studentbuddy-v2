import { useCallback, useEffect, useState } from 'react';
import type { GithubLoginState, PluginView } from '@sb/shared';
import { pluginApi } from './plugin-api';
import { PluginConnectionCard } from './PluginConnectionCard';
import { BrowserPicker } from '../desktop/BrowserPicker';
export function GithubQuickConnect({plugin, onChange}: {plugin:PluginView; onChange:()=>Promise<void>}) {
  const [state,setState]=useState<GithubLoginState>({status:'disconnected',id:'',login:'',error:''});
  const [native,setNative]=useState(false), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const [choices,setChoices]=useState<string[]>([]), [selected,setSelected]=useState(plugin.repositories), [query,setQuery]=useState('');
  const saved=plugin.repositories.join('\n');
  useEffect(()=>setSelected(saved ? saved.split('\n') : []),[saved]);
  const refresh=useCallback(async()=>{const s=await pluginApi.githubState();setState(s);setNative(true);},[]);
  useEffect(()=>{let live=true;void pluginApi.githubState().then(s=>{if(live){setState(s);setNative(true);}}).catch(()=>{});return()=>{live=false;};},[]);
  useEffect(()=>{
    if(state.status!=='authorizing') return;
    const timer=window.setInterval(()=>void refresh().catch(()=>setError('本机连接中断，请重试')),1500);
    return()=>window.clearInterval(timer);
  },[state.status,refresh]);
  const run=async(action:()=>Promise<unknown>)=>{
    setBusy(true);setError('');try{await action();await onChange();}catch(e){setError(e instanceof Error?e.message:'连接失败');}finally{setBusy(false);}
  };
  const search=useCallback(async(id:string,q:string)=>{
    const found=await pluginApi.githubRepos(id,q);setChoices(found.repositories);
  },[]);
  useEffect(()=>{
    if(state.status!=='connected') return;
    let live=true;setBusy(true);
    void pluginApi.githubRepos(state.id,'').then(r=>{if(live)setChoices(r.repositories);}).catch((e:unknown)=>{if(live)setError(e instanceof Error?e.message:'仓库读取失败');}).finally(()=>{if(live)setBusy(false);});
    return()=>{live=false;};
  },[state.id,state.status]);
  return <article className="plugin-card">
    <header className="plugin-head"><h4>GitHub <span className="settings-tag">内置 · 只读工具</span></h4>
      <span className="settings-state">{state.status==='connected'?`${state.login} · ${plugin.enabled?'已启用':'请选择仓库'}`:state.status==='authorizing'?'等待浏览器授权':plugin.authMode==='token'&&plugin.enabled?'Token 已启用':'未连接'}</span></header>
    <p className="settings-hint">点击连接 → 在浏览器授权 → 勾选仓库即可开始。无需复制 Token、服务地址或 JSON。</p>
    {native && <BrowserPicker readerSetupHint={false} />}
    <p className="settings-hint">StudentBuddy 只提供读取工具，并限定勾选仓库。GitHub 授权页面的 repo 权限可能包含写权限，但这些写工具不会开放给 AI。浏览器登录仅存内存，退出应用后需重新连接。</p>
    {native ? <div className="plugin-actions">
      {state.status!=='connected'&&state.status!=='authorizing'&&<button className="settings-add" disabled={busy} onClick={()=>void run(async()=>{setChoices([]);setState(await pluginApi.githubConnect());})}>连接 GitHub（打开浏览器）</button>}
      {state.status==='authorizing'&&<><span role="status">请在打开的 GitHub 页面完成授权，完成后这里自动更新。</span><button disabled={busy} onClick={()=>void run(async()=>{await pluginApi.githubCancel();await refresh();})}>取消连接</button></>}
      {state.status==='connected'&&<><button disabled={busy||!plugin.testedAt} onClick={()=>void run(()=>pluginApi.update('github',{enabled:!plugin.enabled}))}>{plugin.enabled?'停用':'启用'}</button>
        <button disabled={busy} onClick={()=>void run(async()=>{await pluginApi.githubCancel();setChoices([]);await refresh();})}>断开连接</button></>}
    </div>:<p className="settings-hint">浏览器快捷授权在 Windows 安装版可用；当前环境可使用高级 Token 连接。</p>}
    {state.status==='connected'&&<>
      <form onSubmit={e=>{e.preventDefault();void run(()=>search(state.id,query));}} className="plugin-actions">
        <input aria-label="搜索 GitHub 仓库" value={query} onChange={e=>setQuery(e.target.value)} maxLength={100} placeholder="搜索仓库或组织，例如 org:my-org" disabled={busy}/><button disabled={busy}>查找仓库</button></form>
      <div className="plugin-repo-picker" role="group" aria-label="允许 AI 读取的仓库">
        {[...new Set([...choices,...selected])].map(repo=><label key={repo}><input type="checkbox" checked={selected.includes(repo)} disabled={busy} onChange={e=>setSelected(prev=>e.target.checked?[...prev,repo]:prev.filter(r=>r!==repo))}/>{repo}</label>)}
      </div>
      {!choices.length&&<p className="settings-hint">未找到自己的仓库；可以按名称或组织搜索，再勾选。</p>}
      <button className="settings-add" disabled={busy||!selected.length||selected.length>50} onClick={()=>void run(()=>pluginApi.githubSelect(state.id,selected))}>使用选中仓库（{selected.length}）</button>
    </>}
    {busy&&<p role="status">正在连接 GitHub…</p>}{(error||state.error)&&<p role="alert" className="plugin-error">{error||state.error}</p>}
    <details><summary>高级：使用已有 Token</summary><PluginConnectionCard plugin={plugin} onChange={async()=>{await onChange();await refresh().catch(()=>{});}}/></details>
  </article>;
}
