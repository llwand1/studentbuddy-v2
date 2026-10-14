import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-plugin-api-'));process.env.SB_DATA_DIR=dir;
const stub=vi.hoisted(()=>({calls:0}));
vi.mock('../plugins/mcp-http.js',async(original)=>{
  const actual=await original<typeof import('../plugins/mcp-http.js')>();
  return {...actual,McpHttpClient:class {async initialize(){} async tools(){return [{name:'get_file_contents',description:'read',inputSchema:{type:'object'}}];} async call(){stub.calls++;return {text:'read',ignoredBlocks:0};}async close(){}}};
});
const {app}=await import('../index.js');
const {closeDb}=await import('../storage/db.js');
const {createUser}=await import('../auth/users.js');
const {createSession}=await import('../auth/session.js');
const {AUTH_COOKIE_NAME}=await import('@sb/shared');
const request=(await import('supertest')).default;
const origin='http://localhost:5173',base='/api/plugins';
afterAll(()=>{closeDb();fs.rmSync(dir,{recursive:true,force:true});});
it('protects writes with Origin and does not expose arbitrary invoke endpoints',async()=>{
  await request(app).put(base+'/github').send({token:'never save'}).expect(403);
  await request(app).post(base+'/github/test').set('Origin','https://evil.example').send({}).expect(403);
  await request(app).post(base+'/invoke').set('Origin',origin).send({}).expect(404);
});
it('isolates configured credentials and permissions between authenticated users and local owner',async()=>{
  const a=await createUser('plugin-a@example.com','good-password-1',undefined),b=await createUser('plugin-b@example.com','good-password-1',undefined);
  const cookie=(id:string)=>AUTH_COOKIE_NAME+'='+createSession(id).token;
  const ac=cookie(a.id),bc=cookie(b.id),token='github_pat_fixture_1234567890';
  await request(app).put(base+'/github').set('Origin',origin).set('Cookie',ac).send({token,repositories:['a/repo']}).expect(200);
  const tested=await request(app).post(base+'/github/test').set('Origin',origin).set('Cookie',ac).send({}).expect(200);
  expect(tested.body.tools).toHaveLength(1);expect(stub.calls).toBe(0);
  await request(app).put(base+'/github').set('Origin',origin).set('Cookie',ac).send({enabled:true}).expect(200);
  const mine=await request(app).get(base).set('Cookie',ac).expect(200);
  expect(mine.text).not.toContain(token);expect(mine.body.plugins[0].enabled).toBe(true);
  for(const c of [bc,'']) {const other=await request(app).get(base).set('Cookie',c).expect(200);expect(other.body.plugins[0]).toMatchObject({enabled:false,hasToken:false,repositories:[]});}
  await request(app).delete(base+'/github').set('Origin',origin).set('Cookie',ac).expect(400);
  await request(app).post(base+'/github/disconnect').set('Origin',origin).set('Cookie',ac).send({}).expect(200);
});
it('imports a declarative plugin disabled, enforces ownership on edit/removal and rejects unsafe manifests',async()=>{
  const manifest={schemaVersion:1,id:'remote-reader',name:'Reader',version:'1',description:'reader',transport:'streamable-http',endpoint:'https://mcp.example.com/mcp',tools:['read']};
  const made=await request(app).post(base+'/import').set('Origin',origin).send({manifest}).expect(201);
  expect(made.body.enabled).toBe(false);expect(made.body.policy).toBe('confirm_each_call');
  await request(app).post(base+'/import').set('Origin',origin).send({manifest:{...manifest,id:'unsafe',command:'node'}}).expect(400);
  await request(app).put(base+'/missing').set('Origin',origin).send({enabled:true}).expect(404);
  await request(app).delete(base+'/remote-reader').set('Origin',origin).expect(200);
});

