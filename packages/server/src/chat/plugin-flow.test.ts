import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatRequest } from '../llm/types.js';
const fixture=vi.hoisted(()=>({round:0,requests:[] as ChatRequest[],calls:[] as string[]}));
vi.mock('../llm/router.js',()=>({routeRole:()=>({model:'test-model',apiKey:'not-real',baseUrl:'http://127.0.0.1:1',adapter:{type:'openai',
  async *chat(req:ChatRequest) {
    fixture.requests.push({...req,messages:[...req.messages]});
    const round=fixture.round++;
    if(round===0) yield {content:'',done:true,toolCalls:[{id:'p-list',name:'plugin_tools',arguments:JSON.stringify({plugin:'github',tool:'get_file_contents'})}]};
    else if(round===1) yield {content:'',done:true,toolCalls:[{id:'p-read',name:'plugin_call',arguments:JSON.stringify({plugin:'github',tool:'get_file_contents',arguments:{owner:'owner',repo:'repo',path:'README.md'}})}]};
    else yield {content:req.messages.some(m=>typeof m.content==='string' && m.content.includes('fixture README content')) ? '已读取真实工具返回的 README。' : '工具未读取',done:true};
  },
}})}));
vi.mock('./post-turn.js',()=>({afterTurn:()=>{}}));
vi.mock('../plugins/mcp-http.js',()=>({redactPluginText:(text:string,token:string)=>token ? text.split(token).join('[hidden]') : text,
  McpHttpClient:class {async initialize(){} async tools(){return [{name:'get_file_contents',description:'Read',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},path:{type:'string'}},required:['owner','repo','path']}}];}
    async call(name:string){fixture.calls.push(name);return {text:'fixture README content',ignoredBlocks:0};}async close(){}}
}));
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { handleMessage } from './flow.js';
import { updatePlugin } from '../plugins/store.js';
import { testPlugin } from '../plugins/runtime.js';
import { snapshot } from './sse-bus.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-plugin-flow-'));openIsolated(dir);
afterAll(()=>{closeDb();fs.rmSync(dir,{recursive:true,force:true});});
it('takes the configured plugin through native LLM tool rounds, SSE and persistence rather than just displaying a button',async()=>{
  const db=getDb();db.prepare("INSERT INTO sessions(id,title) VALUES('plugin-flow','插件集成')").run();
  updatePlugin(null,'github',{token:'github_pat_fixture_1234567890',repositories:['owner/repo']});
  await testPlugin(null,'github');updatePlugin(null,'github',{enabled:true});
  const result=await handleMessage({sessionId:'plugin-flow',text:'读取 GitHub 仓库 owner/repo 的 README',online:true,ownerId:null});
  expect(result.ok).toBe(true);expect(fixture.calls).toEqual(['get_file_contents']);
  expect(fixture.requests[0]?.toolChoice).toEqual({type:'function',name:'plugin_tools'});
  expect(fixture.requests[0]?.tools?.map(t=>t.function.name)).toContain('plugin_call');
  expect(fixture.requests[0]?.messages.some(m=>typeof m.content==='string' && m.content.includes('远端说明'))).toBe(true);
  const frames=snapshot('plugin-flow');
  expect(frames.some(x=>x.type==='step' && x.tool==='plugin_call' && x.status==='done')).toBe(true);
  const messages=db.prepare("SELECT role,content FROM messages WHERE session_id='plugin-flow' ORDER BY rowid").all() as Array<{role:string;content:string}>;
  expect(messages.filter(m=>m.role==='tool').map(m=>m.content).join('')).toContain('fixture README content');
  expect(messages.at(-1)?.content).toBe('已读取真实工具返回的 README。');
});

