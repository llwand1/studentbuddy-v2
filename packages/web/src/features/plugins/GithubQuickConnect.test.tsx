// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PluginView } from '@sb/shared';
const fake=vi.hoisted(()=>({githubState:vi.fn(),githubConnect:vi.fn(),githubRepos:vi.fn(),githubSelect:vi.fn()}));
vi.mock('./plugin-api',()=>({pluginApi:fake}));
import { GithubQuickConnect } from './GithubQuickConnect';
const p:PluginView={manifest:{schemaVersion:1,id:'github',name:'GitHub',version:'1',description:'read',transport:'streamable-http',endpoint:'https://api.githubcopilot.com/mcp/',tools:['get_file_contents']},builtin:true,policy:'github_read_only',enabled:false,hasToken:false,repositories:[],tools:[],testedAt:null,error:''};
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('one click starts browser authorization; credentials are hidden in advanced mode',async()=>{
  fake.githubState.mockResolvedValue({status:'disconnected',id:'',login:'',error:''});fake.githubConnect.mockResolvedValue({status:'authorizing',id:'login-1',login:'',error:''});
  render(<GithubQuickConnect plugin={p} onChange={async()=>{}}/>);
  fireEvent.click(await screen.findByRole('button',{name:'连接 GitHub（打开浏览器）'}));
  await screen.findByText(/请在打开的 GitHub 页面完成授权/);expect(fake.githubConnect).toHaveBeenCalledOnce();
  expect(screen.getByText('高级：使用已有 Token').closest('details')?.open).toBe(false);
});
it('connected login offers checkbox choices and activates only explicitly selected repositories',async()=>{
  fake.githubState.mockResolvedValue({status:'connected',id:'login-1',login:'alice',error:''});fake.githubRepos.mockResolvedValue({repositories:['alice/repo','alice/other']});fake.githubSelect.mockResolvedValue({...p,enabled:true});
  render(<GithubQuickConnect plugin={p} onChange={async()=>{}}/>);
  fireEvent.click(await screen.findByRole('checkbox',{name:'alice/repo'}));fireEvent.click(screen.getByRole('button',{name:'使用选中仓库（1）'}));
  await waitFor(()=>expect(fake.githubSelect).toHaveBeenCalledWith('login-1',['alice/repo']));
});
