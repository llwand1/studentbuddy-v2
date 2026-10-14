// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PluginView } from '@sb/shared';
import { PluginsCard } from './PluginsCard';
const api=vi.hoisted(()=>({list:vi.fn(),calls:vi.fn(),update:vi.fn(),test:vi.fn(),disconnect:vi.fn(),remove:vi.fn(),import:vi.fn(),githubState:vi.fn()}));
vi.mock('./plugin-api',()=>({pluginApi:api}));
let plugin:PluginView;
beforeEach(()=>{
  vi.clearAllMocks();api.githubState.mockRejectedValue(new Error('not desktop'));
  plugin={manifest:{schemaVersion:1,id:'github',name:'GitHub',version:'1',description:'只读仓库',transport:'streamable-http',endpoint:'https://api.githubcopilot.com/mcp/',tools:['get_file_contents']},
    builtin:true,policy:'github_read_only',enabled:false,hasToken:false,repositories:[],tools:[],testedAt:null,error:''};
  api.list.mockImplementation(async()=>({plugins:[plugin]}));api.calls.mockResolvedValue({calls:[]});
  api.update.mockImplementation(async(_id:string,patch:{enabled?:boolean;repositories?:string[];token?:string})=>{plugin={...plugin,...(patch.repositories ? {repositories:patch.repositories} : {}),hasToken:!!patch.token || plugin.hasToken,enabled:patch.enabled??false};return plugin;});
  api.test.mockImplementation(async()=>{plugin={...plugin,testedAt:Date.now(),tools:[{name:'get_file_contents',description:'read',inputSchema:{type:'object'}}]};return plugin;});
  api.disconnect.mockImplementation(async()=>{plugin={...plugin,hasToken:false,enabled:false,testedAt:null,tools:[]};return plugin;});
});
afterEach(cleanup);
it('displays honest disconnected state; saves secret without echo, tests then explicitly enables',async()=>{
  render(<PluginsCard/>);await screen.findAllByText('未连接');fireEvent.click(screen.getByText('高级：使用已有 Token'));
  expect((screen.getByRole('button',{name:'启用'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('GitHub Token'),{target:{value:'github_pat_fixture_secret_123'}});
  fireEvent.change(screen.getByLabelText('GitHub 仓库范围'),{target:{value:'Owner/Repo'}});
  expect((screen.getByRole('button',{name:'测试连接'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
  await waitFor(()=>expect(api.update).toHaveBeenCalledWith('github',{token:'github_pat_fixture_secret_123',repositories:['owner/repo']}));
  await waitFor(()=>expect((screen.getByLabelText('GitHub Token') as HTMLInputElement).value).toBe(''));
  fireEvent.click(screen.getByRole('button',{name:'测试连接'}));await screen.findByText('连接通过 · 未启用');
  fireEvent.click(screen.getByRole('button',{name:'启用'}));await screen.findByText('已启用');
  expect(document.body.textContent).not.toContain('github_pat_fixture_secret_123');
});
it('requires explicit acknowledgement to import and shows connection errors',async()=>{
  render(<PluginsCard/>);await screen.findAllByText('未连接');fireEvent.click(screen.getByText('高级：使用已有 Token'));
  fireEvent.click(screen.getByText('高级：导入自定义 MCP 服务'));
  const manifest={schemaVersion:1,id:'reader',name:'Reader',version:'1',description:'reader',transport:'streamable-http',endpoint:'https://mcp.example.com/mcp',tools:['read']};
  fireEvent.change(screen.getByLabelText('插件 JSON 声明'),{target:{value:JSON.stringify(manifest)}});
  const submit=screen.getByRole('button',{name:'导入插件（默认停用）'});
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(submit);await waitFor(()=>expect(api.import).toHaveBeenCalledWith(manifest));
  api.test.mockRejectedValueOnce(new Error('Token 无权限'));fireEvent.click(screen.getByRole('button',{name:'测试连接'}));
  await screen.findByRole('alert');expect(screen.getByRole('alert').textContent).toContain('Token 无权限');
});
it('confirms disconnect before clearing credentials and presents audit separately from chat',async()=>{
  plugin.hasToken=true;api.calls.mockResolvedValue({calls:[{id:1,pluginId:'github',tool:'get_file_contents',status:'error',durationMs:120,error:'仓库不可访问',createdAt:Date.now()}]});
  render(<PluginsCard/>);await screen.findAllByText('未连接');fireEvent.click(screen.getByText('高级：使用已有 Token'));await screen.findByText('仓库不可访问');
  fireEvent.click(screen.getByRole('button',{name:'断开授权'}));expect(api.disconnect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'确认断开'}));await waitFor(()=>expect(api.disconnect).toHaveBeenCalledWith('github'));
});

