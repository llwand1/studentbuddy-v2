/**
 * routes — 薄路由层：参数校验 + 调 service，零业务逻辑（ADR-3）。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { getDb } from './storage/db.js';
import { handleMessage } from './chat/flow.js';
import { snapshot } from './chat/sse-bus.js';
import { subscribe, startHeartbeat } from './chat/sse-bus.js';
import { getProviders, seedIfEmpty, MODEL_ROLES } from './llm/router.js';
import { encryptSecret, decryptSecret, isEncrypted } from './storage/crypto.js';
import { searchWeb, listKeyStatus, saveProviderKey, KEYED_PROVIDERS } from './search/index.js';

// ── sessions ──────────────────────────────────────────────
export const sessionsRouter = Router();

sessionsRouter.get('/', (_req, res) => {
  const rows = getDb()
    .prepare(`SELECT id, title, pinned, created_at, updated_at FROM sessions WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC`)
    .all();
  res.json(rows);
});

sessionsRouter.post('/', (req: Request, res: Response) => {
  const id = randomUUID();
  getDb().prepare(`INSERT INTO sessions (id) VALUES (?)`).run(id);
  const row = getDb().prepare(`SELECT id, title, pinned, created_at, updated_at FROM sessions WHERE id = ?`).get(id);
  res.status(201).json(row);
});

sessionsRouter.delete('/:id', (req: Request, res: Response) => {
  getDb().prepare(`UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?`).run((req.params.id ?? ''));
  res.json({ ok: true });
});

sessionsRouter.get('/:id/messages', (req: Request, res: Response) => {
  const rows = getDb()
    .prepare(`SELECT id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at, rowid`)
    .all((req.params.id ?? ''));
  res.json(rows);
});

sessionsRouter.get('/:id/live', (req: Request, res: Response) => {
  res.json({ events: snapshot((req.params.id ?? '')) });
});

// ── chat（REST 发送 + SSE 流）──────────────────────────────
export const chatRouter = Router();

/** 进行中的会话中止器（sessionId → AbortController），POST abort 时触发 */
const aborters = new Map<string, AbortController>();

chatRouter.post('/send', (req: Request, res: Response) => {
  const { sessionId, text } = req.body as { sessionId?: string; text?: string };
  if (!sessionId || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'sessionId 与 text 必填' });
    return;
  }
  const controller = new AbortController();
  aborters.set(sessionId, controller);
  // 异步执行，立即返回（流式走 SSE）
  handleMessage({ sessionId, text, signal: controller.signal })
    .catch(() => undefined) // 异常经 sse-bus 上报，此处吞掉防 unhandled rejection
    .finally(() => {
    if (aborters.get(sessionId) === controller) aborters.delete(sessionId);
  });
  res.json({ ok: true });
});

chatRouter.post('/abort', (req: Request, res: Response) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (sessionId) aborters.get(sessionId)?.abort();
  res.json({ ok: true });
});

chatRouter.get('/stream', (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId ?? '');
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  const since = Number(req.query.since ?? 0) || 0;
  subscribe(sessionId, res, since);
});

// ── providers / 角色绑定 ──────────────────────────────────
export const providersRouter = Router();

providersRouter.get('/', (_req, res) => {
  seedIfEmpty();
  res.json(
    getProviders().map((p) => p), // api_key 密文永不出现在响应中
  );
});

providersRouter.post('/', (req: Request, res: Response) => {
  const { name, baseUrl, apiKey, type } = req.body as { name?: string; baseUrl?: string; apiKey?: string; type?: string };
  if (!name || !baseUrl) {
    res.status(400).json({ error: 'name 与 baseUrl 必填' });
    return;
  }
  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  getDb()
    .prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(id, name, baseUrl, encryptSecret(apiKey ?? ''), type === 'anthropic' ? 'anthropic' : 'openai');
  res.status(201).json({ id, name, baseUrl });
});

providersRouter.put('/:id', (req: Request, res: Response) => {
  const { name, baseUrl, apiKey, enabled } = req.body as { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean };
  const db = getDb();
  const cur = db.prepare('SELECT id FROM providers WHERE id = ?').get((req.params.id ?? '')) as { id: string } | undefined;
  if (!cur) {
    res.status(404).json({ error: 'provider 不存在' });
    return;
  }
  // apiKey 传空/缺省 = 不修改；传明文 = 更新密文（幂等：已是密文则原样）
  if (apiKey === undefined || apiKey === '') {
    db.prepare(`UPDATE providers SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), enabled = COALESCE(?, enabled) WHERE id = ?`)
      .run(name ?? null, baseUrl ?? null, enabled === undefined ? null : enabled ? 1 : 0, (req.params.id ?? ''));
  } else {
    db.prepare(`UPDATE providers SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), api_key = ?, enabled = COALESCE(?, enabled) WHERE id = ?`)
      .run(name ?? null, baseUrl ?? null, encryptSecret(apiKey), enabled === undefined ? null : enabled ? 1 : 0, (req.params.id ?? ''));
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

/** 开发辅助：验证密钥加解密往返（密文状态自查，不回显明文）。 */
providersRouter.get('/:id/key-status', (req: Request, res: Response) => {
  const row = getDb().prepare('SELECT api_key FROM providers WHERE id = ?').get((req.params.id ?? '')) as { api_key: string } | undefined;
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
