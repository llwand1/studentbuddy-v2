/** 设置页正常登录/Origin 通道管理凭证，不在开放 API 下暴露。 */
import { Router } from 'express';
import { ownerIdOf } from '../auth/ownership.js';
import { AgentKeyError, createAgentKey, listAgentKeys, revokeAgentKey } from '../auth/agent-keys.js';
export const agentKeysRouter = Router();
agentKeysRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
agentKeysRouter.get('/', (req, res) => { res.json({ keys: listAgentKeys(ownerIdOf(req)) }); });
agentKeysRouter.post('/', (req, res) => {
  try { res.status(201).json(createAgentKey(ownerIdOf(req), req.body)); }
  catch (error) {
    if (error instanceof AgentKeyError) res.status(error.status).json({ error: error.message });
    else res.status(500).json({ error: '创建密钥失败，请稍后重试。' });
  }
});
agentKeysRouter.delete('/:id', (req, res) => {
  if (!revokeAgentKey(ownerIdOf(req), req.params.id)) { res.status(404).json({ error: '密钥不存在。' }); return; }
  res.json({ ok: true });
});
