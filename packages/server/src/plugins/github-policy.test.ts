import { expect, it } from 'vitest';
import { enforceGithubRead } from './github-policy.js';
const base = {owner:'OWNER',repo:'Repo'};
it('accepts selected repository reads case-insensitively',()=>{
  expect(()=>enforceGithubRead('get_file_contents',{...base,path:'README.md'},['owner/repo'])).not.toThrow();
});
it.each(['create_issue','issue_write','create_pull_request','merge_pull_request','search_code','search_repositories','delete_file'])('rejects non-approved or cross-repository tools %s',tool=>{
  expect(()=>enforceGithubRead(tool,base,['owner/repo'])).toThrow();
});
it('rejects missing scope, deceptive repository name, and unapproved methods',()=>{
  for (const args of [{owner:'else',repo:'repo'}, {repo:'repo'}, {owner:'OWNER',repo:'Repo/../secret'}]) expect(()=>enforceGithubRead('get_file_contents',args,['owner/repo'])).toThrow();
  expect(()=>enforceGithubRead('issue_read',{...base,method:'create'},['owner/repo'])).toThrow();
  expect(()=>enforceGithubRead('actions_get',{...base,method:'download_workflow_run_artifact'},['owner/repo'])).toThrow();
  expect(()=>enforceGithubRead('pull_request_read',{...base,method:'get_diff'},['owner/repo'])).not.toThrow();
});
it('clamps by rejection rather than silently broadening malformed pagination',()=>{
  for (const perPage of [0,101,1.2,'100']) expect(()=>enforceGithubRead('list_issues',{...base,perPage},['owner/repo'])).toThrow();
});
it.each(['../other/repo','%2e%2e/secret','/repos/private/secret','README.md?other=repo'])('prevents downstream API path scope escape %s',path=>{
  expect(()=>enforceGithubRead('get_file_contents',{...base,path},['owner/repo'])).toThrow('相对路径');
});

