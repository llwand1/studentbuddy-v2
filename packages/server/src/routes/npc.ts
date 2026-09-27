/**
 * routes/npc — 学习伙伴（NPC）的 HTTP 出口（契约 `docs/NPC-PARTNER-SPEC.md` §7.1）。
 *
 * ★ **独立前缀 `/api/npc`，不挂进 `/api/cards`**：那边是**玩法读数**（卡数/钥匙/清单），
 *   这边是**地图上的人**（他是谁、在哪、说什么、拿什么换）。写侧权力也不同——这里会写
 *   `app_settings`（花名册）与 `chest_open`（交换），混在一起后想给伙伴单独限流或灰度就没有落点。
 * ★ 位置与处境结论**都由服务端给**（`learning/npc.ts`），前端不重算铺格/领地：
 *   双份口径的开端就是「图上画着伙伴遇险、任务清单里没有那单」。
 * ★ **不新增 SSE 事件**（§7.1）：求救单的到达走既有 `task_dispatched`，前端读 `/api/cards/state` 即可。
 * ★★ 写侧一律回**整份新状态**（`{ state }`）：创建/改名/解散都会改变名额、可落位格甚至别人的处境
 *   （解散一位就空出一格），只回"改成功了"会让前端立刻看到一份过期地图。
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ownerIdOf } from '../auth/ownership.js';
import { npcList, npcTrade } from '../learning/npc.js';
import { createPartner, removePartner, renamePartner } from '../learning/npc-party.js';
import { npcTalk } from '../learning/npc-talk.js';

export const npcRouter = Router();

/** 一次读全：伙伴名单 + 名额门票 + 可落位格 + 今天还能换几次（★ 含遇险结论，前端不重算） */
npcRouter.get('/', (req: Request, res: Response) => {
  res.json(npcList(ownerIdOf(req)));
});

/**
 * 创建一位伙伴（宣传点「创建你的 AI 学习伙伴」的落点）。
 * body `{ row, col }` = 玩家在地图上点的那一格；名字与人设由服务端现生成（AI 优先，失败回退本地）。
 * ★ 返回 `source`：`'fallback'` 时 UI 必须如实说一句"名字是本地起的"（降级可以，假装没降级不行）。
 */
npcRouter.post('/', async (req: Request, res: Response) => {
  const { row, col } = req.body as { row?: unknown; col?: unknown };
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    res.status(400).json({ error: 'row / col 必须是整数格坐标' });
    return;
  }
  const ownerId = ownerIdOf(req);
  const r = await createPartner(ownerId, row as number, col as number);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json({ state: npcList(ownerId), memberId: r.member.id, source: r.source });
});

/** 给一位伙伴改名。★ 空串是入参错（400）：批 12 起每位伙伴都有存下来的名字，"清空"不是一个动作 */
npcRouter.put('/:id', (req: Request, res: Response) => {
  const { name } = req.body as { name?: unknown };
  const ownerId = ownerIdOf(req);
  const r = renamePartner(ownerId, req.params.id ?? '', name);
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json({ state: npcList(ownerId) });
});

/** 「让他回家」：把一位伙伴从名册里删掉（★ 门票按名册序号算，所以是真删，不是打标记） */
npcRouter.delete('/:id', (req: Request, res: Response) => {
  const ownerId = ownerIdOf(req);
  const r = removePartner(ownerId, req.params.id ?? '');
  if (!r.ok) {
    res.status(r.status).json({ error: r.error });
    return;
  }
  res.json({ state: npcList(ownerId) });
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