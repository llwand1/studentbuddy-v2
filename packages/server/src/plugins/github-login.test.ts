import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const fake = vi.hoisted(() => ({ spawned:0, stopped:0, fail:false, hold:false, calls:[] as string[] }));
vi.mock('./github-stdio.js', () => ({ GithubStdio:class {
  alive=true;
  constructor(){fake.spawned++;}
  async initialize(){}
  async tools(){return [{name:'get_file_contents',description:'read',inputSchema:{type:'object',properties:{owner:{type:'string'},repo:{type:'string'},path:{type:'string'}},required:['owner','repo','path']}}];}
  async call(name:string,_args:unknown,signal:AbortSignal){
    fake.calls.push(name);
    if(fake.hold) await new Promise<void>((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});if(signal.aborted)reject(new Error('stopped'));});
    if(fake.fail)throw new Error('secret authorization URL that must not escape');
    return {text:name==='get_me'?'{"login":"alice"}':name==='search_repositories'?'{"items":[{"full_name":"alice/project"}]}':'readme',ignoredBlocks:0};
  }
  stop(){this.alive=false;fake.stopped++;}
} }));
import { closeDb, openIsolated, getDb } from '../storage/db.js';
import { githubLoginState, startGithubLogin, stopGithubLogin, githubRepositoryChoices, selectGithubRepositories } from './github-login.js';
import { connection, disconnectPlugin } from './store.js';
import { invokePlugin, testPlugin } from './runtime.js';
import { pluginChatDefinitions } from './chat.js';
let dir='';
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-oauth-'));openIsolated(dir);fake.spawned=0;fake.stopped=0;fake.fail=false;fake.hold=false;fake.calls=[];});
afterEach(()=>{for(const owner of ['a','b',null])stopGithubLogin(owner);closeDb();fs.rmSync(dir,{recursive:true,force:true});});
async function connect(){startGithubLogin('a');await vi.waitFor(()=>expect(githubLoginState('a').status).toBe('connected'));}
it('browser login is owner-bound and helper tools cannot reach AI; selecting verified choices tests/enables without a token',async()=>{
  await connect();expect(githubLoginState('b').status).toBe('disconnected');expect(pluginChatDefinitions('a')).toEqual([]);
  const id=githubLoginState('a').id;
  await expect(githubRepositoryChoices('b',id,'')).rejects.toThrow('登录');
  expect(()=>selectGithubRepositories('a',id,['alice/project'])).toThrow('勾选');
  expect(await githubRepositoryChoices('a',id,'')).toEqual(['alice/project']);
  const saved=selectGithubRepositories('a',id,['alice/project']);expect(saved).toMatchObject({enabled:true,hasToken:false,authMode:'browser',repositories:['alice/project']});
  expect(saved.tools.map(t=>t.name)).toEqual(['get_file_contents']);
  expect((getDb().prepare("SELECT token FROM plugin_connection WHERE owner_id='a'").get() as {token:string}).token).toBe('');
  const result=await invokePlugin('github','get_file_contents',{owner:'alice',repo:'project',path:'README.md'},{ownerId:'a',onStep:()=>{}});
  expect(result.content).toContain('readme');
  await expect(invokePlugin('github','search_repositories',{query:'secret'},{ownerId:'a',onStep:()=>{}})).rejects.toThrow('白名单');
});
it('disconnect/new login invalidate stale selection and restart state never launches authorization from a chat tool',async()=>{
  await connect();const old=githubLoginState('a').id;await githubRepositoryChoices('a',old,'');selectGithubRepositories('a',old,['alice/project']);
  stopGithubLogin('a');expect(pluginChatDefinitions('a')).toEqual([]);
  await expect(invokePlugin('github','get_file_contents',{owner:'alice',repo:'project',path:'README.md'},{ownerId:'a',onStep:()=>{}})).rejects.toThrow('登录');
  for(let i=0;i<3;i++) await expect(testPlugin('a','github')).rejects.toThrow('登录');
  expect(fake.spawned).toBe(1);
  await connect();expect(()=>selectGithubRepositories('a',old,['alice/project'])).toThrow('过期');
  disconnectPlugin('a','github');expect(githubLoginState('a').status).toBe('disconnected');expect(connection('a','github').enabled).toBe(false);
});
it('cancels pending authorization and does not publish provider error/authorization URL',async()=>{
  fake.hold=true;startGithubLogin('a');await vi.waitFor(()=>expect(fake.calls).toContain('get_me'));
  stopGithubLogin('a');await Promise.resolve();expect(githubLoginState('a').status).toBe('disconnected');
  fake.hold=false;fake.fail=true;startGithubLogin('a');await vi.waitFor(()=>expect(githubLoginState('a').status).toBe('error'));
  expect(JSON.stringify(githubLoginState('a'))).not.toContain('secret authorization');
});
it('v62 migration preserves existing scope and is safe when the migration chain is replayed',async()=>{
  const db=getDb();db.exec("ALTER TABLE plugin_connection DROP COLUMN auth_mode; DELETE FROM schema_version WHERE version>=63; INSERT INTO plugin_connection(owner_id,plugin_id,manifest,repositories) VALUES('kept','github','{}','[\"kept/repo\"]')");
  const {migrate}=await import('../storage/migrations.js');migrate(db);migrate(db);
  expect(connection('kept','github')).toMatchObject({authMode:'token',repositories:['kept/repo']});
  db.exec('DELETE FROM schema_version WHERE version>=63');migrate(db);
  expect(connection('kept','github').repositories).toEqual(['kept/repo']);
});
