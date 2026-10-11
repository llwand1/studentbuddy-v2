'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: pause } = require('node:timers/promises');
const { FEED, compare, inside, validateEnvelope, readJson, verifyFile, fetchEnvelope, download, dataDir } = require('./update-core.cjs');
const run = promisify(execFile);

function testOrigin(root) {
  const testRoot = process.env.SB_DESKTOP_UPDATE_TEST_ROOT;
  if (!testRoot) return undefined;
  inside(testRoot, root);
  if (!require('node:fs').existsSync(path.join(testRoot,'.studentbuddy-update-test'))) throw new Error('Update test marker missing');
  const origin = new URL(process.env.SB_DESKTOP_UPDATE_TEST_FEED).origin;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Test feed must be loopback HTTP');
  return origin;
}
async function prepare(root) {
  root = path.resolve(root);
  const build = await readJson(path.join(root,'desktop-build.json'));
  const publicKey = await fs.readFile(path.join(root,'update-public-key.pem'),'utf8');
  const origin = testOrigin(root);
  const envelope = await fetchEnvelope(origin ? process.env.SB_DESKTOP_UPDATE_TEST_FEED : FEED);
  const manifest = validateEnvelope(envelope, publicKey, origin);
  if (compare(manifest.version, build.version) <= 0) return { state:'current', version:build.version };
  const cache = process.env.SB_DESKTOP_UPDATE_TEST_ROOT ? path.join(process.env.SB_DESKTOP_UPDATE_TEST_ROOT,'updates')
    : path.join(process.env.LOCALAPPDATA,'StudentBuddy','updates');
  const jobDir = inside(cache, path.join(cache,`${manifest.version}-${manifest.sha256.slice(0,12)}`));
  await fs.mkdir(jobDir,{recursive:true});
  const installer = inside(jobDir,path.join(jobDir,path.basename(new URL(manifest.url).pathname)));
  await download(manifest.url, installer, manifest);
  // The helper runtime must live outside the installation being replaced.
  for (const file of ['update-client.cjs','update-core.cjs','update-public-key.pem']) await fs.copyFile(path.join(root,file),path.join(jobDir,file));
  await fs.copyFile(path.join(root,'runtime','node.exe'),path.join(jobDir,'node.exe'));
  const job = { root, envelope, oldVersion:build.version, installer, dataDir:dataDir(), testOrigin:origin || null };
  const jobPath = path.join(jobDir,'job.json');
  await fs.writeFile(jobPath,JSON.stringify(job));
  return { state:'ready',version:manifest.version,jobPath,node:path.join(jobDir,'node.exe'),script:path.join(jobDir,'update-client.cjs') };
}
async function waitExit(pid, timeout = 30000) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) throw new Error('Invalid parent PID');
  const deadline = Date.now()+timeout;
  while (Date.now()<deadline) {
    try { process.kill(pid,0); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
    await pause(200);
  }
  throw new Error('Application did not exit; update cancelled');
}
async function snapshotDatabase(dir, backup) {
  await fs.mkdir(backup,{recursive:true});
  const files = [];
  // The old launcher and its SQLite writer have exited; DB+WAL are now a consistent cold snapshot.
  for (const name of ['studentbuddy.db','studentbuddy.db-wal']) {
    try { await fs.copyFile(path.join(dir,name),path.join(backup,name)); files.push(name); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return files;
}
async function restoreDatabase(dir, backup, files) {
  if (!files.includes('studentbuddy.db')) return;
  for (const name of ['studentbuddy.db-wal','studentbuddy.db-shm']) await fs.unlink(path.join(dir,name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  for (const name of files) await fs.copyFile(path.join(backup,name),path.join(dir,name));
}
function startApp(root, quiet) {
  const p = spawn(path.join(root,'StudentBuddy.exe'),quiet ? ['--no-browser'] : [],{cwd:root,detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,SB_DESKTOP_UPDATE_APPLY:'1'}});
  p.on('error',error=>{p.startError=error;});
  // Keep a handle during health verification; successful processes are detached afterwards.
  return p;
}
async function healthy(root, child, appVersion) {
  const portFile = path.join(process.env.LOCALAPPDATA,'StudentBuddy','port');
  const deadline = Date.now()+35000;
  while (Date.now()<deadline) {
    if (child.startError) throw child.startError;
    if (child.exitCode !== null) throw new Error('Updated launcher exited before becoming healthy');
    try {
      const port = Number((await fs.readFile(portFile,'utf8')).trim());
      if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid desktop port');
      const r = await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1500)});
      const value = await r.json();
      if (r.ok && value.ok && value.version===appVersion) return;
    } catch { /* Startup may still be migrating/opening the local database. */ }
    await pause(250);
  }
  throw new Error('Updated service did not become healthy');
}
async function stopApp(root, child) {
  await run(path.join(root,'StudentBuddy.exe'),['--stop'],{windowsHide:true,timeout:20000});
  if (child && child.exitCode === null) await waitExit(child.pid,20000);
}
async function apply(jobPath, parentPid, quiet = false) {
  if (process.platform !== 'win32') throw new Error('Updates require Windows');
  const jobDir = path.dirname(path.resolve(jobPath));
  if (path.basename(jobPath) !== 'job.json' || path.resolve(__dirname)!==jobDir) throw new Error('Run cached update helper');
  const job = await readJson(jobPath), root = path.resolve(job.root);
  const publicKey = await fs.readFile(path.join(jobDir,'update-public-key.pem'),'utf8');
  const manifest = validateEnvelope(job.envelope,publicKey,testOrigin(root));
  const build = await readJson(path.join(root,'desktop-build.json'));
  if (build.version !== job.oldVersion || compare(manifest.version,build.version)<=0) throw new Error('Installed version changed; check for updates again');
  const installer = inside(jobDir,job.installer);
  await verifyFile(installer,manifest);
  const lock=path.join(process.env.LOCALAPPDATA,'StudentBuddy','update-in-progress');
  await fs.writeFile(lock,String(process.pid),{flag:'wx'});
  try { return await installAndVerify(jobDir,job,manifest,installer,parentPid,quiet); }
  finally { await fs.unlink(lock); }
}
async function installAndVerify(jobDir,job,manifest,installer,parentPid,quiet) {
  const root=path.resolve(job.root), build=await readJson(path.join(root,'desktop-build.json'));
  await waitExit(parentPid);
  const backup = inside(jobDir,path.join(jobDir,'backup-' + Date.now()));
  // A previous attempt's backup is never silently overwritten.
  let child, installationStarted = false;
  let dbFiles = [];
  try {
    await fs.mkdir(backup);
    await run('reg.exe',['export','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{F276CD79-EBEA-4705-9B31-20CA08B5F1EA}_is1',path.join(backup,'uninstall.reg'),'/y'],{windowsHide:true,timeout:15000});
    await fs.cp(root,path.join(backup,'app'),{recursive:true,errorOnExist:true,force:false});
    dbFiles = await snapshotDatabase(job.dataDir,path.join(backup,'data'));
    await fs.writeFile(path.join(backup,'recovery.json'),JSON.stringify({root,dataDir:job.dataDir,dbFiles,oldVersion:build.version}));
    installationStarted = true;
    await run(installer,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',`/DIR=${root}`,`/LOG=${path.join(jobDir,'install.log')}`],{windowsHide:true,timeout:240000});
    const installed = await readJson(path.join(root,'desktop-build.json'));
    if (installed.version!==manifest.version || installed.sourceCommit!==manifest.sourceCommit) throw new Error('Installer build differs from signed manifest');
    child = startApp(root,true);
    await healthy(root,child,manifest.appVersion);
    if (!quiet) { await stopApp(root,child); child = startApp(root,false); }
    child.unref();
    await fs.writeFile(path.join(jobDir,'result.json'),JSON.stringify({ok:true,version:manifest.version,backup}));
    return {ok:true,version:manifest.version};
  } catch (error) {
    if (child && child.exitCode===null) await stopApp(root,child);
    if (installationStarted) {
      // Keep extra files for manual recovery; restore known old files without deleting arbitrary directories.
      await fs.cp(path.join(backup,'app'),root,{recursive:true,force:true});
      await restoreDatabase(job.dataDir,path.join(backup,'data'),dbFiles);
      await run('reg.exe',['import',path.join(backup,'uninstall.reg')],{windowsHide:true,timeout:15000});
    }
    const old = startApp(root,quiet); old.unref();
    await fs.writeFile(path.join(jobDir,'result.json'),JSON.stringify({ok:false,rolledBack:installationStarted,error:error.message,backup}));
    throw error;
  }
}
if (require.main===module) {
  const [command,arg,pid,quiet,...extra] = process.argv.slice(2);
  (async () => {
    if (extra.length || !arg) throw new Error('Invalid update arguments');
    let result;
    if (command==='--prepare' && !pid && !quiet) result=await prepare(arg);
    else if (command==='--apply' && /^\d+$/.test(pid || '') && (!quiet || quiet==='--quiet')) result=await apply(arg,Number(pid),quiet==='--quiet');
    else throw new Error('Invalid update command');
    console.log(JSON.stringify(result));
  })().catch(e=>{console.log(JSON.stringify({state:'error',error:e.message}));process.exitCode=1;});
}
module.exports={prepare,apply,waitExit,snapshotDatabase,restoreDatabase};
