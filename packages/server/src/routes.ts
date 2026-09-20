/**
 * routes — 薄路由层：参数校验 + 调 service，零业务逻辑（ADR-3）。
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { getDb } from './storage/db.js';
import { cancelChoicesBySession } from './chat/choice.js';
import { cancelConfirmationsBySession } from './chat/tools/confirm.js';
import { snapshot, startHeartbeat } from './chat/sse-bus.js';
import { getProviders, seedIfEmpty, MODEL_ROLES } from './llm/router.js';
import { OpenAICompatibleAdapter } from './llm/openai.js';
import { AnthropicAdapter } from './llm/anthropic.js';
import { encryptSecret, decryptSecret, isEncrypted } from './storage/crypto.js';
import { ownerIdOf, ownerFilter, canAccessSession, sessionExists, insertSession } from './auth/ownership.js';
import { dropSessionMessages } from './search/fts-index.js';
import { normalizeFollowUpRequest } from '@sb/shared';
import { createFollowUpSession } from './chat/follow-up.js';
import { startFollowUpRun } from './routes/chat.js';

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
  // P3 同口：挂起的确认卡一并 deny 收口，且「本会话允许」授权表随会话清空（chat/tools/confirm.ts）。
  cancelChoicesBySession(id, '会话已删除');
  cancelConfirmationsBySession(id);
  getDb().prepare(`UPDATE sessions SET deleted_at = datetime('now') WHERE id = ?`).run(id);
  // ★ 搜索索引级联（契约 docs/FTS-SPEC.md §4 的 ★ 条目）：sessions 是**软删**
  //   （只置 `deleted_at`，messages 行原样留在库里），所以索引行不会随会话消失。
  //   不级联的后果是「删掉的会话，其消息仍能被搜出来」——那是隐私问题，不是体验问题。
  dropSessionMessages(id);
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
      `SELECT id, role, content, tool_calls, tool_call_id, reasoning, tasks, images, thinking_ms, duration_ms, created_at FROM messages WHERE session_id = ? ORDER BY created_at, rowid`,
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

/**
 * 「向 AI 追问」：从本会话**分叉**出一个专门深挖某个词条的新会话
 * （契约 `docs/KNOWLEDGE-FOLLOWUP-SPEC.md` §5）。
 *
 * ★ 归属断言**必须在归一之前**：不归属一律 404（与 sessions 域其余端点同口径）。
 *   反过来的话，一句超长的 `term` 会先吃到 400 —— 而那等于告诉未授权者
 *   「这个 id 是存在的，只是你参数写错了」（TENANCY-SPEC §5 要避免的泄露）。
 *
 * ★ 201 而不是 200：这条端点**确实创建了一个资源**（新会话），与 `POST /api/sessions` 同形。
 *   顺带起的这次生成是副作用，不改变"创建了什么"的语义。
 *
 * ★ 响应**不带 prompt**（首问正文）：它会作为该会话的第一条 user 消息被正常落库，
 *   前端切过去看历史就有了。在响应里再塞一份，等于给同一段文本造两个真相源。
 */
sessionsRouter.post('/:id/fork', (req: Request, res: Response) => {
  const parentId = req.params.id ?? '';
  const ownerId = ownerIdOf(req);
  if (!canAccessSession(parentId, ownerId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  // ★ 比同域其余端点**多一道存在性断言**：本端点要**落一行引用父会话的记录**（`forked_from_id`），
  //   而 `canAccessSession` 在未登录单人模式下不查库就放行 —— 不补这一道，
  //   `POST /api/sessions/<乱写的 id>/fork` 会返回 201 并留下一条指向虚空的 fork 记录
  //   （带着「追问：X」的标题挂在侧栏，用户删都删不明白）。只读端点不需要它（查不到就是空）。
  if (!sessionExists(parentId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const norm = normalizeFollowUpRequest(req.body);
  if (!norm.ok) {
    res.status(400).json({ error: norm.error });
    return;
  }
  const { result, prompt } = createFollowUpSession({
    parentSessionId: parentId,
    term: norm.value.term,
    question: norm.value.question,
    ownerId,
  });
  // 起流后再回响应：`startFollowUpRun` 是同步登记（不 await 生成），故响应不会被生成拖住
  startFollowUpRun({ sessionId: result.sessionId, prompt, ownerId });
  res.status(201).json(result);
});

// ── providers / 角色绑定（M2c：归属，契约 docs/TENANCY-SPEC.md §8.1）────────
export const providersRouter = Router();

/**
 * 这个 provider **能不能被当前请求改/删**？三态返回，因为三种情况的正确响应码不同。
 *
 * ★ **读口与写口刻意用不同判据**，这不是不一致，是两类操作的风险不同：
 *   · **读/用**（`llm/router.ts` 的 `providerById`）＝ `平台 OR 自己的` —— 平台 provider 对谁都可用，
 *     否则用户没法把角色绑到免费通道上，免费额度成摆设；
 *   · **写/删**（本函数）＝ **严格自己的** —— 用户改一次平台 provider 的 baseUrl，
 *     **全站所有人的模型都跟着变**（§8.1 原文：从「能改别人的」升级成「能改所有人的」）。
 * ★ 平台行对登录用户回 **403 而不是 404**：该 provider **本来就在他的列表里**（读口可见），
 *   装"不存在"是撒谎，也会让用户反复重试。而**别人的** provider 回 404——
 *   那是「这个 id 存在，只是不是你的」，与本仓 sessions 的口径一致（TENANCY-SPEC §5）。
 * ★ 本地单人模式（`owner === null`）可以改平台行：那时操作者**就是**平台自己。
 */
function editableProvider(id: string, owner: string | null): 'ok' | 'platform' | 'missing' {
  const row = getDb().prepare('SELECT owner_id FROM providers WHERE id = ?').get(id) as
    | { owner_id: string | null }
    | undefined;
  if (!row) return 'missing';
  if (row.owner_id === null) return owner === null ? 'ok' : 'platform';
  return row.owner_id === owner ? 'ok' : 'missing';
}

/** 写口守卫：不通过就直接回响应并返回 false（调用方据此 return）。 */
function guardEditable(res: Response, id: string, owner: string | null): boolean {
  const verdict = editableProvider(id, owner);
  if (verdict === 'platform') {
    res.status(403).json({ error: '平台服务商不可修改：它决定全站默认模型，改了会影响所有用户' });
    return false;
  }
  if (verdict === 'missing') {
    res.status(404).json({ error: 'provider 不存在' });
    return false;
  }
  return true;
}

providersRouter.get('/', (req: Request, res: Response) => {
  seedIfEmpty();
  // 内部已显式挑选出站字段（无 api_key），不必再 map 一层；归属过滤在 getProviders 里
  res.json(getProviders(ownerIdOf(req)));
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
  // ★ 新建的 provider 一律挂**当前用户**名下（未登录单人模式 ⇒ NULL = 平台自己的）
  getDb()
    .prepare(`INSERT INTO providers (id, name, base_url, api_key, type, enabled, stream_mode, owner_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, name, baseUrl, encryptSecret(apiKey ?? ''), t, mode, ownerIdOf(req));
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
  const id = req.params.id ?? '';
  if (!guardEditable(res, id, ownerIdOf(req))) return;
  const db = getDb();
  const mode = streamMode === 'stream' || streamMode === 'once' ? streamMode : null;
  // apiKey 传空/缺省 = 不修改；传明文 = 更新密文（幂等：已是密文则原样）
  if (apiKey === undefined || apiKey === '') {
    db.prepare(`UPDATE providers SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), stream_mode = COALESCE(?, stream_mode), enabled = COALESCE(?, enabled) WHERE id = ?`)
      .run(name ?? null, baseUrl ?? null, mode, enabled === undefined ? null : enabled ? 1 : 0, id);
  } else {
    db.prepare(`UPDATE providers SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), api_key = ?, stream_mode = COALESCE(?, stream_mode), enabled = COALESCE(?, enabled) WHERE id = ?`)
      .run(name ?? null, baseUrl ?? null, encryptSecret(apiKey), mode, enabled === undefined ? null : enabled ? 1 : 0, id);
  }
  res.json({ ok: true });
});

providersRouter.delete('/:id', (req: Request, res: Response) => {
  const id = req.params.id ?? '';
  const owner = ownerIdOf(req);
  if (!guardEditable(res, id, owner)) return;
  getDb().prepare('DELETE FROM providers WHERE id = ?').run(id);
  // ★ 兜底改绑**必须限定同一归属**：不加 `owner_id IS ?` 会跨用户改别人的绑定
  //   （删自己一个 provider，顺手把别人的模型指向 openai-default）。
  getDb()
    .prepare(`UPDATE role_bindings SET provider_id = 'openai-default' WHERE provider_id = ? AND owner_id IS ?`)
    .run(id, owner);
  res.json({ ok: true });
});

providersRouter.get('/roles', (req: Request, res: Response) => {
  seedIfEmpty();
  const owner = ownerIdOf(req);
  // 平台行 + 本人行，然后**同 role 合成一条 = 实际会生效的那条**（本人的覆盖平台的）。
  // ★ 为什么不把两组都回给前端让它自己挑：那等于把 `routeRole` 的查序在 UI 里抄第二遍，
  //   两处迟早不一致（本仓对"同一事实写两遍"付过多次学费）。这里回的就是**结果**。
  const rows = getDb()
    .prepare('SELECT owner_id, role, provider_id, model FROM role_bindings WHERE owner_id IS NULL OR owner_id = ?')
    .all(owner) as Array<{ owner_id: string | null; role: string; provider_id: string; model: string }>;
  const effective = new Map<string, { role: string; provider_id: string; model: string }>();
  for (const r of rows) {
    // 后写覆盖前写，但**只有"本人的行"允许覆盖**——平台行永远不覆盖已存在的条目。
    // 这样无论 SQL 返回的行序如何，结果都是"本人优先"，不依赖 ORDER BY。
    if (!effective.has(r.role) || r.owner_id !== null) {
      effective.set(r.role, { role: r.role, provider_id: r.provider_id, model: r.model });
    }
  }
  res.json({ roles: MODEL_ROLES, bindings: [...effective.values()] });
});

providersRouter.put('/roles/:role', (req: Request, res: Response) => {
  const { providerId, model } = req.body as { providerId?: string; model?: string };
  if (!providerId || !model) {
    res.status(400).json({ error: 'providerId 与 model 必填' });
    return;
  }
  const owner = ownerIdOf(req);
  // ★ 先验 provider **可见**（平台或自己的）再落库：不验的话，把 provider_id 写成别人的 id
  //   也能写进自己的绑定行——虽然 `routeRole` 的归属断言会让它取不到（不会泄露 key），
  //   但用户看到的是"绑定成功了、用起来却没生效"，一个自己造出来的幽灵。
  const visible = getDb()
    .prepare('SELECT id FROM providers WHERE id = ? AND (owner_id IS NULL OR owner_id IS ?)')
    .get(providerId, owner) as { id: string } | undefined;
  if (!visible) {
    res.status(400).json({ error: 'provider 不存在或不属于你' });
    return;
  }
  // ★ 两条写路径、两个冲突目标，**不能合并**：`ON CONFLICT` 必须命中一个真实的唯一约束。
  //   用户行命中复合 PK `(owner_id, role)`；平台行的 PK 在 SQLite 下对 NULL 不生效
  //   （见迁移 v29 注释），只能命中**部分唯一索引**，故冲突目标要带同样的 WHERE。
  if (owner === null) {
    getDb()
      .prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (NULL, ?, ?, ?)
                ON CONFLICT(role) WHERE owner_id IS NULL DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`)
      .run(req.params.role, providerId, model);
  } else {
    getDb()
      .prepare(`INSERT INTO role_bindings (owner_id, role, provider_id, model) VALUES (?, ?, ?, ?)
                ON CONFLICT(owner_id, role) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model`)
      .run(owner, req.params.role, providerId, model);
  }
  res.json({ ok: true });
});

/**
 * 模型列表（v13 接入半成品能力）：按 provider 类型实例化适配器，透传 baseUrl + 解密后的
 * apiKey 拉取该服务商的真实可用模型。失败返回空数组（前端保持手填输入框可用）。
 */
providersRouter.get('/:id/models', async (req: Request, res: Response) => {
  // ★ 归属用**读口判据**（平台 OR 自己的）：平台 provider 的模型列表必须可拉，
  //   否则用户把角色绑到免费通道时无法选择模型（绑定表单要靠它填下拉）。
  const row = getDb()
    .prepare('SELECT type, base_url, api_key FROM providers WHERE id = ? AND (owner_id IS NULL OR owner_id IS ?)')
    .get((req.params.id ?? ''), ownerIdOf(req)) as { type: string; base_url: string; api_key: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'provider 不存在' });
    return;
  }
  const adapter = row.type === 'anthropic' ? new AnthropicAdapter() : new OpenAICompatibleAdapter();
  const models = await adapter.listModels({ baseUrl: row.base_url, apiKey: decryptSecret(row.api_key) });
  res.json({ models });
});

/** 开发辅助：验证密钥加解密往返（密文状态自查，不回显明文）。 */
providersRouter.get('/:id/key-status', (req: Request, res: Response) => {  const row = getDb().prepare('SELECT api_key FROM providers WHERE id = ? AND (owner_id IS NULL OR owner_id IS ?)').get((req.params.id ?? ''), ownerIdOf(req)) as { api_key: string } | undefined;
  if (!row) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const roundtrip = row.api_key ? decryptSecret(row.api_key).length > 0 : true;
  res.json({ encrypted: isEncrypted(row.api_key), roundtrip });
});

// ── settings 路由已整段拆到 ./routes/settings.ts ──
// 本批（词条朗读）加三端点后 `routes.ts` 触 `server/.ts ≤400` 红线，按仓规**拆文件不压注释**。
// 这里 re-export，保住 `index.ts` 的 `app.use('/api/settings', settingsRouter)` 零改动。
export { settingsRouter } from './routes/settings.js';

export function initChatInfra(): void {
  seedIfEmpty();
  startHeartbeat();
}
