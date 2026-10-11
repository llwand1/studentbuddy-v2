'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, verify } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');

const FEED = 'https://github.com/llwand1/studentbuddy-v2/releases/download/desktop-stable/update.json';
const RELEASES = 'https://github.com/llwand1/studentbuddy-v2/releases/download/';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function compare(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error('Invalid desktop version');
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path outside update directory');
  return path.resolve(file);
}
function validateEnvelope(envelope, publicKey, testOrigin) {
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'manifest,signature') throw new Error('Invalid update envelope');
  const m = envelope.manifest;
  const fields = ['schema','version','appVersion','architecture','sourceCommit','publishedAt','url','size','sha256'];
  if (!m || Object.keys(m).sort().join(',') !== fields.sort().join(',')) throw new Error('Invalid update manifest');
  if (m.schema !== 1 || !VERSION.test(m.version) || !VERSION.test(m.appVersion) || m.architecture !== 'windows-x64'
      || !/^[a-f0-9]{40}$/.test(m.sourceCommit) || !Number.isFinite(Date.parse(m.publishedAt))
      || !/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.size) || m.size < 1 || m.size > 512 * 1024 * 1024) throw new Error('Unsupported update manifest');
  const expected = `${RELEASES}desktop-v${m.version}/StudentBuddy-${m.version}-windows-x64-setup.exe`;
  if (m.url !== expected && !(testOrigin && m.url === `${testOrigin}/StudentBuddy-${m.version}-windows-x64-setup.exe`)) throw new Error('Untrusted installer URL');
  if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)
      || !verify(null, Buffer.from(JSON.stringify(m)), publicKey, Buffer.from(envelope.signature, 'base64'))) throw new Error('Update signature verification failed');
  return m;
}
async function readJson(file) { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
async function hashFile(file) {
  const hash = createHash('sha256');
  const handle = await fs.open(file, 'r');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}
async function verifyFile(file, manifest) {
  if ((await fs.stat(file)).size !== manifest.size || await hashFile(file) !== manifest.sha256) throw new Error('Installer SHA-256 verification failed');
}
async function fetchEnvelope(url, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent':'StudentBuddy-Desktop-Updater', 'Cache-Control':'no-cache' } });
  if (!response.ok) throw new Error(`Update feed HTTP ${response.status}`);
  let body = '';
  for await (const chunk of response.body) {
    body += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(body) > 16384) throw new Error('Update feed too large');
  }
  return JSON.parse(body);
}
async function download(url, file, manifest, fetcher = fetch) {
  try { await verifyFile(file, manifest); return; } catch { /* Re-download an absent or corrupt cache entry. */ }
  const partial = file + '.part';
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      const response = await fetcher(url, { signal:AbortSignal.timeout(120000), headers:{'User-Agent':'StudentBuddy-Desktop-Updater'} });
      if (!response.ok) throw new Error(`Installer download HTTP ${response.status}`);
      handle = await fs.open(partial, 'w');
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > manifest.size) throw new Error('Installer exceeds signed size');
        hash.update(chunk); await handle.writeFile(chunk);
      }
      await handle.close(); handle = null;
      if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('Installer SHA-256 verification failed');
      await fs.rename(partial, file); return;
    } catch (error) {
      if (handle) await handle.close();
      await fs.unlink(partial).catch(() => {});
      if (attempt === 2 || /SHA-256|signed size/.test(error.message)) throw error;
      await pause(500 * (attempt + 1));
    }
  }
}
function dataDir(env = process.env, home = os.homedir(), exists = require('node:fs').existsSync) {
  if (env.SB_DATA_DIR) return path.resolve(env.SB_DATA_DIR);
  const candidates = [env.APPDATA && path.join(env.APPDATA,'studentbuddy-v2'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA,'studentbuddy-v2'),
    path.join(home,'AppData','Roaming','studentbuddy-v2'), path.join(home,'studentbuddy-v2')].filter(Boolean);
  return candidates.find(dir => exists(path.join(dir,'studentbuddy.db'))) || candidates[0];
}
async function pruneCache(cache, current, root) {
  const candidates=[];
  for (const entry of await fs.readdir(cache,{withFileTypes:true})) {
    if (!entry.isDirectory() || !/^\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(entry.name)) continue;
    const dir=inside(cache,path.join(cache,entry.name));
    if (path.resolve(dir)===path.resolve(current)) continue;
    try {
      const job=await readJson(path.join(dir,'job.json'));
      if (path.resolve(job.root)!==path.resolve(root)) continue;
      const real=await fs.realpath(dir);
      inside(await fs.realpath(cache),real);
      if (real.toLowerCase()!==dir.toLowerCase()) continue;
      candidates.push({dir,updated:(await fs.stat(dir)).mtimeMs});
    } catch { /* Unknown or incomplete folders are never recursively removed. */ }
  }
  candidates.sort((a,b)=>b.updated-a.updated);
  for (const entry of candidates.slice(2)) {
    inside(cache,entry.dir);
    await fs.rm(entry.dir,{recursive:true,force:true});
  }
}
module.exports = { FEED, VERSION, compare, inside, validateEnvelope, readJson, hashFile, verifyFile, fetchEnvelope, download, dataDir, pruneCache };
