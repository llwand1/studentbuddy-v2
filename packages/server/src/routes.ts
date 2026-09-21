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
import { seedIfEmpty } from './llm/router.js';
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

// ── providers / 角色绑定已整段拆到 ./routes/providers.ts ──
// 本批（一键默认设置 + 免费额度查询）加两端点后 `routes.ts` 会越过 `server/.ts ≤400` 红线，
// 按仓规**拆文件不压注释**（同 settingsRouter 那次）。这里 re-export，
// 保住 `index.ts` 里 `app.use('/api/providers', providersRouter)` 零改动。
export { providersRouter } from './routes/providers.js';

// ── settings 路由已整段拆到 ./routes/settings.ts ──
// 本批（词条朗读）加三端点后 `routes.ts` 触 `server/.ts ≤400` 红线，按仓规**拆文件不压注释**。
// 这里 re-export，保住 `index.ts` 的 `app.use('/api/settings', settingsRouter)` 零改动。
export { settingsRouter } from './routes/settings.js';

export function initChatInfra(): void {
  seedIfEmpty();
  startHeartbeat();
}
