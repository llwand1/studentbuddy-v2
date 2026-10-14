import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const stub = vi.hoisted(()=>({calls:[] as Array<{name:string;args:Record<string,unknown>}>,hold:false,fail:false,token:'',schema:{
  name:'get_file_contents',description:'Read a file',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},path:{type:'string'}},required:['owner','repo','path']}
}}));
vi.mock('./mcp-http.js',async(importOriginal)=>{
  const actual = await importOriginal<typeof import('./mcp-http.js')>();
  return {...actual,McpHttpClient:class {
    constructor(_m:unknown, token:string, private signal:AbortSignal) {stub.token=token;}
    async initialize() {if(stub.fail) throw new Error('failed '+stub.token);}
    async tools() {return [stub.schema,{name:'lookup',description:'Lookup',inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q']}}];}
    async call(name:string,args:Record<string,unknown>) {
      stub.calls.push({name,args});
      if (stub.hold) await new Promise<void>((_resolve,reject)=>this.signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));
      return {text:'README result '+stub.token,ignoredBlocks:0};
    }
    async close() {}
  }};
});
import { closeDb, openIsolated, getDb } from '../storage/db.js';
import { connection, listPlugins, importPlugin, updatePlugin, pluginCalls, disconnectPlugin, deletePlugin } from './store.js';
import { invokePlugin, testPlugin } from './runtime.js';
import { executePluginChatTool, pluginChatDefinitions } from './chat.js';
import { snapshot } from '../chat/sse-bus.js';
import { resolveConfirmation } from '../chat/tools/confirm.js';
const token='github_pat_test_plugin_1234567890', args={owner:'owner',repo:'repo',path:'README.md'};
const ctx={ownerId:'alice',sessionId:'test-plugin-session',onStep:vi.fn()};
let dir='';
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-plugin-'));openIsolated(dir);stub.calls=[];stub.hold=false;stub.fail=false;ctx.onStep.mockClear();});
afterEach(()=>{closeDb();fs.rmSync(dir,{recursive:true,force:true});});
async function configured() {updatePlugin('alice','github',{token,repositories:['owner/repo']});await testPlugin('alice','github');updatePlugin('alice','github',{enabled:true});}
it('keeps credentials encrypted, owner-isolated and absent from API views; restart retains configuration',async()=>{
  await configured();expect(JSON.stringify(listPlugins('alice'))).not.toContain(token);
  expect(connection('bob','github').token).toBe('');expect(connection(null,'github').token).toBe('');
  expect((getDb().prepare('SELECT token FROM plugin_connection').get() as {token:string}).token).toMatch(/^enc:v1:/u);
  closeDb();openIsolated(dir);expect(connection('alice','github').enabled).toBe(true);
});
it('test discovers only declarations and never calls remote tools; enable needs successful validation',async()=>{
  expect(()=>updatePlugin('alice','github',{enabled:true})).toThrow();
  await configured();expect(stub.calls).toEqual([]);expect(connection('alice','github').tools.map(t=>t.name)).toEqual(['get_file_contents']);
  updatePlugin('alice','github',{repositories:['owner/other']});
  expect(connection('alice','github')).toMatchObject({enabled:false,testedAt:null,tools:[]});
  expect(()=>updatePlugin('alice','github',{enabled:true})).toThrow();
});
it('calls a real runtime adapter only after repository and tool checks; redacts response and keeps bounded audit',async()=>{
  await configured();
  await expect(invokePlugin('github','create_issue',args,ctx)).rejects.toThrow('白名单');
  await expect(invokePlugin('github','get_file_contents',{...args,repo:'secret'},ctx)).rejects.toThrow('授权范围');
  await expect(invokePlugin('github','get_file_contents',{...args,extra:'bad'},ctx)).rejects.toThrow('未声明参数');
  const result=await invokePlugin('github','get_file_contents',args,ctx);
  expect(result.content).toContain('README result');expect(result.content).not.toContain(token);expect(stub.calls).toHaveLength(1);
  expect(pluginCalls('alice').map(x=>x.status)).toEqual(['done','error','error','error']);expect(pluginCalls('bob')).toEqual([]);
});
it('stops in-flight work when disabled and never replays; disconnect clears credentials',async()=>{
  await configured();stub.hold=true;const work=invokePlugin('github','get_file_contents',args,ctx);
  const caught=work.catch(e=>e as Error);
  await vi.waitFor(()=>expect(stub.calls).toHaveLength(1));
  updatePlugin('alice','github',{enabled:false});expect(await caught).toBeInstanceOf(Error);
  expect(pluginCalls('alice')[0]?.status).toBe('cancelled');
  expect(disconnectPlugin('alice','github')).toMatchObject({hasToken:false,enabled:false,testedAt:null});
  await expect(invokePlugin('github','get_file_contents',args,ctx)).rejects.toThrow();
  expect(stub.calls).toHaveLength(1);
});
it('keeps secrets out of connection errors and rejects stale discoveries after configuration changes',async()=>{
  updatePlugin('alice','github',{token,repositories:['owner/repo']});stub.fail=true;
  await expect(testPlugin('alice','github')).rejects.not.toThrow(token);
  expect(listPlugins('alice')[0]?.error).toContain('[已隐藏密钥]');
});
it('never persists a successful discovery after its request has already been cancelled',async()=>{
  updatePlugin('alice','github',{token,repositories:['owner/repo']});
  const controller=new AbortController();controller.abort();
  await expect(testPlugin('alice','github',controller.signal)).rejects.toThrow('未保存结果');
  expect(connection('alice','github')).toMatchObject({enabled:false,testedAt:null,tools:[],error:''});
});
it('imports extensibly without code changes, denies overwrite and enforces one-call approvals',async()=>{
  const manifest={schemaVersion:1,id:'custom-reader',name:'Custom',version:'1',description:'Reader',transport:'streamable-http',endpoint:'https://mcp.example.com/mcp',tools:['lookup']};
  expect(importPlugin('alice',manifest)).toMatchObject({policy:'confirm_each_call',enabled:false});
  expect(()=>importPlugin('alice',manifest)).toThrow('已存在');
  expect(()=>importPlugin('alice',{...manifest,id:'github'})).toThrow('内置');
  await testPlugin('alice','custom-reader');updatePlugin('alice','custom-reader',{enabled:true});
  const work=invokePlugin('custom-reader','lookup',{q:'lesson'},ctx);
  let requestId='';
  await vi.waitFor(()=>{
    const frames=snapshot(ctx.sessionId);
    const frame=[...frames].reverse().find(x=>x.type==='tool-confirm-request');
    if(frame?.type==='tool-confirm-request') {requestId=frame.requestId;expect(frame.onceOnly).toBe(true);expect(frame.items.join('')).toContain('lesson');}
    expect(requestId).not.toBe('');
  });
  expect(stub.calls).toEqual([]);
  expect(resolveConfirmation(requestId,'allow_session')).toMatchObject({ok:false,status:400});
  expect(resolveConfirmation(requestId,'deny')).toEqual({ok:true});
  expect((await work).content).toContain('未执行');expect(stub.calls).toEqual([]);
  const allowed=invokePlugin('custom-reader','lookup',{q:'next'},ctx);
  await vi.waitFor(()=>{
    const frame=[...snapshot(ctx.sessionId)].reverse().find(x=>x.type==='tool-confirm-request');
    expect(frame?.type==='tool-confirm-request' && frame.requestId!==requestId).toBe(true);
    if(frame?.type==='tool-confirm-request') requestId=frame.requestId;
  });
  resolveConfirmation(requestId,'allow_once');await allowed;expect(stub.calls).toHaveLength(1);
  deletePlugin('alice','custom-reader');expect(listPlugins('alice').map(p=>p.manifest.id)).toEqual(['github','bilibili']);
});
it('advertises only owner-enabled capabilities and returns one bounded schema on demand',async()=>{
  expect(pluginChatDefinitions('alice')).toEqual([]);await configured();
  expect(pluginChatDefinitions('alice').map(t=>t.function.name)).toEqual(['plugin_tools','plugin_call']);
  expect(pluginChatDefinitions('bob')).toEqual([]);
  const response=await executePluginChatTool('plugin_tools',JSON.stringify({plugin:'github',tool:'get_file_contents'}),ctx);
  expect(response.content).toContain('inputSchema');expect(response.content).not.toContain(token);
});


it('refuses work after permission changes while waiting for a third-party confirmation',async()=>{
  importPlugin('alice',{schemaVersion:1,id:'confirm-stale',name:'Stale',version:'1',description:'reader',transport:'streamable-http',endpoint:'https://mcp.example.com/mcp',tools:['lookup']});
  await testPlugin('alice','confirm-stale');updatePlugin('alice','confirm-stale',{enabled:true});
  const work=invokePlugin('confirm-stale','lookup',{q:'bounded'},ctx);
  await vi.waitFor(()=>expect(snapshot(ctx.sessionId).some(x=>x.type==='tool-confirm-request' && x.server==='Stale')).toBe(true));
  updatePlugin('alice','confirm-stale',{enabled:false});
  expect((await work).content).toContain('未执行');expect(stub.calls).toEqual([]);
  expect(pluginCalls('alice')[0]?.status).toBe('cancelled');
});
it('bounds concurrency per owner and does not replay over-capacity calls',async()=>{
  await configured();stub.hold=true;
  const pending=Array.from({length:4},()=>invokePlugin('github','get_file_contents',args,ctx).catch(e=>e as Error));
  await vi.waitFor(()=>expect(stub.calls).toHaveLength(4));
  await expect(invokePlugin('github','get_file_contents',args,ctx)).rejects.toThrow('并发上限');
  updatePlugin('alice','github',{enabled:false});await Promise.all(pending);expect(stub.calls).toHaveLength(4);
});
it('upgrades v61 without touching learning messages and caps audit retention',async()=>{
  const db=getDb();
  db.exec("DROP TABLE plugin_connection; DROP TABLE plugin_call_log; DELETE FROM schema_version WHERE version>=62; INSERT INTO sessions(id,title) VALUES('kept','旧会话'); INSERT INTO messages(session_id,role,content) VALUES('kept','user','旧内容')");
  const {migrate}=await import('../storage/migrations.js');migrate(db);migrate(db);
  expect(db.prepare("SELECT content FROM messages WHERE session_id='kept'").get()).toEqual({content:'旧内容'});
  const {recordPluginCall}=await import('./store.js');
  for(let i=0;i<305;i++) recordPluginCall('alice','github','get_file_contents','done',1,'');
  expect(db.prepare("SELECT COUNT(*) n FROM plugin_call_log WHERE owner_id='alice'").get()).toEqual({n:300});
  expect(pluginCalls('alice')).toHaveLength(50);
});

