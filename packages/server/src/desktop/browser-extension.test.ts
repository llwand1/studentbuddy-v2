import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
type Reply={error?:string;ok?:boolean};
function extension() {
  let listener:(message:object,sender:object,reply:(v:Reply)=>void)=>boolean=()=>false;
  const data:Record<string,unknown>={};const inject=vi.fn();const network=vi.fn(async()=>({ok:true,json:async()=>({token:'f'.repeat(64)})}));
  const chrome={runtime:{id:'a'.repeat(32),getURL:(p:string)=>'chrome-extension://'+'a'.repeat(32)+'/'+p,onMessage:{addListener:(l:typeof listener)=>{listener=l;}}},
    storage:{session:{get:async()=>data,set:async(v:Record<string,unknown>)=>Object.assign(data,v),remove:async(k:string)=>{delete data[k];}}},
    scripting:{executeScript:inject},action:{setBadgeText:vi.fn(),setBadgeBackgroundColor:vi.fn()},tabs:{query:async()=>[{id:2,url:'https://developer.mozilla.org/learn',title:'学习页'}],onRemoved:{addListener:vi.fn()},onUpdated:{addListener:vi.fn()}}};
  runInNewContext(readFileSync('tools/browser-extension/background.js','utf8'),{chrome,fetch:network,URL,AbortSignal,crypto});
  return {inject,network,data,send:(message:object,sender:object)=>new Promise<Reply>(reply=>listener(message,{id:chrome.runtime.id,...sender},reply))};
}
it('pairs by a top-level loopback handoff without reading a page; start still requires the popup active-tab gesture',async()=>{
  const x=extension();
  expect(await x.send({type:'handoff',code:'ABCD123456'},{tab:{id:1},frameId:0,url:'http://127.0.0.1:18794/desktop-reader-connect.html#ABCD123456'})).toEqual({ok:true});
  expect(x.network).toHaveBeenCalledWith('http://127.0.0.1:18794/api/desktop/bridge/pair',expect.objectContaining({method:'POST',body:'{"code":"ABCD123456"}'}));
  expect(x.inject).not.toHaveBeenCalled();
  await x.send({type:'start'},{url:'chrome-extension://'+'a'.repeat(32)+'/popup.html'});
  expect(x.inject).toHaveBeenCalledWith(expect.objectContaining({target:{tabId:2},files:['extract.js','content.js']}));
});
it('refuses website, iframe, other local path and substituted-fragment handoffs before any network',async()=>{
  for(const sender of [{frameId:0,url:'https://evil.invalid/desktop-reader-connect.html#ABCD123456'},{frameId:1,url:'http://127.0.0.1:18794/desktop-reader-connect.html#ABCD123456'},
    {frameId:0,url:'http://127.0.0.1:18794/other.html#ABCD123456'},{frameId:0,url:'http://127.0.0.1:18794/desktop-reader-connect.html#0000000000'}]) {
    const x=extension();const response=await x.send({type:'handoff',code:'ABCD123456'},{tab:{id:1},...sender});
    expect(response.error).toBeTruthy();expect(x.network).not.toHaveBeenCalled();expect(x.inject).not.toHaveBeenCalled();
  }
});
