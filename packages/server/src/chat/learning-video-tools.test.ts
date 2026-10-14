import { beforeEach, expect, it, vi } from 'vitest';
import type { VideoHit, VideoRouteResult } from '@sb/shared';
const fake = vi.hoisted(() => ({search:vi.fn(), publish:vi.fn(), access:true, exam:false}));
vi.mock('../sources/video-route.js',()=>({searchVideoRoute:fake.search}));
vi.mock('./sse-bus.js',()=>({publish:fake.publish}));
vi.mock('../auth/ownership.js',()=>({canAccessSession:()=>fake.access,sessionExists:()=>fake.access}));
vi.mock('../learning/exam-mode.js',()=>({loadExamContext:()=>({on:fake.exam}),examAllowed:(url:string)=>!fake.exam||url.includes('bilibili.com')}));
import { executeLearningVideoTool, learningVideoOpening, LEARNING_VIDEO_TOOLS } from './learning-video-tools.js';
import { beginVideoSearch, finishVideoSearch, readLearningVideos, curateLearningVideos, resetLearningVideos } from '../sources/learning-videos.js';
const hit=(id:number):VideoHit=>({route:'bilibili',url:`https://www.bilibili.com/video/BV${id}`,title:`真实搜索标题 ${id}`});
const result=(ids=[1,2]):VideoRouteResult=>({route:'bilibili',query:'JavaScript 闭包 入门',via:'api',siteSearchUrl:'https://search.bilibili.com/all',hits:ids.map(hit)});
const ctx={ownerId:'a',sessionId:'s',onStep:vi.fn()};
it('explicit video requests choose a real search or candidate-read tool rather than forced generic web search',()=>{
  expect(learningVideoOpening('帮我找讲解 JavaScript 闭包的视频')).toBe('search');
  expect(learningVideoOpening('这些视频太难了，换一批更简单的')).toBe('curate');
  expect(learningVideoOpening('把当前视频结果筛选排序')).toBe('curate');
  expect(learningVideoOpening('不要搜视频，解释闭包就好')).toBeNull();
  expect(learningVideoOpening('视频编码是什么')).toBeNull();
});
beforeEach(()=>{vi.clearAllMocks();fake.access=true;fake.exam=false;resetLearningVideos();fake.search.mockResolvedValue(result());});
it('exposes two dynamic tools, passes real search through scope and emits a complete versioned live panel',async()=>{
  expect(LEARNING_VIDEO_TOOLS.map(t=>t.function.name)).toEqual(['search_learning_videos','curate_learning_videos']);
  const r=await executeLearningVideoTool('search_learning_videos',JSON.stringify({query:'JavaScript 闭包 入门',route:'bilibili'}),ctx);
  expect(fake.search).toHaveBeenCalledWith('bilibili','JavaScript 闭包 入门','a',undefined);
  expect(JSON.parse(r.content)).toMatchObject({kind:'learning-videos',sessionId:'s',result:{hits:result().hits}});
  expect(fake.publish).toHaveBeenCalledWith('s',expect.objectContaining({type:'block',payload:expect.objectContaining({kind:'learning-videos'})}));
  expect(readLearningVideos('b','s')).toBeNull();expect(readLearningVideos(null,'s')).toBeNull();
});
it('reads, filters and reorders only verified candidates; stale/forged/duplicate selections are atomic',async()=>{
  await executeLearningVideoTool('search_learning_videos','{"query":"入门","route":"bilibili"}',ctx);
  const original=readLearningVideos('a','s')!;
  for (const urls of [[hit(1).url,'https://evil.invalid/fake'],[hit(1).url,hit(1).url]]) expect(()=>curateLearningVideos('a','s',original.revision,urls)).toThrow();
  expect(readLearningVideos('a','s')).toEqual(original);
  const selected=curateLearningVideos('a','s',original.revision,[hit(2).url,hit(1).url]);
  expect(selected.result.hits.map(h=>h.title)).toEqual(['真实搜索标题 2','真实搜索标题 1']);
  expect(()=>curateLearningVideos('a','s',original.revision,[])).toThrow('已更新');
  const read=JSON.parse((await executeLearningVideoTool('curate_learning_videos','{}',ctx)).content) as {revision:number};
  await executeLearningVideoTool('curate_learning_videos',JSON.stringify({revision:read.revision,urls:[]}),ctx);
  expect(readLearningVideos('a','s')!.result.hits).toEqual([]);
});
it('search and curation generations reject late HTTP/model results and allow factual append only',()=>{
  const old=beginVideoSearch('a','s'), newer=beginVideoSearch('a','s');
  expect(finishVideoSearch('a','s',old,result())).toBeNull();
  const done=finishVideoSearch('a','s',newer,result())!;
  const pending=beginVideoSearch('a','s');
  const curated=curateLearningVideos('a','s',done.revision,[hit(1).url]);
  expect(finishVideoSearch('a','s',pending,result([3]))).toBeNull();
  const next=finishVideoSearch('a','s',beginVideoSearch('a','s'),result([2,3]),true)!;
  expect(next.revision).toBeGreaterThan(curated.revision);
  expect(next.result.hits.map(h=>h.url)).toEqual([hit(1).url,hit(2).url,hit(3).url]);
});
it('cancels without publishing, checks session ownership and refuses malformed tools',async()=>{
  fake.access=false;expect((await executeLearningVideoTool('search_learning_videos','{}',ctx)).content).toContain('会话');expect(fake.search).not.toHaveBeenCalled();
  fake.access=true;await expect(executeLearningVideoTool('search_learning_videos','{"query":"x","route":"fake"}',ctx)).rejects.toThrow('线路');
  const controller=new AbortController();fake.search.mockImplementationOnce(async()=>{controller.abort();return result();});
  await expect(executeLearningVideoTool('search_learning_videos','{"query":"入门","route":"bilibili"}',{...ctx,signal:controller.signal})).rejects.toThrow();
  expect(fake.publish).not.toHaveBeenCalled();
});
it('rechecks changed exam scope and expires temporary results without saving a database row',()=>{
  const mixed={...result(),hits:[hit(1),{route:'douyin' as const,url:'https://www.douyin.com/video/123',title:'外部候选'}]};
  const done=finishVideoSearch('a','s',beginVideoSearch('a','s'),mixed)!;fake.exam=true;
  expect(readLearningVideos('a','s')!.result.hits).toEqual([hit(1)]);
  expect(()=>curateLearningVideos('a','s',done.revision,['https://www.douyin.com/video/123'])).toThrow('未检索');
  const now=vi.spyOn(Date,'now').mockReturnValue(Date.now()+1800001);
  expect(readLearningVideos('a','s')).toBeNull();now.mockRestore();
});
