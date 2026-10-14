import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../..'),out=join(root,'docs/images'),port=19437;
const web=join(root,'packages/web'),html=join(web,'learning-evidence.html');
const browser=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
if(!browser)throw Error('No installed Chromium browser');
try{await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(2000)});throw Error('QA CDP port is already occupied');}catch(e){if(e.message.includes('occupied'))throw e;}
if(existsSync(html))throw Error('Refusing to overwrite an existing evidence entry');
try{await fetch('http://127.0.0.1:18797/');throw Error('Evidence Vite port is occupied');}catch(e){if(e.message.includes('occupied'))throw e;}
writeFileSync(html,`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离学习流程证据</title><style>body{margin:0;background:#111019;color:#eee;font:16px/1.6 system-ui}.evidence{max-width:700px;margin:0 auto;padding:22px}.evidence h1{font-size:25px;margin:8px 0}.evidence header p,.evidence header small{color:#b3aaa0}.quiz-card{margin:16px 0}</style></head><body><div id="root"></div><script type="module" src="${encodeURI('/@fs/'+join(root,'tools/probes/learning-evidence.tsx').replaceAll('\\','/'))}"></script></body></html>`);
const vite=spawn(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','18797','--strictPort',web],{cwd:root,stdio:'ignore',windowsHide:true});
const profile=mkdtempSync(join(root,'.runtime/evidence-profile-'));
const child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws;
try{
  let tabs;for(let i=0;i<50;i++){try{tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();break;}catch{await sleep(200);}}
  if(!tabs)throw Error('Browser did not start');ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:18797/learning-evidence.html')).ok)break;}catch{}await sleep(100);}
  let id=0;const pending=new Map();ws.onmessage=e=>{const x=JSON.parse(e.data),p=pending.get(x.id);if(p){pending.delete(x.id);x.error?p.reject(Error(JSON.stringify(x.error))):p.resolve(x.result);}};
  const cmd=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>{const x=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(x.exceptionDetails)throw Error(JSON.stringify(x.exceptionDetails));return x.result.value;};
  await cmd('Page.enable');await cmd('Emulation.setDeviceMetricsOverride',{width:800,height:1050,deviceScaleFactor:1,mobile:false});await cmd('Page.navigate',{url:'http://127.0.0.1:18797/learning-evidence.html'});
  for(let i=0;i<70;i++){if(await evaluate(`!!document.querySelector('.qf-toggle')`))break;await sleep(150);}
  if(!await evaluate(`document.body.innerText.includes('专属分析')`))throw Error('Production quiz components did not render');
  await evaluate(`document.querySelector('.qf-toggle').click()`);await sleep(500);
  if(!await evaluate(`document.querySelectorAll('.choice-opt').length===2`))throw Error('Feedback prediction UI not loaded');
  const shot=async filename=>{const metrics=await cmd('Page.getLayoutMetrics');const size=metrics.cssContentSize;const image=await cmd('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:800,height:Math.ceil(size.height),scale:1}});writeFileSync(join(out,filename),Buffer.from(image.data,'base64'));return{filename,width:800,height:Math.ceil(size.height)};};
  mkdirSync(out,{recursive:true});const images=[await shot('learning-feedback-before.png')];
  await evaluate(`document.querySelector('.choice-opt').click()`);await sleep(600);
  if(!await evaluate(`document.body.innerText.includes('本题调整：') && document.querySelectorAll('.quiz-card').length===2`))throw Error('Adapted question not appended by production handler');
  images.push(await shot('learning-feedback-after.png'));
  const files=['tools/probes/learning-evidence.tsx','packages/web/src/features/quiz/QuizQuestionItem.tsx','packages/web/src/features/quiz/QuestionThinking.tsx','packages/web/src/features/quiz/QuestionFeedback.tsx','packages/web/src/features/quiz/useQuestionFeedback.ts'];
  const hashes=Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(join(root,f))).digest('hex')]));
  writeFileSync(join(root,'docs/images/learning-feedback-evidence.json'),JSON.stringify({kind:'real-component-capture',data:'isolated deterministic fixture; model outputs predefined; not a learning-outcome benchmark',images,hashes},null,2)+'\n');
  console.log(JSON.stringify({checks:4,images}));
  await cmd('Browser.close');
}finally{ws?.close();child.kill();vite.kill();if(resolve(html)===resolve(web,'learning-evidence.html'))unlinkSync(html);}
