import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const fixtures=path.resolve('.runtime');fs.mkdirSync(fixtures,{recursive:true});
const base=fs.mkdtempSync(path.join(fixtures,'sb-runtime-'));
process.env.SB_DATA_DIR=path.join(base,'data');process.env.SB_DESKTOP='1';process.env.SB_HOST='127.0.0.1';
const {applyTurnOpening,SEARCH_TOOL_CHOICE}=await import('../chat/opening.js');
const {desktopLocations}=await import('./file-policy.js');
const {isDesktopFileRequest,DESKTOP_RUNTIME_FACTS}=await import('./runtime-context.js');
const {closeDb}=await import('../storage/db.js');
afterAll(()=>{closeDb();delete process.env.SB_DESKTOP;delete process.env.SB_HOST;delete process.env.SB_DESKTOP_USER_DESKTOP;if(path.dirname(base)!==fixtures)throw new Error('Fixture path escaped');fs.rmSync(base,{recursive:true,force:true});});
it('the actual local capability question queries workspace instead of forced web search',()=>{
  const messages:import('../llm/types.js').ChatMessage[]=[];
  const opening=applyTurnOpening({sessionId:'local',text:'你能看到我的桌面吗',online:true},'你能看到我的桌面吗',messages,null);
  expect(opening.toolChoice).toEqual({type:'function',name:'desktop_workspace'});expect(JSON.stringify(messages)).not.toContain('search_web');
  expect(DESKTOP_RUNTIME_FACTS).toContain('模型可能托管在远端');expect(DESKTOP_RUNTIME_FACTS).toContain('不会持续看到屏幕');
});
it('explicit local file tasks use the connected environment but unrelated news keeps online search',()=>{
  for(const text of ['读取桌面上的讲义.txt','保存到工作区','读取 C:\\Users\\test\\Desktop\\note.txt'])expect(isDesktopFileRequest(text)).toBe(true);
  expect(isDesktopFileRequest('今天有什么科技新闻')).toBe(false);
  expect(applyTurnOpening({sessionId:'news',text:'今天新闻',online:true},'今天新闻',[],null).toolChoice).toEqual(SEARCH_TOOL_CHOICE);
});
it('desktop images do not automatically send their OCR to forced internet search',()=>{
  const messages:import('../llm/types.js').ChatMessage[]=[];
  expect(applyTurnOpening({sessionId:'image',text:'解答这张图',online:true,images:[{dataUrl:'data:image/png;base64,AAAA'}]},'解答这张图',messages,null).toolChoice).toBeUndefined();
  expect(messages).toHaveLength(0);
});
it('hosted deployments retain their original online behavior and do not advertise native tools',()=>{
  delete process.env.SB_DESKTOP;
  expect(applyTurnOpening({sessionId:'web',text:'你能看到我的桌面吗',online:true},'你能看到我的桌面吗',[],null).toolChoice).toEqual(SEARCH_TOOL_CHOICE);
  process.env.SB_DESKTOP='1';
});
it('explicit grill mode retains its existing ask-choice priority',()=>{
  expect(applyTurnOpening({sessionId:'grill',text:'桌面文件',online:true,grillMe:true},'桌面文件',[],null).toolChoice).toEqual({type:'function',name:'ask_choice'});
});
it('known desktop location follows the native Windows redirected folder without enumerating it',()=>{
  process.env.SB_DESKTOP_USER_DESKTOP='C:\\Redirected\\Desktop';
  expect(desktopLocations().desktop).toBe('C:\\Redirected\\Desktop');
});
