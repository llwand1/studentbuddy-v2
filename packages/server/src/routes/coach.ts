/**
 * routes/coach — 复习督促小窗路由（契约 `docs/COACH-SPEC.md`，v25）。
 *
 * 五个口 + 一条 SSE：
 *   GET  /state    快照 + 「该不该催」判定（胶囊与抽屉共用的唯一事实源）
 *   GET  /messages 卡片流水（AI 卡 / 我的卡 / 提醒卡 / 复习动作卡）
 *   POST /nudge    主动提醒：落一张提醒卡（**冷却在域层把**，冷却期内不落库）
 *   POST /send     发起一轮督促对话（流式走 SSE，ADR：POST 立即返回、正文走流，同 chat/send）
 *   POST /review   小窗内复习打卡（记得/忘了）→ 推进阶段 + 记一张动作卡
 *   GET  /stream   SSE（频道键 = `coach:<owner>`）
 *
 * ★ **为什么不复用 `/api/chat/*`**：聊天那条链路绑在 `sessions` 上（侧栏历史、上下文压缩、
 *   记忆抽取、工具循环全套），而督促小窗是**另一条链路**——它的上下文来自复习快照而非
 *   会话历史，它的流水也不该出现在侧栏「历史对话」里。硬塞进 sessions 会让两件事互相污染。
 *
 * ★ **频道隔离**：`coachChannel(ownerId)` 前缀是 `coach:`，与真实会话 id、PK 的 `pk:` 三者
 *   互不相通（v1 串台教训）。频道键由**请求方自己的 ownerId** 派生 ⇒ 天然只能订阅/发送
 *   自己的那条流，不需要（也没有）`canAccessSession` 那种跨表断言。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { coachChannel } from '@sb/shared';
import { ownerIdOf } from '../auth/ownership.js';
import { publish, snapshot, startNewRound, subscribe } from '../chat/sse-bus.js';
import {
  appendCard,
  coachMarkReviewed,
  coachState,
  generateCoachReply,
  listCoachCards,
  pushNudge,
} from '../learning/coach.js';

export const coachRouter = Router();

/** 进行中的督促生成（频道键 → 中止器）。键已含 owner 维度，故无需再存归属者。 */
const aborters = new Map<string, AbortController>();

/** `limit` 归一（路由只做参数校验与钳制，口径仍由域层决定，同 `pk/history.ts`） */
function limitOf(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

coachRouter.get('/state', (req: Request, res: Response) => {
  res.json(coachState(ownerIdOf(req)));
});

coachRouter.get('/messages', (req: Request, res: Response) => {
  const ownerId = ownerIdOf(req);
  // 顺带把快照带上：前端开抽屉只要一次往返就够渲染整屏（少一次 request = 少一次闪烁）
  res.json({ cards: listCoachCards(ownerId, limitOf(req.query.limit, 60)), snapshot: coachState(ownerId).snapshot });
});

coachRouter.post('/nudge', (req: Request, res: Response) => {
  const r = pushNudge(ownerIdOf(req));
  // `card: null` + reason 是**正常结果**（冷却期/无欠账），不是错误：前端据此保持安静
  res.json({ card: r.card, reason: r.reason });
});

coachRouter.post('/send', (req: Request, res: Response) => {
  const { text } = req.body as { text?: string };
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text 必填' });
    return;
  }
  const ownerId = ownerIdOf(req);
  const channel = coachChannel(ownerId);
  // 同一个人的上一轮还在跑就中止它：督促小窗是单流场景，允许"改口"（重发即打断）
  aborters.get(channel)?.abort();
  const meCard = appendCard(ownerId, 'me', text.trim());
  const controller = new AbortController();
  aborters.set(channel, controller);
  // ★ 清缓冲必须在下一次 publish 之前：SSE 的 seq 是**按轮**从 1 重新计数的，
  //   否则前端会因 seq 比本地小而去重掉整轮内容（表现为「发了没反应」）。
  startNewRound(channel);
  void (async () => {
    const r = await generateCoachReply({
      ownerId,
      text: text.trim(),
      signal: controller.signal,
      onToken: (chunk) => publish(channel, { type: 'token', sessionId: channel, content: chunk }),
    });
    // 失败也落一条 AI 卡：用户下次打开小窗能看到「上次为什么没回」（否则是一片空白，无从判断）
    if (!r.ok && r.error) {
      publish(channel, { type: 'chat-error', sessionId: channel, message: r.error });
      appendCard(ownerId, 'ai', `（没回上：${r.error}）`);
    } else if (r.text) {
      appendCard(ownerId, 'ai', r.text);
    }
    publish(channel, { type: 'done', sessionId: channel });
  })()
    .catch(() => undefined)
    .finally(() => {
      if (aborters.get(channel) === controller) aborters.delete(channel);
    });
  res.json({ ok: true, card: meCard });
});

coachRouter.post('/abort', (req: Request, res: Response) => {
  const channel = coachChannel(ownerIdOf(req)); // 频道键由自己的 owner 派生 ⇒ 只能中止自己的
  aborters.get(channel)?.abort();
  res.json({ ok: true });
});

coachRouter.post('/review', (req: Request, res: Response) => {
  const { termId, remembered } = req.body as { termId?: string; remembered?: boolean };
  if (!termId || typeof termId !== 'string') {
    res.status(400).json({ error: 'termId 必填' });
    return;
  }
  // ★ 与 `/api/terms/:id/review` 同一道校验：`remembered` 必须是真布尔。
  //   不校验的话 `'false'` / `0` 这类脏值会被下面 `=== true` 静默当成「忘了」，
  //   用户点的是「记住了」却看到归零——静默错语义比报错难查得多（同 term-review 的取舍）。
  if (typeof remembered !== 'boolean') {
    res.status(400).json({ error: 'remembered 必须是布尔值' });
    return;
  }
  const r = coachMarkReviewed(ownerIdOf(req), termId, remembered);
  if ('error' in r) {
    res.status(404).json({ error: r.error });
    return;
  }
  res.json({ card: r.card });
});

/** 断线重连后的快照对齐（SSE-CONTRACT「断线恢复」；与 chat 的 `/live` 同手法） */
coachRouter.get('/live', (req: Request, res: Response) => {
  res.json({ events: snapshot(coachChannel(ownerIdOf(req))) });
});

coachRouter.get('/stream', (req: Request, res: Response) => {
  const since = Number(req.query.since ?? 0) || 0;
  subscribe(coachChannel(ownerIdOf(req)), res, since);
});
