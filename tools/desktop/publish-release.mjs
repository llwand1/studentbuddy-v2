import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { preparePackage } from './prepare-package.mjs';
const { validateEnvelope, verifyFile, compare } = createRequire(import.meta.url)('./update-core.cjs');
const version = process.env.DESKTOP_VERSION, commit = process.env.SOURCE_COMMIT;
const repo = process.env.GITHUB_REPOSITORY;
if (repo !== 'llwand1/xuelian-agent' || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Unexpected release repository/source');
const gh = (...args) => execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const assets = '.runtime/release-assets', filename=`StudentBuddy-${version}-windows-x64-setup.exe`, tag=`desktop-v${version}`;
const readerVersion=JSON.parse(fs.readFileSync('tools/browser-extension/manifest.json','utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(readerVersion))throw new Error('Invalid reader extension version');
const readerZip=`StudentBuddy-reader-extension-${readerVersion}.zip`, readerSum='reader-extension-SHA256SUMS.txt';
const releaseFiles=[filename,'SHA256SUMS.txt','update.json',readerZip,readerSum];
const publicKey=fs.readFileSync(new URL('./update-public-key.pem',import.meta.url),'utf8');
let existing;
try { existing=JSON.parse(gh('release','view',tag,'--repo',repo,'--json','isDraft,targetCommitish')); }
catch (e) { if (!/not found|404/i.test(String(e.stderr))) throw e; }
if (existing && !existing.isDraft) {
  const publishedCommit = gh('api',`repos/${repo}/commits/${tag}`,'--jq','.sha');
  if (publishedCommit !== commit) throw new Error('Desktop version already belongs to different source');
  const released='.runtime/published-assets'; fs.mkdirSync(released,{recursive:true});
  gh('release','download',tag,'--repo',repo,...releaseFiles.flatMap(file=>['--pattern',file]),'--dir',released);
  for (const file of releaseFiles) fs.copyFileSync(path.join(released,file),path.join(assets,file));
} else {
  execFileSync(process.execPath,['tools/desktop/make-update-manifest.mjs',version,assets,commit],{stdio:'inherit'});
  if (existing) {
    // GitHub creates the tag only when publishing a new draft; retries must use its recorded target.
    if (existing.targetCommitish!==commit) throw new Error('Draft desktop release belongs to different source');
    gh('release','upload',tag,...releaseFiles.map(f=>path.join(assets,f)),'--repo',repo,'--clobber');
  } else gh('release','create',tag,...releaseFiles.map(f=>path.join(assets,f)),'--repo',repo,'--draft','--latest=false','--target',commit,'--title',`StudentBuddy Windows ${version}`,'--notes-file','tools/desktop/release-notes.md');
}
const envelope=JSON.parse(fs.readFileSync(path.join(assets,'update.json'),'utf8'));
const manifest=validateEnvelope(envelope,publicKey);
if (manifest.version!==version || manifest.sourceCommit!==commit) throw new Error('Published manifest source mismatch');
await verifyFile(path.join(assets,filename),manifest);
const {createHash}=await import('node:crypto');
const readerHash=createHash('sha256').update(fs.readFileSync(path.join(assets,readerZip))).digest('hex');
if(fs.readFileSync(path.join(assets,readerSum),'utf8').trim()!==`${readerHash}  ${readerZip}`)throw new Error('Reader archive checksum mismatch');
await preparePackage({version,assets,output:'.runtime/npm-package'});
const expected=JSON.parse(execFileSync('npm',['pack','--json'],{cwd:'.runtime/npm-package',encoding:'utf8'}))[0].integrity;
const view=spawnSync('npm',['view',`@llwand1/studentbuddy-windows@${version}`,'dist.integrity','--registry=https://npm.pkg.github.com'],{encoding:'utf8'});
if (view.status===0 && view.stdout.trim()) {
  if (view.stdout.trim()!==expected) throw new Error('Existing npm version differs from verified release');
} else {
  if (view.status!==0 && !/E404|404 Not Found/.test(view.stderr)) throw new Error('Cannot verify existing package version');
  execFileSync('npm',['publish','--registry=https://npm.pkg.github.com'],{cwd:'.runtime/npm-package',stdio:'inherit'});
}
gh('release','edit',tag,'--repo',repo,'--draft=false','--latest=false');
let channel;
try { channel=JSON.parse(gh('release','view','desktop-stable','--repo',repo,'--json','isDraft')); }
catch (e) { if (!/not found|404/i.test(String(e.stderr))) throw e; }
if (channel) {
  const oldDir='.runtime/previous-channel'; fs.mkdirSync(oldDir,{recursive:true});
  const result=spawnSync('gh',['release','download','desktop-stable','--repo',repo,'--pattern','update.json','--dir',oldDir],{encoding:'utf8'});
  if (result.status===0) {
    const old=validateEnvelope(JSON.parse(fs.readFileSync(path.join(oldDir,'update.json'),'utf8')),publicKey);
    if (compare(old.version,manifest.version)>0) throw new Error('Newer desktop already published; channel cannot move backwards');
    if (old.version===manifest.version && old.sha256!==manifest.sha256) throw new Error('Stable channel conflicts with immutable release');
  } else if (!/no assets|no matching|not found/i.test(result.stderr)) throw new Error('Cannot verify previous update channel');
} else gh('release','create','desktop-stable','--repo',repo,'--target',commit,'--prerelease','--latest=false','--title','StudentBuddy Windows 最新版','--notes','桌面自动更新通道。');
gh('release','upload','desktop-stable',path.join(assets,'update.json'),'--repo',repo,'--clobber');
const notes='.runtime/channel-notes.md';
fs.writeFileSync(notes,`最新版：**StudentBuddy Windows ${version}**\n\n[下载安装包](https://github.com/${repo}/releases/tag/${tag})\n\n应用会后台检测和准备新版，校验完成后提示重启更新。旧版 0.2.0 及更早版本需要手动安装一次带更新器的版本，学习数据会保留。\n`);
gh('release','edit','desktop-stable','--repo',repo,'--notes-file',notes,'--latest=false');
console.log(JSON.stringify({version,appVersion:manifest.appVersion,releasePublished:true,packagePublished:true,signedChannelAdvanced:true}));
