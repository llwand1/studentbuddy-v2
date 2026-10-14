// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PluginView } from '@sb/shared';
const api=vi.hoisted(()=>({bilibiliState:vi.fn(),bilibiliUse:vi.fn(),bilibiliNotes:vi.fn(),bilibiliOpen:vi.fn(),test:vi.fn(),update:vi.fn(),disconnect:vi.fn()}));
vi.mock('./plugin-api',()=>({pluginApi:api}));
vi.mock('../desktop/BrowserPicker',()=>({BrowserPicker:()=> <span>指定浏览器</span>}));
vi.mock('../quiz/QuizCard',()=>({QuizCard:({title}:{title:string})=><div>可作答题卡：{title}</div>}));
import { BilibiliLearningCard } from './BilibiliLearningCard';
const video={bvid:'BV1xx411c7mD',url:'https://www.bilibili.com/video/BV1xx411c7mD',title:'闭包第一课',description:'公开简介',notes:'',author:'演示老师',selectedAt:1};
const plugin:PluginView={manifest:{schemaVersion:1,id:'bilibili',name:'B站学习',version:'1',description:'学习',transport:'builtin',endpoint:'https://www.bilibili.com/',tools:[]},builtin:true,policy:'bilibili_public_learning',enabled:true,hasToken:false,repositories:[],tools:[],testedAt:1,error:''};
beforeEach(()=>{vi.clearAllMocks();api.bilibiliState.mockResolvedValue({video:null});api.bilibiliUse.mockImplementation(async(tool:string)=>tool==='select_video'?video:tool==='recommend_videos'?{
  direction:{query:'闭包',reason:'你本次指定的学习方向'},videos:[{url:video.url,title:video.title}],materials:[{url:'https://example.org',title:'学习资料'}],siteSearchUrl:'https://search.bilibili.com/',note:'真实候选',
}: {basisLabel:'你提交的字幕 / 学习笔记',opener:{id:'q1',question:{topic:'词法环境',question:'哪一项？',options:['A','B'],answer:0,explanation:'因为环境'},material:'笔记'}});
api.bilibiliNotes.mockResolvedValue(video);api.test.mockResolvedValue(plugin);api.update.mockResolvedValue(plugin);api.bilibiliOpen.mockResolvedValue({ok:true});});
afterEach(cleanup);
it('enables a public plugin explicitly with no token configuration and opens the chosen browser',async()=>{
  const changed=vi.fn(async()=>{});render(<BilibiliLearningCard plugin={{...plugin,enabled:false}} onChange={changed}/>);
  fireEvent.click(screen.getByText('启用并打开 B站'));await waitFor(()=>expect(api.update).toHaveBeenCalledWith('bilibili',{enabled:true}));
  expect(api.test).toHaveBeenCalledWith('bilibili');expect(changed).toHaveBeenCalled();expect(document.querySelector('input[type=password]')).toBeNull();
});
it('shows real candidates and materials, selects a video and submits notes through the user-only endpoint before a quiz',async()=>{
  render(<BilibiliLearningCard plugin={plugin} onChange={async()=>{}}/>);
  fireEvent.change(screen.getByLabelText('B站学习方向'),{target:{value:'闭包'}});fireEvent.click(screen.getByText('推荐视频与学习资料'));
  await screen.findByText('学习资料');expect(api.bilibiliUse).toHaveBeenCalledWith('recommend_videos',{query:'闭包'});
  fireEvent.click(screen.getByText('学习这个视频'));await screen.findByLabelText('B站字幕或学习笔记');
  fireEvent.change(screen.getByLabelText('B站字幕或学习笔记'),{target:{value:'用户提交的真实学习笔记'}});
  fireEvent.click(screen.getByText('按这个视频练一题'));await screen.findByText('可作答题卡：词法环境');
  expect(api.bilibiliNotes).toHaveBeenCalledWith(video.url,'用户提交的真实学习笔记');
  expect(api.bilibiliUse).toHaveBeenCalledWith('select_video',{url:video.url});expect(api.bilibiliUse).toHaveBeenCalledWith('quiz_from_video',{});
});
it('shows insufficient-material errors and never invents a successful quiz',async()=>{
  api.bilibiliState.mockResolvedValue({video});api.bilibiliUse.mockRejectedValue(new Error('材料不足，请补充字幕 / 笔记'));
  render(<BilibiliLearningCard plugin={plugin} onChange={async()=>{}}/>);await screen.findByLabelText('B站字幕或学习笔记');
  fireEvent.click(screen.getByText('按这个视频练一题'));expect((await screen.findByRole('alert')).textContent).toContain('材料不足');
  expect(screen.queryByText(/可作答题卡/)).toBeNull();
});
