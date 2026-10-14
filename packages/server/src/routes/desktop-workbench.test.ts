import { afterAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const fixtures = path.resolve('.runtime'); fs.mkdirSync(fixtures, { recursive: true });
const base = fs.mkdtempSync(path.join(fixtures, 'sb-workbench-api-'));
process.env.SB_DATA_DIR = path.join(base, 'data'); process.env.SB_DESKTOP = '1'; process.env.SB_HOST = '127.0.0.1'; process.env.SB_DESKTOP_WORKSPACE_ROOT = path.join(base, 'workspace');
vi.mock('../ai/gateway.js', () => ({ aiText: async () => ({ok:true,text:'独立任务结果',model:'test',latencyMs:1}) }));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;
const origin='http://localhost:5173', route='/api/desktop/workbench';
afterAll(()=>{closeDb();delete process.env.SB_DESKTOP;delete process.env.SB_HOST;delete process.env.SB_DESKTOP_WORKSPACE_ROOT;if(path.dirname(base)!==fixtures)throw new Error('Fixture escaped test root');fs.rmSync(base,{recursive:true,force:true});});
it('exposes the task center only on the marked local desktop and rejects CSRF/extension write calls',async()=>{
  await request(app).get(route+'/state').set('Host','evil.example').expect(404);
  await request(app).post(route+'/files/write').send({path:'bad.txt',content:'bad'}).expect(403);
  await request(app).post(route+'/files/write').set('Origin','chrome-extension://'+'a'.repeat(32)).send({path:'bad.txt',content:'bad'}).expect(403);
  process.env.SB_DESKTOP='0';await request(app).get(route+'/state').expect(404);process.env.SB_DESKTOP='1';
});
it('real file API lists, reads, writes and blocks outside-workspace edits',async()=>{
  const state=await request(app).get(route+'/state').expect(200);expect(state.body.workspace.computerAccess).toBe('read_only');
  await request(app).post(route+'/files/write').set('Origin',origin).send({path:'note.txt',content:'笔记'}).expect(200);
  const read=await request(app).post(route+'/files/read').set('Origin',origin).send({path:'note.txt'}).expect(200);expect(read.body.text).toBe('笔记');
  const list=await request(app).post(route+'/files/list').set('Origin',origin).send({path:'.'}).expect(200);expect(list.body.some((e:{name:string})=>e.name==='note.txt')).toBe(true);
  await request(app).post(route+'/files/write').set('Origin',origin).send({path:path.join(base,'outside.txt'),content:'no'}).expect(400);
  expect(fs.existsSync(path.join(base,'outside.txt'))).toBe(false);
});
it('the API creates real independent agents and returns persistent details rather than fake client tasks',async()=>{
  const made=await request(app).post(route+'/tasks').set('Origin',origin).send({prompt:'帮我列出复习提纲',capability:'read_only'}).expect(202);
  await vi.waitFor(async()=>{const state=await request(app).get(route+'/tasks/'+made.body.id).expect(200);expect(state.body.run.status).toBe('completed');expect(state.body.run.result).toBe('独立任务结果');expect(state.body.events.length).toBeGreaterThan(0);});
  await request(app).get(route+'/tasks/missing').expect(404);
  await request(app).post(route+'/tasks').set('Origin',origin).send({prompt:'bad',capability:'all'}).expect(400);
});
