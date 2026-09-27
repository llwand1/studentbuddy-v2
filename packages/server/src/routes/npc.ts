/**
 * routes/npc — 学习伙伴（NPC）的 HTTP 出口（契约 `docs/NPC-PARTNER-SPEC.md` §7.1）。
 *
 * ★ **独立前缀 `/api/npc`，不挂进 `/api/cards`**：那边是**玩法读数**（卡数/钥匙/清单），
 *   这边是**地图上的人**（他是谁、在哪、说什么、拿什么换）。写侧权力也不同——这里只有
 *   改名 / 交换两条会写库，混在一起后想给伙伴单独限流或灰度就没有落点。
 * ★ 位置与遇险结论**都由服务端给**（`learning/npc.ts`），前端不重算铺格/领地：
 *   双份口径的开端就是「图上画着伙伴遇险、任务清单里没有那单」。
 * ★ **不新增 SSE 事件**（§7.1）：求救单的到达走既有 `task_dispatched`，前端读 `/api/cards/state` 即可。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ownerIdOf } from '../auth/ownership.js';
import { npcList, npcTrade, savePartnerName } from '../learning/npc.js';
import { npcTalk } from '../learning/npc-talk.js';

export const npcRouter = Router();

/** 一次读全：伙伴名单 + 数量上界 + 今天还能换几次（★ 含遇险结论，前端不重算） */
npcRouter.get('/', (req: Request, res: Response) => {
  res.json(npcList(ownerIdOf(req)));
});

/** 给主伙伴起名（宣传点「创建你的 AI 学习伙伴」的落点）。空串 ⇒ 删键回默认名 */
npcRouter.put('/partner', (req: Request, res: Response) => {
  const { name } = req.body as { name?: unknown };
  if (typeof name !== 'string') {
    res.status(400).json({ error: 'name 必须是字符串（空串表示恢复默认名）' });
    return;
  }
  const ownerId = ownerIdOf(req);
  const saved = savePartnerName(ownerId, name);
  // 恢复默认时把**当前**默认名回给前端，它就不用再拉一次 `/api/npc`
  res.json({ partnerName: saved || (npcList(ownerId).npcs[0]?.name ?? '') });
});

/**
 * 跟一位伙伴说句话。★ 无 key 时 **200 + `source:'fallback'`**，不 5xx、不空串（§4.2）——
 * 换言之：这条端点**没有失败态**（除了入参错与伙伴不存在），这本身就是契约要的行为。
 */
npcRouter.post('/:id/talk', async (req: Request, res: Response) => {
  const ownerId = ownerIdOf(req);
  const { text } = req.body as { text?: unknown };
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text 必填' });
    return;
  }
  const npc = npcList(ownerId).npcs.find((n) => n.id === (req.params.id ?? ''));
  if (!npc) {
    res.status(404).json({ error: '这位伙伴不在大陆上，刷新一下地图' });
    return;
  }
  const asked = text.trim();
  // 降级台词的轮换种子 = 本轮输入长度（没有伙伴消息表，拿不到真正的"第几轮"）
  res.json(await npcTalk({ ownerId, npc, text: asked, seed: asked.length }));
});

/**
 * 交换：拿一条自己的信物卡（★1 以上）换一条同领域没见过的新词。
 * ★ 回收下走**既有** `POST /api/cards/chest/accept`（两枚钮一字不改），所以这里只回 `draw`。
 */
npcRouter.post('/:id/trade', (req: Request, res: Response) => {
  const { termId } = req.body as { termId?: unknown };
  if (typeof termId !== 'string' || !termId) {
    res.status(400).json({ error: 'termId 必填' });
    return;
  }
  const r = npcTrade(ownerIdOf(req), req.params.id ?? '', termId);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json({ draw: r.draw, domainMatched: r.domainMatched, tradesLeft: r.tradesLeft });
});