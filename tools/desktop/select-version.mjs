import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { FEED, fetchEnvelope, validateEnvelope, compare } = createRequire(import.meta.url)('./update-core.cjs');
const base = JSON.parse(fs.readFileSync('package.json','utf8')).version;
const commit = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
let version = base;
try {
  const envelope = await fetchEnvelope(FEED);
  const previous = validateEnvelope(envelope,fs.readFileSync(new URL('./update-public-key.pem',import.meta.url),'utf8'));
  if (previous.sourceCommit === commit) version = previous.version;
  else {
    execFileSync('git',['merge-base','--is-ancestor',previous.sourceCommit,commit]);
    if (compare(base,previous.version)<=0) {
      const parts = previous.version.split('.').map(Number); parts[2]++;
      version = parts.join('.');
    }
  }
} catch (error) {
  if (!error.message.includes('Update feed HTTP 404')) throw error;
}
console.log(JSON.stringify({version,commit,appVersion:base}));
