'use strict';
// Run only on a fresh Windows runner, never against a user's installed application.
const fs=require('node:fs/promises'), sync=require('node:fs'), path=require('node:path'), http=require('node:http');
const {spawn,execFile}=require('node:child_process'), {promisify}=require('node:util');
const {generateKeyPairSync,sign,createHash}=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');
const assert=require('node:assert/strict'); const run=promisify(execFile);
const [version,next]=process.argv.slice(2), repo=path.resolve(__dirname,'../..');
const root=path.join(repo,'.runtime','update-smoke-'+Date.now()), install=path.join(root,'Install with spaces'), data=path.join(root,'data');
let server, app, updater;
const env={...process.env,SB_DATA_DIR:data,SB_DESKTOP_UPDATE_TEST_ROOT:root};
async function stop() { if (sync.existsSync(path.join(install,'StudentBuddy.exe'))) await run(path.join(install,'StudentBuddy.exe'),['--stop'],{windowsHide:true,timeout:20000,env}); }
async function health() {
  for(let i=0;i<140;i++) {
    try {
      const port=Number((await fs.readFile(path.join(process.env.LOCALAPPDATA,'StudentBuddy','port'),'utf8')).trim());
      const base=`http://127.0.0.1:${port}`; const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)}); const h=await r.json();
      if(h.ok) return base;
    } catch {} await pause(250);
  } throw new Error('Isolated desktop did not become healthy');
}
async function request(base,url,body) {
  const r=await fetch(base+url,{method:body?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  assert(r.ok,`${url}: HTTP ${r.status}`);return r.json();
}
async function executeUpdate(ready,parent) {
  // The apply helper waits for this known launcher to exit, never kills an unrelated process.
  updater=spawn(ready.node,[ready.script,'--apply',ready.jobPath,String(parent),'--quiet'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';updater.stdout.on('data',b=>output+=b);updater.stderr.on('data',b=>output+=b);
  const done=new Promise(resolve=>updater.once('exit',code=>resolve({code,output})));
  await stop(); return done;
}
(async()=>{
  assert.equal(process.platform,'win32'); assert(version&&next);
  const registry=await run('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{F276CD79-EBEA-4705-9B31-20CA08B5F1EA}_is1'],{windowsHide:true}).catch(()=>null);
  assert(!registry,'Automatic update smoke requires a fresh Windows user');
  await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'.studentbuddy-update-test'),'isolated');
  const baseInstaller=path.join(repo,'.runtime','desktop-output',`StudentBuddy-${version}-windows-x64-setup.exe`);
  await run(baseInstaller,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOICONS','/TASKS=',`/DIR=${install}`],{windowsHide:true,timeout:180000,env});
  const keys=generateKeyPairSync('ed25519');
  await fs.writeFile(path.join(install,'update-public-key.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
  app=spawn(path.join(install,'StudentBuddy.exe'),['--no-browser'],{env,windowsHide:true,stdio:'ignore'});
  let base=await health();
  const session=await request(base,'/api/sessions',{});
  const term=await request(base,'/api/terms',{term:'升级保留验证',definition:'只用于隔离测试的学习内容',domain:'cs'});
  const previous=JSON.parse((await fs.readFile(path.join(install,'desktop-build.json'),'utf8')).replace(/^\uFEFF/,''));
  const filename=`StudentBuddy-${next}-windows-x64-setup.exe`, bytes=await fs.readFile(path.join(repo,'.runtime','update-smoke-target',filename));
  let envelope;
  server=http.createServer((req,res)=>{
    if(req.url==='/update.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(envelope));}
    else if(req.url==='/'+filename){res.setHeader('Content-Length',bytes.length);res.end(bytes);}
    else{res.statusCode=404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  env.SB_DESKTOP_UPDATE_TEST_FEED=origin+'/update.json';
  const manifest={schema:1,version:next,appVersion:JSON.parse(await fs.readFile(path.join(install,'package.json'),'utf8')).version,architecture:'windows-x64',sourceCommit:previous.sourceCommit,
    publishedAt:new Date().toISOString(),url:origin+'/'+filename,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const setEnvelope=m=>{envelope={manifest:m,signature:sign(null,Buffer.from(JSON.stringify(m)),keys.privateKey).toString('base64')};};
  // A trusted publisher accidentally signs a wrong build SHA: installation must roll back, including the DB.
  setEnvelope({...manifest,sourceCommit:'0'.repeat(40)});
  const prepare=async()=>JSON.parse((await run(path.join(install,'runtime','node.exe'),[path.join(install,'update-client.cjs'),'--prepare',install],{env,windowsHide:true,timeout:180000})).stdout);
  let ready=await prepare();assert.equal(ready.state,'ready');
  const failed=await executeUpdate(ready,app.pid);assert.notEqual(failed.code,0);
  const rollback=JSON.parse(await fs.readFile(path.join(path.dirname(ready.jobPath),'result.json'),'utf8'));
  assert(rollback.rolledBack); assert.equal(JSON.parse((await fs.readFile(path.join(install,'desktop-build.json'),'utf8')).replace(/^\uFEFF/,'')).version,version);
  base=await health();assert((await request(base,'/api/sessions')).some(s=>s.id===session.id));
  await stop();
  app=spawn(path.join(install,'StudentBuddy.exe'),['--no-browser'],{env,windowsHide:true,stdio:'ignore'});await health();
  setEnvelope(manifest); ready=await prepare();
  const completed=await executeUpdate(ready,app.pid);assert.equal(completed.code,0,completed.output);
  const installed=JSON.parse((await fs.readFile(path.join(install,'desktop-build.json'),'utf8')).replace(/^\uFEFF/,''));assert.equal(installed.version,next);
  base=await health();assert((await request(base,'/api/sessions')).some(s=>s.id===session.id));
  const terms=await request(base,'/api/terms');
  assert(JSON.stringify(terms).includes('升级保留验证'));
  const report={signedUpdateApplied:true,from:version,to:next,wrongBuildRolledBack:true,sessionPreserved:true,termPreserved:true,isolated:true};
  await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{
  if(server)server.close();
  await stop().catch(()=>{});
  if(sync.existsSync(path.join(install,'unins000.exe'))) await run(path.join(install,'unins000.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART'],{windowsHide:true,timeout:180000,env}).catch(()=>{});
});
