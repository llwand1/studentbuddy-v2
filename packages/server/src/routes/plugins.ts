import { Router, type Request, type Response } from 'express';
import { objectValue } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';
import { deletePlugin, disconnectPlugin, importPlugin, listPlugins, pluginCalls, updatePlugin } from '../plugins/store.js';
import { testPlugin } from '../plugins/runtime.js';
import { desktopGuard } from './desktop.js';
import { githubLoginState, startGithubLogin, stopGithubLogin, githubRepositoryChoices, selectGithubRepositories } from '../plugins/github-login.js';
export const pluginsRouter = Router();
pluginsRouter.get('/',(req,res)=>res.json({plugins:listPlugins(ownerIdOf(req))}));
pluginsRouter.get('/calls',(req,res)=>res.json({calls:pluginCalls(ownerIdOf(req))}));
type Handler = (req: Request, res: Response) => unknown;
function handle(fn: Handler): Handler {
  return (req,res) => Promise.resolve().then(()=>fn(req,res)).catch((e: unknown)=>{
    if (!res.headersSent && !res.destroyed) res.status(e instanceof Error && e.message === '插件不存在' ? 404 : 400)
      .json({error:e instanceof Error ? e.message : '插件操作失败'});
  });
}
pluginsRouter.post('/import',handle((req,res)=>{
  const value = objectValue(req.body as unknown);
  res.status(201).json(importPlugin(ownerIdOf(req),value.manifest));
}));
pluginsRouter.get('/github/login', desktopGuard, handle((req,res)=>res.json(githubLoginState(ownerIdOf(req)))));
pluginsRouter.post('/github/connect', desktopGuard, handle((req,res)=>res.json(startGithubLogin(ownerIdOf(req)))));
pluginsRouter.post('/github/cancel', desktopGuard, handle((req,res)=>{
  stopGithubLogin(ownerIdOf(req)); res.json(disconnectPlugin(ownerIdOf(req),'github'));
}));
pluginsRouter.post('/github/repositories', desktopGuard, handle(async(req,res)=>{
  const args=objectValue(req.body as unknown);
  if (typeof args.id !== 'string' || typeof args.query !== 'string' || args.query.length>100) throw new Error('仓库查询参数不正确');
  res.json({repositories:await githubRepositoryChoices(ownerIdOf(req),args.id,args.query)});
}));
pluginsRouter.post('/github/select', desktopGuard, handle((req,res)=>{
  const args=objectValue(req.body as unknown); if (typeof args.id !== 'string') throw new Error('登录标识不正确');
  res.json(selectGithubRepositories(ownerIdOf(req),args.id,args.repositories));
}));
pluginsRouter.put('/:id',handle((req,res)=>res.json(updatePlugin(ownerIdOf(req),req.params.id!,objectValue(req.body as unknown)))));
pluginsRouter.post('/:id/test',handle(async(req,res)=>{
  const controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close',cancel);
  try { res.json(await testPlugin(ownerIdOf(req),req.params.id!,controller.signal)); }
  finally { res.off('close',cancel); }
}));
pluginsRouter.post('/:id/disconnect',handle((req,res)=>res.json(disconnectPlugin(ownerIdOf(req),req.params.id!))));
pluginsRouter.delete('/:id',handle((req,res)=>{deletePlugin(ownerIdOf(req),req.params.id!);res.json({ok:true});}));

