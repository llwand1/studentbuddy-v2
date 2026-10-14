import { Router, type Request, type Response, type RequestHandler } from 'express';
import { asyncHandler } from '../http/async-handler.js';
import { objectValue } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';
import { connection, deletePlugin, disconnectPlugin, importPlugin, listPlugins, pluginCalls, updatePlugin } from '../plugins/store.js';
import { invokePlugin, testPlugin } from '../plugins/runtime.js';
import { loadBilibiliVideo, parseVideoNotes, saveBilibiliVideo, videoAddress } from '../plugins/bilibili-material.js';
import { openBilibiliBrowser } from '../desktop/browser-launch.js';
import { desktopGuard } from './desktop.js';
import { githubLoginState, startGithubLogin, stopGithubLogin, githubRepositoryChoices, selectGithubRepositories } from '../plugins/github-login.js';
export const pluginsRouter = Router();
pluginsRouter.get('/',(req,res)=>res.json({plugins:listPlugins(ownerIdOf(req))}));
pluginsRouter.get('/calls',(req,res)=>res.json({calls:pluginCalls(ownerIdOf(req))}));
type Handler = (req: Request, res: Response) => unknown;
function handle(fn: Handler): RequestHandler {
  return asyncHandler((req,res) => Promise.resolve().then(()=>fn(req,res)).catch((e: unknown)=>{
    if (!res.headersSent && !res.destroyed) res.status(e instanceof Error && e.message === '插件不存在' ? 404 : 400)
      .json({error:e instanceof Error ? e.message : '插件操作失败'});
  }));
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
pluginsRouter.get('/bilibili/learning',handle((req,res)=>res.json({video:loadBilibiliVideo(ownerIdOf(req))})));
pluginsRouter.post('/bilibili/notes',handle((req,res)=>{
  const owner=ownerIdOf(req), input=objectValue(req.body as unknown), video=loadBilibiliVideo(owner);
  if(typeof input.notes!=='string')throw new Error('请提交字幕 / 笔记文本，清空时显式提交空字符串');
  if (!connection(owner,'bilibili').enabled || !video || videoAddress(input.url,owner).bvid!==video.bvid) throw new Error('视频未启用或已切换，请重新选择');
  const updated={...video,notes:parseVideoNotes(input.notes),selectedAt:Date.now()};
  saveBilibiliVideo(owner,updated);res.json(updated);
}));
pluginsRouter.post('/bilibili/open',desktopGuard,handle(async(req,res)=>{await openBilibiliBrowser(ownerIdOf(req));res.json({ok:true});}));
pluginsRouter.post('/bilibili/use',handle(async(req,res)=>{
  const input=objectValue(req.body as unknown);
  if (typeof input.tool !== 'string') throw new Error('请指定 B站学习工具');
  const controller=new AbortController(), cancel=()=>{if(!res.writableEnded)controller.abort();};
  res.on('close',cancel);
  try {
    const result=await invokePlugin('bilibili',input.tool,input.arguments,{ownerId:ownerIdOf(req),signal:controller.signal,onStep:()=>{}});
    res.json(JSON.parse(result.content.slice(result.content.indexOf('\n')+1)) as unknown);
  } finally {res.off('close',cancel);}
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

