/** Isolated actual-component capture. Run invite-smoke.ps1 with -Frames .runtime/companion201-preview/frames first; PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE select a local test runtime, never a user profile. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
const root=process.cwd(),require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const frames=path.join(root,'.runtime/companion201-preview/capture');fs.mkdirSync(frames,{recursive:true});
const entry=path.join(root,'tools/probes/bilibili-companion-demo.tsx').replaceAll('\\','/');
const server=await createServer({configFile:path.join(root,'packages/web/vite.config.ts'),server:{host:'127.0.0.1',port:18826,strictPort:true},plugins:[{name:'isolated-preview',configureServer(s){s.middlewares.use(async(req,res,next)=>{
  const match=req.url?.match(/^\/native-frame\/(invite-\d{2}\.png)$/);
  if(match){res.setHeader('Content-Type','image/png');res.end(fs.readFileSync(path.join(root,'.runtime/companion201-preview/frames',match[1])));return;}
  if(req.url?.startsWith('/component-preview')){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(await s.transformIndexHtml("/component-preview",`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/@fs/${entry}"></script><style>body{margin:0;background:#16101d;color:#eadfc8;font:15px/1.6 'Microsoft YaHei',sans-serif}#demo-canvas{box-sizing:border-box;width:420px;height:382px;padding:18px;text-align:center;background:radial-gradient(ellipse at 50% 30%,#372337,#140f1b 75%);position:relative}#demo-canvas small{font-size:10px;color:#bdad95}h2{font-size:19px;margin:8px 0 12px}.demo-mascot{position:absolute;left:178px;top:91px}.demo-native{position:absolute;left:64px;top:159px;width:292px;height:166px}.demo-state{position:absolute;bottom:33px;left:0;right:0;font-size:13px;margin:0;color:#e7c994}#demo-canvas footer{position:absolute;bottom:12px;left:0;right:0;font-size:11px;color:#ac9aa7}#bili-demo{width:760px;box-sizing:border-box;padding:28px;margin:20px auto}#bili-demo>small{color:#b9a8bb}</style></html>`));return;}next();});}}]});
await server.listen();let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_EXECUTABLE,args:['--no-proxy-server']});
  const page=await browser.newPage({viewport:{width:900,height:1200},deviceScaleFactor:1});
  page.on('pageerror',error=>console.log('Preview page error:',error.message));await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:'{}'}));await page.goto('http://127.0.0.1:18826/component-preview',{waitUntil:'domcontentloaded',timeout:90000});await page.waitForSelector('.sb-companion-art',{timeout:90000});
  for(let frame=0;frame<44;frame++){
    await page.evaluate(index=>window.dispatchEvent(new CustomEvent('demo-frame',{detail:index})),frame);await page.waitForTimeout(125);
    await page.locator('#demo-canvas').screenshot({path:path.join(frames,'frame-'+String(frame).padStart(2,'0')+'.png')});
  }
  fs.copyFileSync(path.join(frames,'frame-27.png'),path.join(root,'docs/images/desktop-companion-invite.png'));
  const video={bvid:'BV1mG411h7aD',url:'https://www.bilibili.com/video/BV1mG411h7aD/',title:'JavaScript 核心基础 · 隔离演示',description:'本示例使用预置的词法环境学习材料。闭包让函数继续访问创建时的词法环境；调用位置不会改变函数的作用域。可比较独立环境和共享环境的计数器。',author:'隔离演示资料',notes:'函数创建时绑定词法环境；外层返回后，内部函数仍持有引用。先说明声明位置与执行位置的区别，再用两个计数器判断环境是否共享。',selectedAt:1};
  await page.route('**/api/**',route=>{
    const url=route.request().url();let data={};
    if(url.endsWith('/browser/preference'))data={selected:'edge',available:['edge','chrome']};
    else if(url.endsWith('/bilibili/learning'))data={video};
    else if(url.endsWith('/bilibili/use'))data={direction:{query:'JavaScript 闭包',reason:'你本次指定的学习方向'},videos:[{url:video.url,title:'闭包与词法环境 · 隔离候选'}],materials:[{title:'词法环境与函数 · 隔离资料',url:'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Guide/Closures'}],siteSearchUrl:'https://search.bilibili.com/all?keyword=JavaScript',note:'预置候选，仅用于界面演示；实际运行使用真实检索结果'};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://127.0.0.1:18826/component-preview?kind=bili');await page.getByLabel('B站字幕或学习笔记').waitFor();
  await page.getByLabel('B站学习方向').fill('JavaScript 闭包');await page.getByRole('button',{name:'推荐视频与学习资料',exact:true}).click();await page.getByText('闭包与词法环境 · 隔离候选').waitFor();
  await page.locator('#bili-demo').screenshot({path:path.join(root,'docs/images/bilibili-learning.png')});
  execFileSync(process.env.PYTHON_EXECUTABLE ?? 'python',['-c',"from PIL import Image; import pathlib,sys; f=[Image.open(p).convert('RGB') for p in sorted(pathlib.Path(sys.argv[1]).glob('frame-*.png'))]; assert len(f)==44; f[0].save(sys.argv[2],save_all=True,append_images=f[1:],duration=125,loop=0,optimize=True)",frames,path.join(root,'docs/images/desktop-companion-invite.gif')]);
  const sourcePaths=['packages/web/src/features/float/FloatCompanion.tsx','packages/web/src/features/float/companion-view.ts','packages/web/src/features/float/companion-glyphs.ts','packages/web/src/features/float/companion.css','packages/web/src/features/plugins/BilibiliLearningCard.tsx','packages/web/src/features/plugins/plugins.css','packages/web/src/features/desktop/BrowserPicker.tsx','tools/desktop/DesktopStudyInvite.cs','tools/desktop/StudyInviteSmoke.cs','tools/probes/bilibili-companion-demo.tsx','tools/probes/bilibili-companion-demo.mjs'];
  const assets=['docs/images/desktop-companion-invite.png','docs/images/desktop-companion-invite.gif','docs/images/bilibili-learning.png'];
  const hash=(file,text=false)=>{const bytes=fs.readFileSync(path.join(root,file));return createHash('sha256').update(text?bytes.toString('utf8').replace(/\r\n/g,'\n'):bytes).digest('hex');};
  fs.writeFileSync(path.join(root,'docs/images/bilibili-companion-evidence.json'),JSON.stringify({kind:'actual-component-preview',data:'isolated predefined video and model fixtures; no personal data',native:'Windows Form DrawToBitmap at an offscreen non-activating location; real invitation class and buttons',web:'actual React companion and BilibiliLearningCard',frames:44,durationMsPerFrame:125,sourceNormalization:'UTF-8 with LF newlines',sourcesSha256:Object.fromEntries(sourcePaths.map(file=>[file,hash(file,true)])),assetsSha256:Object.fromEntries(assets.map(file=>[file,hash(file)]))},null,2)+'\n');
  console.log(JSON.stringify({frames:44,nativeFrames:24,isolated:true,personalData:false,images:assets}));
}finally{if(browser)await browser.close();await server.close();}
