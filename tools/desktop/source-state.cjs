'use strict';
const {execFileSync,spawnSync}=require('node:child_process');
function sourceState(directory=process.cwd()) {
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:directory,encoding:'utf8'}).trim();
  const diff=spawnSync('git',['diff','--quiet','HEAD','--'],{cwd:directory,encoding:'utf8'});
  if(![0,1].includes(diff.status))throw new Error('Could not verify source content');
  const untracked=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{cwd:directory,encoding:'utf8'});
  return {sourceCommit,sourceDirty:diff.status===1||untracked.length>0};
}
module.exports={sourceState};
if(require.main===module)console.log(JSON.stringify(sourceState()));
