'use strict';
const {compare}=require('./update-core.cjs');
function selectDesktopVersion(base,floor,previous,commit) {
  let version=compare(floor,base)>0?floor:base;
  if(!previous)return version;
  if(previous.sourceCommit===commit)return previous.version;
  if(compare(version,previous.version)<=0){const parts=previous.version.split('.').map(Number);parts[2]++;version=parts.join('.');}
  return version;
}
module.exports={selectDesktopVersion};
