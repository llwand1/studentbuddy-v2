'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const { compare, validateEnvelope, download, verifyFile, inside, dataDir, pruneCache } = require('./update-core.cjs');
const { snapshotDatabase, restoreDatabase } = require('./update-client.cjs');
const keys = generateKeyPairSync('ed25519');
function fixture(extra = {}) {
  const bytes = Buffer.from('verified installer fixture');
  const manifest = { schema:1,version:'0.2.182',appVersion:'0.2.182',architecture:'windows-x64',sourceCommit:'a'.repeat(40),publishedAt:'2026-10-11T00:00:00Z',
    url:'https://github.com/llwand1/studentbuddy-v2/releases/download/desktop-v0.2.182/StudentBuddy-0.2.182-windows-x64-setup.exe',size:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),...extra };
  return {bytes,envelope:{manifest,signature:sign(null,Buffer.from(JSON.stringify(manifest)),keys.privateKey).toString('base64')}};
}
test('signed desktop updates reject tampering, wrong keys, website versions and foreign installer hosts', () => {
  const {envelope}=fixture(); assert.equal(validateEnvelope(envelope,keys.publicKey).version,'0.2.182');
  assert.throws(()=>validateEnvelope({...envelope,manifest:{...envelope.manifest,version:'9.0.0'}},keys.publicKey));
  assert.throws(()=>validateEnvelope(envelope,generateKeyPairSync('ed25519').publicKey),/signature/);
  for (const extra of [{version:'v0.2.182'},{architecture:'linux-x64'},{url:'https://evil.example/installer.exe'},{size:0},{url:'https://github.com/llwand1/studentbuddy-v2/releases/download/v0.2.182/installer.exe'}]) {
    assert.throws(()=>validateEnvelope(fixture(extra).envelope,keys.publicKey));
  }
  assert.throws(()=>validateEnvelope({...envelope,command:'execute'},keys.publicKey));
});
test('numeric version comparison never upgrades to an older or equal desktop version', () => {
  assert.equal(compare('0.2.182','0.2.9'),1); assert.equal(compare('0.2.182','0.2.182'),0);
  assert.equal(compare('0.2.9','0.2.182'),-1); assert.throws(()=>compare('0.2.182-beta','0.2.182'));
});
test('downloads verify signed size and hash; corrupt cached installers are replaced', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sb-update-'));
  const {bytes,envelope:{manifest}}=fixture(); const file=path.join(root,'setup.exe');
  let calls=0; const network=async()=>{calls++;return new Response(bytes);};
  try {
    await download(manifest.url,file,manifest,network); await verifyFile(file,manifest);
    await download(manifest.url,file,manifest,network); assert.equal(calls,1);
    await fs.writeFile(file,'corrupt'); await download(manifest.url,file,manifest,network); assert.equal(calls,2);
    const wrong={...manifest,sha256:'0'.repeat(64)};
    await assert.rejects(download(manifest.url,path.join(root,'bad.exe'),wrong,network),/SHA-256/);
    await assert.rejects(fs.stat(path.join(root,'bad.exe')),{code:'ENOENT'});
    await assert.rejects(fs.stat(path.join(root,'bad.exe.part')),{code:'ENOENT'});
    await assert.rejects(download(manifest.url,path.join(root,'long.exe'),{...manifest,size:2},network),/signed size/);
  } finally { inside(os.tmpdir(),root); await fs.rm(root,{recursive:true,force:true}); }
});
test('cold DB and WAL backup restore together after a failed upgrade', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sb-db-backup-')); const backup=path.join(root,'backup');
  try {
    await fs.writeFile(path.join(root,'studentbuddy.db'),'old db'); await fs.writeFile(path.join(root,'studentbuddy.db-wal'),'old wal');
    const files=await snapshotDatabase(root,backup);
    await fs.writeFile(path.join(root,'studentbuddy.db'),'new schema'); await fs.writeFile(path.join(root,'studentbuddy.db-wal'),'new wal');
    await fs.writeFile(path.join(root,'studentbuddy.db-shm'),'stale shared memory');
    await restoreDatabase(root,backup,files);
    assert.equal(await fs.readFile(path.join(root,'studentbuddy.db'),'utf8'),'old db');
    assert.equal(await fs.readFile(path.join(root,'studentbuddy.db-wal'),'utf8'),'old wal');
    await assert.rejects(fs.stat(path.join(root,'studentbuddy.db-shm')),{code:'ENOENT'});
  } finally { inside(os.tmpdir(),root); await fs.rm(root,{recursive:true,force:true}); }
});
test('backup and cache stay in their intended directories; data resolution finds the existing library', () => {
  assert.throws(()=>inside('/safe/cache','/safe/cache/../../other')); assert.throws(()=>inside('/safe/cache','/safe/cache'));
  assert.equal(dataDir({APPDATA:'/roaming',LOCALAPPDATA:'/local'},'/home',p=>p===path.join('/local','studentbuddy-v2','studentbuddy.db')),path.join('/local','studentbuddy-v2'));
  assert.equal(dataDir({SB_DATA_DIR:'/custom'},'/home'),path.resolve('/custom'));
});
test('cache pruning keeps current and recent recovery folders without deleting unrelated content', async () => {
  const cache=await fs.mkdtemp(path.join(os.tmpdir(),'sb-prune-'));
  try {
    const root=path.join(cache,'installed-app'), current=path.join(cache,'0.2.9-aaaaaaaaaaaa');
    for(let n=1;n<=4;n++) {
      const dir=path.join(cache,`0.2.${n}-aaaaaaaaaaaa`);await fs.mkdir(dir);
      await fs.writeFile(path.join(dir,'job.json'),JSON.stringify({root}));await fs.utimes(dir,n,n);
    }
    await fs.mkdir(current);const foreign=path.join(cache,'0.2.0-bbbbbbbbbbbb');await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign,'job.json'),JSON.stringify({root:'/another-app'}));
    await pruneCache(cache,current,root);
    await fs.stat(current);await fs.stat(foreign);await fs.stat(path.join(cache,'0.2.4-aaaaaaaaaaaa'));await fs.stat(path.join(cache,'0.2.3-aaaaaaaaaaaa'));
    await assert.rejects(fs.stat(path.join(cache,'0.2.1-aaaaaaaaaaaa')),{code:'ENOENT'});
  } finally { inside(os.tmpdir(),cache);await fs.rm(cache,{recursive:true,force:true}); }
});
