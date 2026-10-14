import { beforeEach, expect, it, vi } from 'vitest';
const fake=vi.hoisted(()=>({search:vi.fn(),page:vi.fn()}));
vi.mock('../search/index.js',()=>({searchWeb:fake.search}));
vi.mock('../search/page-text.js',()=>({fetchPageText:fake.page}));
import { discoverExamResources } from './exam-resource-discovery.js';
import { createExecTool } from './tool-dispatch.js';
const ctx={ownerId:'exam-user',onStep:vi.fn()};
beforeEach(()=>{vi.clearAllMocks();fake.search.mockResolvedValue({results:[{url:'https://exam.example.com/paper',title:'题库',snippet:'摘要'},{url:'https://failed.example.com',title:'失败',snippet:'仅摘要'}],providers:['test'],failed:[],dropped:0});fake.page.mockImplementation(async(url:string)=>url.includes('failed')?{ok:false,error:'blocked'}:{ok:true,title:'官方题库',text:'真题与学习资源'});});
it('searches outside original whitelist, verifies actual pages and returns provenance without saving',async()=>{
  const result=await discoverExamResources('{"query":"高考物理真题"}',ctx);const data=JSON.parse(result.content) as {candidates:Array<{host:string;verified:boolean;evidence:string}>;failedPages:string[]};
  expect(fake.search).toHaveBeenCalledWith('高考物理真题','exam-user',{signal:undefined});
  expect(data.candidates).toEqual([expect.objectContaining({host:'exam.example.com',verified:true,evidence:'真题与学习资源'})]);
  expect(data.failedPages).toEqual(['https://failed.example.com']);expect(result.meta?.affected).toBeUndefined();
});
it('invalid queries and cancellation never claim verified resources',async()=>{
  await expect(discoverExamResources('{"query":""}',ctx)).rejects.toThrow('搜索词');expect(fake.search).not.toHaveBeenCalled();
  fake.search.mockResolvedValueOnce({results:[],providers:[],failed:['offline'],dropped:0});
  expect(JSON.parse((await discoverExamResources('{"query":"真题"}',ctx)).content).candidates).toEqual([]);
  const ctrl=new AbortController();ctrl.abort();await expect(discoverExamResources('{"query":"真题"}',{...ctx,signal:ctrl.signal})).rejects.toThrow();
});
it('a hallucinated discovery tool cannot bypass exam scope; discovered host proof gates generated writes',async()=>{
  const exec=createExecTool({sessionId:'s',grill:false,getTasks:()=>[],setTasks:()=>{}});
  expect((await exec('discover_exam_resources','{"query":"真题"}',ctx)).content).toContain('没有补充');expect(fake.search).not.toHaveBeenCalled();
  const enabled=createExecTool({sessionId:'s',grill:false,examDiscoveryAllowed:true,getTasks:()=>[],setTasks:()=>{}});
  await enabled('discover_exam_resources','{"query":"真题"}',ctx);
  expect((await enabled('update_exam_scope','{"addHosts":["invented.example.com"]}',ctx)).content).toContain('必须先');
});
