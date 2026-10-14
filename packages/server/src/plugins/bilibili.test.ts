import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const mock=vi.hoisted(()=>({fetch:vi.fn(),search:vi.fn(),web:vi.fn(),generate:vi.fn()}));
vi.mock('../search/ssrf-guard.js',()=>({fetchSafe:mock.fetch}));
vi.mock('../sources/video-route.js',()=>({searchVideoRoute:mock.search}));
vi.mock('../search/index.js',()=>({searchWeb:mock.web}));
vi.mock('../learning/campfire-opener.js',()=>({generateCampfireOpener:mock.generate}));
import { closeDb, openIsolated } from '../storage/db.js';
import { getDb } from '../storage/db.js';
import { savePomodoro, clearPomodoro } from '../storage/pomodoro.js';
import { saveExamMode, saveExamScope } from '../learning/exam-mode.js';
import { browserStore } from '../desktop/browser-store.js';
import { insertSession } from '../auth/ownership.js';
import { connection, deletePlugin, disconnectPlugin, importPlugin, listPlugins, pluginCalls, updatePlugin } from './store.js';
import { testPlugin, invokePlugin } from './runtime.js';
import { bilibiliMaterial, learningDirection, loadBilibiliVideo, parseVideoNotes, readBilibiliVideo, saveBilibiliVideo, videoAddress } from './bilibili-material.js';
import { pluginChatDefinitions } from './chat.js';
const address='https://www.bilibili.com/video/BV1xx411c7mD';
const notes='闭包使函数继续访问创建时的词法环境。外层函数返回后，内部函数持有的变量仍然可用；调用位置不会改变词法作用域。理解声明位置与执行位置的区别，再分析共享环境和独立环境的计数器行为。';
const ctx={ownerId:'alice',onStep:vi.fn()};
const opener={id:'test-video-q',scope:'',question:{topic:'闭包',question:'词法作用域由什么决定？',options:['声明位置','调用位置'],answer:0,explanation:'函数创建时绑定词法环境。'}};
let directory='';
beforeEach(()=>{
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'sb-bili-'));openIsolated(directory);vi.clearAllMocks();
  mock.fetch.mockImplementation(async(url:string)=>new Response(JSON.stringify({code:0,data:{bvid:new URL(url).searchParams.get('bvid'),title:'闭包第一课',desc:notes,owner:{name:'学习演示'}}})));
  mock.search.mockResolvedValue({route:'bilibili',query:'闭包',hits:[{route:'bilibili',url:address,title:'闭包第一课'}],siteSearchUrl:'https://search.bilibili.com/all?keyword=闭包',via:'api'});
  mock.web.mockResolvedValue({results:[{title:'词法作用域',url:'https://example.org/closure',snippet:'隔离资料'}]});
  mock.generate.mockResolvedValue({ok:true,value:opener});
});
afterEach(()=>{browserStore.clear('alice');closeDb();fs.rmSync(directory,{recursive:true,force:true});});
async function enable(){await testPlugin('alice','bilibili');updatePlugin('alice','bilibili',{enabled:true});}
const use=(tool:string,args:Record<string,unknown>={})=>invokePlugin('bilibili',tool,args,ctx);
it('is a disabled native builtin, cannot be overridden or given an account token, and discovery performs no remote requests',async()=>{
  expect(listPlugins('alice').map(p=>p.manifest.id)).toEqual(['github','bilibili']);
  expect(connection('alice','bilibili')).toMatchObject({enabled:false,hasToken:false,policy:'bilibili_public_learning'});
  expect(()=>updatePlugin('alice','bilibili',{enabled:true})).toThrow();
  expect(()=>updatePlugin('alice','bilibili',{token:'secret12345'})).toThrow('不需要');
  expect(()=>importPlugin('alice',{...connection('alice','github').manifest,id:'bilibili'})).toThrow('内置');
  expect(()=>connection('alice','constructor')).toThrow('插件不存在');expect(()=>connection('alice','__proto__')).toThrow('插件不存在');
  expect(importPlugin('alice',{...connection('alice','github').manifest,id:'constructor'}).builtin).toBe(false);deletePlugin('alice','constructor');
  await enable();expect(mock.fetch).not.toHaveBeenCalled();expect(pluginChatDefinitions('alice')).toHaveLength(2);
  expect(pluginChatDefinitions('bob')).toHaveLength(0);
});
it('does not invent an interest and recommends actual hits and materials from the explicit direction',async()=>{
  await enable();expect(()=>learningDirection('alice')).toThrow('方向');
  const result=await use('recommend_videos',{query:'JavaScript 闭包'});
  expect(result.content).toContain('JavaScript 闭包');expect(result.content).toContain(address);expect(result.content).toContain('https://example.org/closure');
  expect(mock.search).toHaveBeenCalledWith('bilibili','JavaScript 闭包','alice',expect.any(AbortSignal));
  expect(pluginCalls('alice')[0]).toMatchObject({pluginId:'bilibili',tool:'recommend_videos',status:'done'});
});
it('prioritizes explicit direction, active focus, exam and behavior evidence without reading another owner',()=>{
  const now=new Date();savePomodoro({subject:'JavaScript',workMin:25,breakMin:5,round:1,phase:'work',phaseStartedAt:now.toISOString(),phaseEndsAt:new Date(now.getTime()+600000).toISOString(),startedAt:now.toISOString(),completed:0},'alice');
  expect(learningDirection('alice','高等数学').source).toBe('explicit');expect(learningDirection('alice').source).toBe('focus');
  expect(()=>learningDirection('bob')).toThrow();clearPomodoro('alice');saveExamMode(true,'alice');saveExamScope({packs:['gaokao'],extraHosts:['bilibili.com']},'alice');
  expect(learningDirection('alice').source).toBe('exam');saveExamMode(false,'alice');
  getDb().prepare('INSERT INTO term_library(owner_id,id,term,definition,domain,usage_count) VALUES(?,?,?,?,?,?)').run('alice','t1','闭包','词法环境','编程',10);
  expect(learningDirection('alice')).toMatchObject({source:'practice',query:'编程'});
});
it('can use an actual selected shared page when metadata is unavailable, not another owner or unrelated page',async()=>{
  const token=browserStore.pair(browserStore.pairCode('alice','shared-session'))!;
  browserStore.update(token,{url:address,title:'实际共读标题',text:notes,selection:notes,viewport:notes,epoch:'bili-shared-page',seq:1});
  mock.fetch.mockResolvedValue(new Response('',{status:403}));
  const video=await readBilibiliVideo(address,'alice');expect(video.informationSource).toBe('shared-page');expect(video.description).toBe(notes);
  expect(bilibiliMaterial('alice',video).basis).toBe('shared-selection');await expect(readBilibiliVideo(address,'bob')).rejects.toThrow();
});
it('related recommendations use the selected topic and omit that same video from new candidates',async()=>{
  await enable();await use('select_video',{url:address});
  const result=await use('recommend_videos',{relatedToSelected:true});expect(result.content).toContain('你已选择的视频主题');
  expect(mock.search).toHaveBeenCalledWith('bilibili','闭包第一课','alice',expect.any(AbortSignal));
  expect(JSON.parse(result.content.split('\n').slice(1).join('\n')).videos).toEqual([]);
});
it('selects real metadata, isolates owners, survives restart and clears old notes on a different video',async()=>{
  await enable();await use('select_video',{url:address});const first=loadBilibiliVideo('alice')!;
  saveBilibiliVideo('alice',{...first,notes});expect(loadBilibiliVideo('bob')).toBeNull();
  closeDb();openIsolated(directory);expect(loadBilibiliVideo('alice')?.notes).toBe(notes);
  await use('select_video',{url:address.replace('xx','yy')});expect(loadBilibiliVideo('alice')?.notes).toBe('');
  disconnectPlugin('alice','bilibili');expect(loadBilibiliVideo('alice')).toBeNull();
});
it('does not allow the model to fabricate notes, reach non-video URLs, or continue a disabled plugin',async()=>{
  await enable();await expect(use('select_video',{url:address,notes:'fabricated transcript'})).rejects.toThrow('未声明');
  for(const url of ['https://evil.invalid/video/BV1xx411c7mD','file:///BV1xx411c7mD','https://user:secret@www.bilibili.com/video/BV1xx411c7mD'])expect(()=>videoAddress(url,'alice')).toThrow();
  expect(()=>parseVideoNotes('x'.repeat(12001))).toThrow();updatePlugin('alice','bilibili',{enabled:false});
  await expect(use('select_video',{url:address})).rejects.toThrow('停用');expect(mock.fetch).not.toHaveBeenCalled();
});
it('rejects missing, malformed and oversized metadata instead of pretending to read the lesson',async()=>{
  mock.fetch.mockResolvedValueOnce(new Response('{}'));await expect(readBilibiliVideo(address,'alice')).rejects.toThrow('真实');
  mock.fetch.mockResolvedValueOnce(new Response('x'.repeat(1000001)));await expect(readBilibiliVideo(address,'alice')).rejects.toThrow('过大');
  mock.fetch.mockResolvedValueOnce(new Response('',{status:403}));await expect(readBilibiliVideo(address,'alice')).rejects.toThrow('无法读取');
});
it('refuses title-only quizzes and grounds a real quiz in saved user notes with an explicit basis',async()=>{
  await enable();await use('select_video',{url:address});const first=loadBilibiliVideo('alice')!;
  saveBilibiliVideo('alice',{...first,description:'简介很短'});await expect(use('quiz_from_video')).rejects.toThrow('不足');expect(mock.generate).not.toHaveBeenCalled();
  saveBilibiliVideo('alice',{...first,notes});const result=await use('quiz_from_video');
  expect(result.content).toContain('你提交的字幕');expect(mock.generate.mock.calls[0]?.[3]).toContain(notes);
  expect(bilibiliMaterial('alice',loadBilibiliVideo('alice')!).basis).toBe('notes');
  await testPlugin(null,'bilibili');updatePlugin(null,'bilibili',{enabled:true});insertSession('bili-long-notes',null);
  const longNotes=(notes+'\n').repeat(50);saveBilibiliVideo(null,{...first,description:'简介'.repeat(5000),notes:longNotes});
  const shortSelection=await invokePlugin('bilibili','select_video',{url:address},{...ctx,ownerId:null,sessionId:'bili-long-notes'});
  expect(shortSelection.content.length).toBeLessThan(8000);expect(shortSelection.content).toContain('savedNotesChars');
  const delivered=await invokePlugin('bilibili','quiz_from_video',{},{...ctx,ownerId:null,sessionId:'bili-long-notes'});
  expect(delivered.content.length).toBeLessThan(8000);expect(delivered.content).toContain('"delivered":true');expect(delivered.content).toContain(opener.question.question);
  const saved=getDb().prepare("SELECT content FROM messages WHERE session_id='bili-long-notes' AND role='assistant'").get() as {content:string};
  expect(saved.content).toContain('[QUIZ]');expect(saved.content).toContain('bilibili-test-video-q');expect(saved.content).toContain('闭包使函数');
});
it('cancels work when disabled and does not commit metadata after cancellation',async()=>{
  await enable();mock.fetch.mockImplementation((_url: string,init:RequestInit)=>new Promise<Response>((_,reject)=>init.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));
  const pending=use('select_video',{url:address});await Promise.resolve();updatePlugin('alice','bilibili',{enabled:false});
  await expect(pending).rejects.toThrow('停止');expect(loadBilibiliVideo('alice')).toBeNull();expect(pluginCalls('alice')[0]?.status).toBe('cancelled');
});
it('does not deliver stale questions if the video or notes changed during generation',async()=>{
  await enable();await use('select_video',{url:address});
  let finish:((result:unknown)=>void)|undefined;mock.generate.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=use('quiz_from_video');await Promise.resolve();
  saveBilibiliVideo('alice',{...loadBilibiliVideo('alice')!,notes:notes+' 修改后的笔记'});
  finish!({ok:true,value:opener});await expect(pending).rejects.toThrow('旧题未交付');
});
