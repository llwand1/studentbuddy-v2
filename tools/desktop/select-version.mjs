import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const { FEED, fetchEnvelope, validateEnvelope } = require('./update-core.cjs');
const {selectDesktopVersion}=require('./version-policy.cjs');
const base = JSON.parse(fs.readFileSync('package.json','utf8')).version;
const commit = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const policy=JSON.parse(fs.readFileSync(new URL('./release-version.json',import.meta.url),'utf8'));
if(policy.schema!==1||typeof policy.minimumVersion!=='string')throw new Error('Invalid desktop release version policy');
let version = selectDesktopVersion(base,policy.minimumVersion,null,commit);
try {
  const envelope = await fetchEnvelope(FEED);
  const previous = validateEnvelope(envelope,fs.readFileSync(new URL('./update-public-key.pem',import.meta.url),'utf8'));
  if(previous.sourceCommit!==commit)execFileSync('git',['merge-base','--is-ancestor',previous.sourceCommit,commit]);
  version=selectDesktopVersion(base,policy.minimumVersion,previous,commit);
} catch (error) {
  if (!error.message.includes('Update feed HTTP 404')) throw error;
}
console.log(JSON.stringify({version,commit,appVersion:base}));
