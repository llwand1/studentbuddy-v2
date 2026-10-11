import fs from 'node:fs';
import path from 'node:path';
import { createHash, sign, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateEnvelope } = require('./update-core.cjs');
const [version,assets,sourceCommit] = process.argv.slice(2);
const filename=`StudentBuddy-${version}-windows-x64-setup.exe`;
const bytes=fs.readFileSync(path.join(assets,filename));
const manifest={schema:1,version,appVersion:JSON.parse(fs.readFileSync('package.json','utf8')).version,architecture:'windows-x64',sourceCommit,
  publishedAt:new Date().toISOString(),url:`https://github.com/llwand1/studentbuddy-v2/releases/download/desktop-v${version}/${filename}`,size:bytes.length,
  sha256:createHash('sha256').update(bytes).digest('hex')};
const privateKey=process.env.DESKTOP_UPDATE_SIGNING_KEY;
if (!privateKey) throw new Error('Desktop update signing key is required');
const publicKey=fs.readFileSync(new URL('./update-public-key.pem',import.meta.url),'utf8');
if (createPublicKey(privateKey).export({type:'spki',format:'pem'})!==publicKey) throw new Error('Signing key does not match bundled updater key');
const envelope={manifest,signature:sign(null,Buffer.from(JSON.stringify(manifest)),privateKey).toString('base64')};
validateEnvelope(envelope,publicKey);
fs.writeFileSync(path.join(assets,'update.json'),JSON.stringify(envelope,null,2)+'\n');
console.log(JSON.stringify({version,appVersion:manifest.appVersion,size:manifest.size,signed:true}));
