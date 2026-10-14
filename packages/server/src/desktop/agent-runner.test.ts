import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const fixtures = path.resolve('.runtime'); fs.mkdirSync(fixtures, { recursive: true });
const base = fs.mkdtempSync(path.join(fixtures, 'sb-agent-'));
process.env.SB_DATA_DIR = path.join(base, 'data'); process.env.SB_DESKTOP_WORKSPACE_ROOT = path.join(base, 'workspace'); process.env.SB_DESKTOP = '1'; process.env.SB_HOST = '127.0.0.1';
const ai = vi.hoisted(() => ({ text: vi.fn() }));
vi.mock('../ai/gateway.js', () => ({ aiText: ai.text }));
const { launchDesktopAgent, desktopAgentPoolState } = await import('./agent-runner.js');
const { createDesktopRun, getDesktopRun, listDesktopRuns, recoverDesktopRuns } = await import('./task-store.js');
const { cancelDesktopRun } = await import('./run-control.js');
const { listFileApprovals, decideFileApproval } = await import('./file-approvals.js');
const { workspaceInfo } = await import('./file-policy.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { withDesktopChatRun } = await import('./chat-integration.js');
const { createExecTool } = await import('../chat/tool-dispatch.js');
const ok = (text = '任务完成', calls?: Array<{ id: string; name: string; arguments: string }>) => ({ ok: true, text, model: 'mock-model', latencyMs: 1, toolCalls: calls });
beforeEach(() => { ai.text.mockReset(); ai.text.mockResolvedValue(ok()); getDb(); });
afterEach(async () => { for (const owner of [null,'user-a']) { for (const run of listDesktopRuns(owner)) cancelDesktopRun(run.id,owner); await vi.waitFor(()=>expect(desktopAgentPoolState(owner)).toEqual({active:0,queued:0})); } });
afterAll(() => { closeDb(); delete process.env.SB_DESKTOP; delete process.env.SB_DESKTOP_WORKSPACE_ROOT; delete process.env.SB_HOST; if (path.dirname(base) !== fixtures) throw new Error('Fixture escaped test root'); fs.rmSync(base, { recursive: true, force: true }); });
it('independent contexts execute real workspace tools and persist progress, model and results', async () => {
  ai.text.mockResolvedValueOnce(ok('', [{ id:'plan',name:'update_tasks',arguments:JSON.stringify({tasks:[{text:'产出笔记',status:'in_progress'}]}) }, { id:'write',name:'write_file',arguments:JSON.stringify({path:'note.md',content:'# 复习'}) }]))
    .mockResolvedValueOnce(ok('', [{id:'done',name:'update_tasks',arguments:JSON.stringify({updates:[{index:1,status:'done'}]})}])).mockResolvedValueOnce(ok('已产出 note.md'));
  const job = launchDesktopAgent(null, '写一份复习笔记', 'workspace_write'); const done = await job.done;
  expect(done.status).toBe('completed'); expect(done.model).toBe('mock-model'); expect(done.tasks[0]!.status).toBe('done');
  expect(fs.readFileSync(path.join(workspaceInfo(null).root,'note.md'),'utf8')).toBe('# 复习');
  closeDb(); expect(getDesktopRun(job.run.id,null)?.result).toBe('已产出 note.md');
});
it('readonly child cannot upgrade writes or recursively spawn, and owners cannot inspect each other', async () => {
  const parent = createDesktopRun('user-a',{kind:'chat',title:'parent',capability:'read_only',status:'running'});
  expect(() => launchDesktopAgent('user-a','write','workspace_write',parent.id)).toThrow('父任务权限');
  ai.text.mockResolvedValueOnce(ok('',[{id:'w',name:'write_file',arguments:'{"path":"forbidden.md","content":"no"}'},{id:'d',name:'delegate_task',arguments:'{"task":"recursive"}'}]));
  const child = launchDesktopAgent('user-a','只读任务','read_only',parent.id); await child.done;
  expect(fs.existsSync(path.join(workspaceInfo(null).root,'forbidden.md'))).toBe(false);
  expect(ai.text.mock.calls[1]![0].messages.filter((m: {role:string})=>m.role==='tool').map((m:{content:string})=>m.content).join(' ')).toContain('无权');
  expect(getDesktopRun(child.run.id,'user-b')).toBeNull(); expect(listDesktopRuns('user-b')).toHaveLength(0);
  expect(() => launchDesktopAgent('user-a','nested','read_only',child.run.id)).toThrow('一级');
});
it('queues after three concurrent agents and cancellation of the parent reaches child agents', async () => {
  let active = 0, peak = 0; const release: Array<() => void> = [];
  ai.text.mockImplementation(({signal}: {signal:AbortSignal}) => new Promise(resolve => {
    active++; peak=Math.max(peak,active); let settled=false;
    const finish=()=>{if(settled)return;settled=true;active--;resolve(ok());}; release.push(finish); signal.addEventListener('abort',finish,{once:true});
  }));
  const parent=createDesktopRun(null,{kind:'chat',title:'并行父任务',status:'running',capability:'workspace_write'});
  const jobs=Array.from({length:5},(_,i)=>launchDesktopAgent(null,`子任务 ${i}`,'read_only',parent.id));
  expect(peak).toBe(3); expect(getDesktopRun(jobs[3]!.run.id,null)?.status).toBe('queued');
  expect(cancelDesktopRun(parent.id,'different-owner')).toBe(false); expect(cancelDesktopRun(parent.id,null)).toBe(true);
  release.forEach(f=>f()); await Promise.all(jobs.map(j=>j.done)); expect(jobs.every(j=>getDesktopRun(j.run.id,null)?.status==='cancelled')).toBe(true);
});
it('a file permission pause exposes no contents to the model until the user allows it', async () => {
  const root=workspaceInfo(null).root; fs.writeFileSync(path.join(root,'.env'),'private value');
  ai.text.mockResolvedValueOnce(ok('',[{id:'r',name:'read_file',arguments:'{"path":".env"}'}]));
  const job=launchDesktopAgent(null,'读取 .env 并解释','read_only');
  await vi.waitFor(()=>expect(getDesktopRun(job.run.id,null)?.status).toBe('waiting_permission'));
  expect(ai.text).toHaveBeenCalledTimes(1); expect(JSON.stringify(ai.text.mock.calls)).not.toContain('private value');
  decideFileApproval(listFileApprovals(null)[0]!.id,null,true); const result=await job.done;
  expect(result.status).toBe('completed'); expect(JSON.stringify(ai.text.mock.calls[1]![0].messages)).toContain('private value');
});
it('restart marks unfinished durable runs interrupted rather than replaying file writes', () => {
  const run=createDesktopRun(null,{kind:'agent',title:'stale',status:'running'}); recoverDesktopRuns();
  expect(getDesktopRun(run.id,null)?.status).toBe('interrupted'); expect(ai.text).not.toHaveBeenCalled();
});
it('failed tools and an unfinished declared checklist cannot be reported as a completed task',async()=>{
  ai.text.mockResolvedValueOnce(ok('',[{id:'bad',name:'write_file',arguments:'{"path":"not-written.txt","content":"no"}'}])).mockResolvedValueOnce(ok('未获得写权限'));
  const denied=await launchDesktopAgent(null,'只读任务','read_only').done;expect(denied.status).toBe('failed');expect(denied.error).toContain('只读');
  ai.text.mockResolvedValueOnce(ok('',[{id:'plan',name:'update_tasks',arguments:'{"tasks":[{"text":"未做完","status":"pending"}]}'}])).mockResolvedValueOnce(ok('回答结束'));
  const unfinished=await launchDesktopAgent(null,'未完成事项测试','read_only').done;expect(unfinished.status).toBe('failed');expect(unfinished.error).toContain('未完成');
});
it('the real chat executor wires durable update_tasks and delegates a bounded child with only its task context',async()=>{
  await withDesktopChatRun({sessionId:'test-session',text:'主任务完整上下文不可被复制',ownerId:null},async opts=>{
    let items: import('@sb/shared').TaskItem[]=[];
    const exec=createExecTool({sessionId:opts.sessionId,desktopTaskId:opts.desktopTaskId,grill:false,getTasks:()=>items,setTasks:value=>{items=value;}});
    const context={ownerId:null,sessionId:opts.sessionId,signal:opts.signal,onStep:()=>{}};
    await exec('update_tasks','{"tasks":[{"text":"整理材料","status":"in_progress"}]}',context);
    expect(getDesktopRun(opts.desktopTaskId!,null)?.tasks).toEqual([{text:'整理材料',status:'in_progress'}]);
    const returned=await exec('delegate_task','{"task":"独立整理一个小节","capability":"read_only"}',context);
    const child=JSON.parse(returned.content); expect(child.status).toBe('completed');
    expect(getDesktopRun(child.id,null)?.parentId).toBe(opts.desktopTaskId);
    expect(JSON.stringify(ai.text.mock.calls[0]![0].messages)).not.toContain('主任务完整上下文不可被复制');
    return {ok:true};
  });
});
it('invalid checklist tool calls fail truthfully but a corrected checklist can recover',async()=>{
  ai.text.mockResolvedValueOnce(ok('',[{id:'bad',name:'update_tasks',arguments:'{"tasks":"wrong"}'}])).mockResolvedValueOnce(ok('结束'));
  expect((await launchDesktopAgent(null,'错误清单','read_only').done).status).toBe('failed');
  ai.text.mockResolvedValueOnce(ok('',[{id:'bad',name:'update_tasks',arguments:'{"tasks":"wrong"}'}]))
    .mockResolvedValueOnce(ok('',[{id:'fixed',name:'update_tasks',arguments:'{"tasks":[{"text":"完成核对","status":"done"}]}'}])).mockResolvedValueOnce(ok('完成'));
  expect((await launchDesktopAgent(null,'修正清单','read_only').done).status).toBe('completed');
});
