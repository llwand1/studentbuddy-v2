/**
 * routes/chat — 聊天域路由（REST 发起 + SSE 流 + 生成中止）。契约 docs/TENANCY-SPEC.md §5-§6。
 *
 * 2026-09-17 从 `routes.ts` 拆出：加完多租户归属断言后 `routes.ts` 涨到 487 行，
 * 触 AGENTS.md「.ts ≤400 行」红线。按本仓既有规矩（**按域再切，不压注释换行数**）把聊天域整段切出。
 *
 * ★ 本文件最要紧的一段是 `aborters`：**进程内存不随 SQL 的 `WHERE user_id = ?` 一起被过滤**，
 *   所以中止器必须自带 `ownerId` 维度，否则 `GET /active` 会把别人正在生成的会话 id 报出去。
 * ★ 生成状态的三条发起路径（send / regenerate / resend）共用 `trackRun` 登记与摘除——
 *   三份 finally 各写各的，迟早有一份忘记摘除（表现为「明明生成完了，侧栏还显示回复中」）。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { handleMessage } from '../chat/flow.js';
import { parseIncomingImages } from '../chat/vision.js';
import { planRegenerate } from '../chat/regenerate.js';
import { planResend } from '../chat/resend.js';
import { subscribe } from '../chat/sse-bus.js';
import { ownerIdOf, canAccessSession } from '../auth/ownership.js';
// ── chat（REST 发送 + SSE 流）──────────────────────────────
export const chatRouter = Router();

/**
 * 进行中的会话中止器（sessionId → 中止器 + 归属者），POST abort 时触发。
 *
 * ★ **必须带 `ownerId`**：这是**进程内存**，不随 SQL 的 `WHERE user_id = ?` 一起被过滤。
 *   只存 controller 的话，`GET /chat/active` 会把**别人正在生成的会话 id 也报出来**
 *   ——会话 id 属敏感标识，不该跨用户扩散（TENANCY-SPEC §6）。
 */
interface PendingRun {
  controller: AbortController;
  ownerId: string | null;
}
const aborters = new Map<string, PendingRun>();

/** 登记一次生成，并在收尾时摘除（三条发起路径共用，避免三份 finally 各写各的）。 */
function trackRun(
  sessionId: string,
  ownerId: string | null,
  controller: AbortController,
  run: () => Promise<unknown>,
): void {
  aborters.set(sessionId, { controller, ownerId });
  run()
    .catch(() => undefined) // 异常经 sse-bus 上报，此处吞掉防 unhandled rejection
    .finally(() => {
      if (aborters.get(sessionId)?.controller === controller) aborters.delete(sessionId);
    });
}

chatRouter.post('/send', (req: Request, res: Response) => {
  const { sessionId, text, images, grillMe, online } = req.body as {
    sessionId?: string;
    text?: string;
    images?: Array<{ dataUrl?: string; name?: string }>;
    grillMe?: boolean;
    online?: boolean;
  };
  // v17 看图：闸门在 chat/vision.ts；空提问＝「字和图都没有」（纯图片提问正当，别在这 400）
  const parsed = parseIncomingImages(images);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!sessionId || typeof text !== 'string' || (!text.trim() && parsed.images.length === 0)) {
    res.status(400).json({ error: 'sessionId 与 text 必填' });
    return;
  }
  const ownerId = ownerIdOf(req);
  if (!canAccessSession(sessionId, ownerId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const controller = new AbortController();
  // 异步执行，立即返回（流式走 SSE）
  trackRun(sessionId, ownerId, controller, () =>
    handleMessage({
      sessionId,
      text,
      images: parsed.images.length > 0 ? parsed.images : undefined,
      grillMe: grillMe === true,
      online: online === true,
      signal: controller.signal,
      ownerId,
    }),
  );
  res.json({ ok: true });
});

chatRouter.post('/regenerate', (req: Request, res: Response) => {
  const { sessionId, online } = req.body as { sessionId?: string; online?: boolean };
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  const ownerId = ownerIdOf(req);
  if (!canAccessSession(sessionId, ownerId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const plan = planRegenerate(sessionId);
  if (!plan.ok || !plan.text) {
    res.status(400).json({ error: plan.error ?? '无法重新生成' });
    return;
  }
  // 先收窄再进闭包：TS 不把对象属性的窄化带进回调（否则 `plan.text` 仍是 string|undefined）
  const prompt = plan.text;
  const controller = new AbortController();
  // skipUserPersist：提问仍在库里（planRegenerate 只删它之后的产物），不能再插一条
  trackRun(sessionId, ownerId, controller, () =>
    handleMessage({
      sessionId,
      text: prompt,
      online: online === true,
      signal: controller.signal,
      skipUserPersist: true,
      ownerId,
    }),
  );
  res.json({ ok: true });
});

/**
 * 编辑重发（v13 体验升级）：把最后一条提问改成新文案后重跑。
 * planResend 已删掉旧提问之后的全部产物并更新提问内容，故同样走 skipUserPersist。
 * 屏上同步口径由前端负责（与 regenerate 一致：保留最后一条提问及其之前）。
 */
chatRouter.post('/resend', (req: Request, res: Response) => {
  const { sessionId, text, online } = req.body as { sessionId?: string; text?: string; online?: boolean };
  if (!sessionId || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'sessionId 与 text 必填' });
    return;
  }
  const ownerId = ownerIdOf(req);
  if (!canAccessSession(sessionId, ownerId)) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const plan = planResend(sessionId, text);
  if (!plan.ok || !plan.text) {
    res.status(400).json({ error: plan.error ?? '无法编辑重发' });
    return;
  }
  const prompt = plan.text; // 同 regenerate：窄化不进闭包，先提出来
  const controller = new AbortController();
  trackRun(sessionId, ownerId, controller, () =>
    handleMessage({
      sessionId,
      text: prompt,
      online: online === true,
      signal: controller.signal,
      skipUserPersist: true,
      ownerId,
    }),
  );
  res.json({ ok: true });
});

chatRouter.post('/abort', (req: Request, res: Response) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) {
    res.json({ ok: true });
    return;
  }
  // ★ 只能中止自己的生成：别人的会话连"中止"都不该够得着（内存态不走 SQL 过滤，须显式判）
  const ownerId = ownerIdOf(req);
  const pending = aborters.get(sessionId);
  if (pending && (ownerId === null || pending.ownerId === ownerId)) pending.controller.abort();
  res.json({ ok: true });
});

/**
 * 正在生成回复的会话 id 列表（前端侧栏「回复中」提示的唯一事实源）。
 *
 * ★ 为什么这件事必须由服务端说：**生成不随页面切换而中止**——断开 SSE 只是在
 *   `sse-bus.subscribe` 的 `res.on('close')` 里把订阅者摘掉（实测该处只 `clients.delete`，
 *   不碰任何 AbortController），`handleMessage` 照跑照落库。而前端只能感知「当前挂载的那个会话」，
 *   一切走就再也无从知道原会话是否还在生成 ⇒ 只能问服务端。
 * ★ 为什么用 `aborters` 当真相：send / regenerate / resend 三条发起路径都在开跑前登记、
 *   在 `finally` 里摘除，它就是「正在生成」的完整集合，不需要再造一份状态（避免双真相源漂移）。
 * ★ 为什么不做成 SSE 事件：那要引入跨会话的全局频道，而本仓 sse-bus 的隔离设计正是
 *   「按 sessionId 分隔、禁通配订阅」（v1 串台教训）。为此破例不划算，2s 轮询足够。
 */
chatRouter.get('/active', (req: Request, res: Response) => {
  // ★ 只报自己的：会话 id 是敏感标识，不该跨用户扩散（TENANCY-SPEC §6）
  const ownerId = ownerIdOf(req);
  const ids =
    ownerId === null
      ? [...aborters.keys()]
      : [...aborters.entries()].filter(([, p]) => p.ownerId === ownerId).map(([id]) => id);
  res.json({ sessionIds: ids });
});

chatRouter.get('/stream', (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId ?? '');
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId 必填' });
    return;
  }
  if (!canAccessSession(sessionId, ownerIdOf(req))) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  const since = Number(req.query.since ?? 0) || 0;
  subscribe(sessionId, res, since);
});
