/**
 * routes — 薄路由层：参数校验 + 调 service，零业务逻辑（ADR-3）。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { getDb } from './storage/db.js';
import { cancelChoicesBySession } from './chat/choice.js';
import { snapshot, startHeartbeat } from './chat/sse-bus.js';
import { getProviders, seedIfEmpty, MODEL_ROLES } from './llm/router.js';
import { OpenAICompatibleAdapter } from './llm/openai.js';
import { AnthropicAdapter } from './llm/anthropic.js';
import { encryptSecret, decryptSecret, isEncrypted } from './storage/crypto.js';
import { searchWeb, listKeyStatus, saveProviderKey, KEYED_PROVIDERS } from './search/index.js';
import { loadQuizMix, saveQuizMix, loadQuizImage, saveQuizImage } from './learning/quiz.js';
import {
  loadAnswerStyle,
  saveAnswerStyle,
  resetAnswerStyle,
  isAnswerStyleConfigured,
} from './storage/answer-style.js';
import { DEFAULT_ANSWER_STYLE, normalizeQuizMix } from '@sb/shared';
import { ownerIdOf, ownerFilter, canAccessSession, insertSession } from './auth/ownership.js';

// ── sessions ──────────────────────────────────────────────
export const sessionsRouter = Router();

/**
 * ★ 多租户隔离（契约 docs/TENANCY-SPEC.md §5）：列表只返回**自己的**会话。
 *   未登录（单人本地模式，`ownerId === null`）时 `ownerFilter` 不加条件 ⇒ 旧行为不变。
 */
sessionsRouter.get('/', (req: Request, res: Response) => {
  const f = ownerFilter(ownerIdOf(req));
  const rows = getDb()
    .prepare(
      `SELECT id, title, pinned, created_at, updated_at FROM sessions WHERE deleted_at IS NULL${f.sql} ORDER BY pinned DESC, updated_at DESC`,
    )
    .all(...f.params);
  res.json(rows);
});

sessionsRouter.post('/', (req: Request, res: Response) => {
  const id = randomUUID();
  insertSession(id, ownerIdOf(req));
  const row = getDb().prepare(`SELECT id, title, pinned, created_at, updated_at FROM sessions WHERE id = ?`).get(id);
  res.status(201).json(row);
});

sessionsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = req.params.id ?? '';
  // ★ 归属断言在前：不归属一律 404（不回 403，避免泄露「这个 id 存在」，TENANCY-SPEC §5）
  if (!canAccessSession(id, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  // 逃生口②：删会话连带作废挂起的方案选择。会话都没了，那张卡再也无人能点，
  // 不作废则对应的 ask_choice 永久悬挂（与「停止生成」同源处置，见 chat/flow.ts）。
  cancelChoicesBySession(id, '会话已删除');
  getDb().prepare(`UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ ok: true });
});

sessionsRouter.patch('/:id/pinned', (req: Request, res: Response) => {
  const { pinned } = req.body as { pinned?: boolean };
  if (typeof pinned !== 'boolean') {
    res.status(400).json({ error: 'pinned 必须是布尔值' });
    return;
  }
  const f = ownerFilter(ownerIdOf(req));
  const r = getDb()
    .prepare(`UPDATE sessions SET pinned = ? WHERE id = ? AND deleted_at IS NULL${f.sql}`)
    .run(pinned ? 1 : 0, req.params.id ?? '', ...f.params);
  if (r.changes === 0) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ ok: true, pinned });
});

/**
 * 历史消息。
 * ★ 必须带上过程字段：`tool_calls`/`tool_call_id`（工具卡片）+ `reasoning`/`tasks`（思考与任务清单，
 * v11 起随消息落库）。这些是过程式 UI 唯一的持久化来源——少任何一列，前端重开会话就无法重建那部分过程
 * （数据在库里却被接口挡住）。前端负责把 tool 轮配对折成 steps（features/chat/history-fold.ts），
 * 本接口只做透传不加工。
 */
sessionsRouter.get('/:id/messages', (req: Request, res: Response) => {
  const id = req.params.id ?? '';
  // ★ 子表随父表：messages 没有 user_id 列，归属由父会话断言（TENANCY-SPEC §1）
  if (!canAccessSession(id, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const rows = getDb()
    .prepare(
      `SELECT id, role, content, tool_calls, tool_call_id, reasoning, tasks, images, created_at FROM messages WHERE session_id = ? ORDER BY created_at, rowid`,
    )
    .all(id);
  res.json(rows);
});

sessionsRouter.get('/:id/live', (req: Request, res: Response) => {
  const id = req.params.id ?? '';
  if (!canAccessSession(id, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ events: snapshot(id) });
});

// ── providers / 角色绑定 ──────────────────────────────────
export const providersRouter = Router();

providersRouter.get('/', (_req, res) => {
  seedIfEmpty();
  res.json(getProviders()); // 内部已显式挑选出站字段（无 api_key），不必再 map 一层
});

providersRouter.post('/', (req: Request, res: Response) => {
  const { name, baseUrl, apiKey, type, streamMode } = req.body as {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    type?: string;
    streamMode?: string;
  };
  if (!name || !baseUrl) {
    res.status(400).json({ error: 'name 与 baseUrl 必填' });
    return;
  }
  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const t = type === 'anthropic' ? 'anthropic' : 'openai';
  // stream_mode 缺省按 type 定位（池中=一次性，原生=流式）；显式传入则尊重
  const mode = streamMode === 'stream' || streamMode === 'once' ? streamMode : t === 'anthropic' ? 'stream' : 'once';
  getDb()
    .prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled, stream_mode) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .run(id, name, baseUrl, encryptSecret(apiKey ?? ''), t, mode);
  res.status(201).json({ id, name, baseUrl });
});

providersRouter.put('/:id', (req: Request, res: Response) => {
  const { name, baseUrl, apiKey, enabled, streamMode } = req.body as {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    enabled?: boolean;
    streamMode?: string;
  };
  const db = getDb();
  const cur = db.prepare('SELECT id FROM providers WHERE id = ?').get((req.params.id ?? '')) as { id: string } | undefined;
  if (!cur) {
    res.status(404).json({ error: 'provider 不存在' });
    return;
  }
  const mode = streamMode === 'stream' || streamMode === 'once' ? streamMode : null;
  // apiKey 传空/缺省 = 不修改；传明文 = 更新密文（幂等：已是密文则原样）
  if (apiKey === undefined || apiKey === '') {
    db.prepare(`UPDATE providers SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), stream_mode = COALESCE(?, stream_mode), enabled = COALESCE(?, enabled) WHERE id = ?`)
      .run(name ?? null, baseUrl ?? null, mode, enabled === undefined ? null : enabled ? 1 : 0, (req.params.id ?? ''));
  } else {
    db.prepare(`UPDATE providers SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), api_key = ?, stream_mode = COALESCE(?, stream_mode), enabled = COALESCE(?, enabled) WHERE id = ?`)
      .run(name ?? null, baseUrl ?? null, encryptSecret(apiKey), mode, enabled === undefined ? null : enabled ? 1 : 0, (req.params.id ?? ''));
  }
  res.json({ ok: true });
});

providersRouter.delete('/:id', (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM providers WHERE id = ?').run((req.params.id ?? ''));
  getDb().prepare(`UPDATE role_bindings SET provider_id = 'openai-default' WHERE provider_id = ?`).run((req.params.id ?? ''));
  res.json({ ok: true });
});

providersRouter.get('/roles', (_req, res) => {
  seedIfEmpty();
  const rows = getDb().prepare('SELECT role, provider_id, model FROM role_bindings').all();
  res.json({ roles: MODEL_ROLES, bindings: rows });
});

providersRouter.put('/roles/:role', (req: Request, res: Response) => {
  const { providerId, model } = req.body as { providerId?: string; model?: string };
  if (!providerId || !model) {
    res.status(400).json({ error: 'providerId 与 model 必填' });
    return;
  }
  getDb()
    .prepare(`INSERT INTO role_bindings (role, provider_id, model) VALUES (?, ?, ?) ON CONFLICT(role) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`)
    .run(req.params.role, providerId, model);
  res.json({ ok: true });
});

/**
 * 模型列表（v13 接入半成品能力）：按 provider 类型实例化适配器，透传 baseUrl + 解密后的
 * apiKey 拉取该服务商的真实可用模型。失败返回空数组（前端保持手填输入框可用）。
 */
providersRouter.get('/:id/models', async (req: Request, res: Response) => {
  const row = getDb()
    .prepare('SELECT type, base_url, api_key FROM providers WHERE id = ?')
    .get((req.params.id ?? '')) as { type: string; base_url: string; api_key: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'provider 不存在' });
    return;
  }
  const adapter = row.type === 'anthropic' ? new AnthropicAdapter() : new OpenAICompatibleAdapter();
  const models = await adapter.listModels({ baseUrl: row.base_url, apiKey: decryptSecret(row.api_key) });
  res.json({ models });
});

/** 开发辅助：验证密钥加解密往返（密文状态自查，不回显明文）。 */
providersRouter.get('/:id/key-status', (req: Request, res: Response) => {  const row = getDb().prepare('SELECT api_key FROM providers WHERE id = ?').get((req.params.id ?? '')) as { api_key: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const roundtrip = row.api_key ? decryptSecret(row.api_key).length > 0 : true;
  res.json({ encrypted: isEncrypted(row.api_key), roundtrip });
});

// ── settings（搜索 key：密文落库，响应只回状态）──────────────
export const settingsRouter = Router();

settingsRouter.get('/search-keys', (_req, res) => {
  res.json({ configured: listKeyStatus() });
});

settingsRouter.put('/search-keys', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const patch: Array<{ key: (typeof KEYED_PROVIDERS)[number]; value: string }> = [];
  for (const key of KEYED_PROVIDERS) {
    const value = body[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 300) {
      res.status(400).json({ error: `${key} key 过长（上限 300 字符）` });
      return;
    }
    patch.push({ key, value: trimmed });
  }
  // 先全量校验再落库：避免一个字段超限导致半写状态
  for (const item of patch) saveProviderKey(item.key, item.value);
  res.json({ ok: true, configured: listKeyStatus() });
});

// ── settings：出题题型配比（全局一份，对话页「出题」与题库页「一键出题」共用）──
settingsRouter.get('/quiz-mix', (_req, res) => {
  res.json({ mix: loadQuizMix() });
});

settingsRouter.put('/quiz-mix', (req: Request, res: Response) => {
  // 入参一律过归一化（负数/小数/超上限/全 0 都有既定归宿），落库即干净值
  const mix = saveQuizMix(normalizeQuizMix((req.body as { mix?: unknown }).mix));
  res.json({ ok: true, mix });
});

// ── settings：出题配图开关（契约 docs/QUIZ-IMAGE-SPEC.md §2.2）──
settingsRouter.get('/quiz-image', (_req, res) => {
  res.json({ on: loadQuizImage() });
});

settingsRouter.put('/quiz-image', (req: Request, res: Response) => {
  // 只认真值，其余一律按关处理（saveQuizImage 内归一化）
  const on = saveQuizImage((req.body as { on?: unknown }).on === true);
  res.json({ ok: true, on });
});

// ── settings：回答方式偏好（契约 docs/ANSWER-STYLE-SPEC.md §2）──
settingsRouter.get('/answer-style', (_req, res) => {
  // configured 是 L1 的开关量：没配过 与 配成默认值 在 style 上看不出区别
  res.json({ style: loadAnswerStyle(), configured: isAnswerStyleConfigured() });
});

settingsRouter.put('/answer-style', (req: Request, res: Response) => {
  // 入参逐字段过归一化（非法/缺失各自回落默认，不 400），回读的是实际落库值
  const style = saveAnswerStyle((req.body as { style?: unknown }).style);
  res.json({ style, configured: true });
});

settingsRouter.delete('/answer-style', (_req, res) => {
  // 删键＝回到「没配过」：下次点出题会重新弹一次选项卡
  resetAnswerStyle();
  res.json({ style: { ...DEFAULT_ANSWER_STYLE }, configured: false });
});

/** 搜索连通性自检：真发一次（国产网络可用性必须实测，不接受纸面判断；绕缓存才叫自检）。 */
settingsRouter.post('/search/test', async (req: Request, res: Response) => {
  const query = String((req.body as { query?: unknown }).query ?? '学习 方法').slice(0, 80);
  try {
    const { results, providers, failed } = await searchWeb(query, { skipCache: true });
    res.json({ ok: results.length > 0, count: results.length, providers, failed });
  } catch (err) {
    res.json({ ok: false, count: 0, providers: [], failed: [err instanceof Error ? err.message : String(err)] });
  }
});

export function initChatInfra(): void {
  seedIfEmpty();
  startHeartbeat();
}
