// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DesktopRun } from '@sb/shared';
const mocks=vi.hoisted(()=>({state:vi.fn(),create:vi.fn(),cancel:vi.fn(),retry:vi.fn(),approve:vi.fn(),detail:vi.fn(),workspace:vi.fn(),list:vi.fn(),read:vi.fn(),write:vi.fn(),protect:vi.fn()}));
vi.mock('./workbench-api',()=>({workbenchApi:mocks}));
vi.mock('./desktop-api',()=>({isLocalDesktopAddress:()=>true}));
import { DesktopWorkbench } from './DesktopWorkbench';
const run=(id:string,patch:Partial<DesktopRun>={}):DesktopRun=>({id,parentId:null,sessionId:'s1',kind:'chat',title:'整理学习资料',prompt:'',capability:'workspace_write',status:'running',stage:'整理中',model:'test',tasks:[{text:'读材料',status:'done'},{text:'写提纲',status:'in_progress'}],result:'',error:'',createdAt:1,updatedAt:2,...patch});
const state=()=>({workspace:{root:'C:\\Test\\Workspace',protectedPaths:[],computerAccess:'read_only',workspaceAccess:'read_write',sensitiveAccess:'ask_once'},runs:[run('parent'),run('child',{parentId:'parent',kind:'agent',title:'提纲子任务',capability:'read_only'})],approvals:[{id:'a1',runId:'child',path:'C:\\Test\\.env',operation:'read',reason:'凭据文件',status:'pending',expiresAt:Date.now()+300000}],jobs:[],jobCounts:{}});
beforeEach(()=>{vi.clearAllMocks();mocks.state.mockResolvedValue(state());mocks.detail.mockResolvedValue({run:run('child'),events:[{id:1,summary:'调用 read_file',createdAt:1}]});mocks.create.mockResolvedValue(run('new'));mocks.approve.mockResolvedValue({ok:true});mocks.cancel.mockResolvedValue({ok:true});mocks.list.mockResolvedValue([]);});
afterEach(cleanup);
async function open(){render(<DesktopWorkbench onOpenSession={vi.fn()}/>);await waitFor(()=>expect(screen.getByRole('button',{name:'任务中心 · 1 项待许可'})).toBeTruthy());fireEvent.click(screen.getByRole('button',{name:'任务中心 · 1 项待许可'}));}
it('a global task panel shows persisted checklists, parent/child agents and one-time permission actions',async()=>{
  await open();expect(screen.getByRole('dialog',{name:'任务与工作区'})).toBeTruthy();
  expect(screen.getByText('提纲子任务')).toBeTruthy();expect(screen.getAllByText('1/2')).toHaveLength(2);
  expect(screen.getByText(/必要内容可能发送/)).toBeTruthy();fireEvent.click(screen.getByText('允许一次'));
  await waitFor(()=>expect(mocks.approve).toHaveBeenCalledWith('a1',true));
  fireEvent.click(screen.getByText('停止及子任务'));await waitFor(()=>expect(mocks.cancel).toHaveBeenCalledWith('parent'));
});
it('starting a task uses the independent server executor and preserves the explicit readonly capability',async()=>{
  await open();fireEvent.change(screen.getByLabelText('独立任务描述'),{target:{value:'阅读材料并给出提纲'}});fireEvent.click(screen.getByText('开始任务'));
  await waitFor(()=>expect(mocks.create).toHaveBeenCalledWith('阅读材料并给出提纲','read_only'));
  expect((screen.getByLabelText('独立任务描述') as HTMLTextAreaElement).value).toBe('');
});
it('files expose the workspace and readonly computer policy, and the mechanism is explained in the app',async()=>{
  await open();fireEvent.click(screen.getByRole('button',{name:'文件'}));expect(screen.getByText(/电脑文件：只读/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'列出目录'}));await waitFor(()=>expect(mocks.list).toHaveBeenCalledWith('C:\\Test\\Workspace'));
  fireEvent.click(screen.getByRole('button',{name:'机制'}));expect(screen.getByText(/最多并行 3 个/)).toBeTruthy();
});
it('unavailable non-desktop endpoints do not expose local controls',async()=>{
  mocks.state.mockRejectedValue(new Error('not desktop'));render(<DesktopWorkbench onOpenSession={vi.fn()}/>);
  await waitFor(()=>expect(mocks.state).toHaveBeenCalled());expect(screen.queryByRole('button',{name:/任务中心/})).toBeNull();
});
