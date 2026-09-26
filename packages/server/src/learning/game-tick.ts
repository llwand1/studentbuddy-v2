/**
 * learning/game-tick — 6 小时心跳上「主动的那几件事」（契约 `docs/TERM-CARDS-SPEC.md` §5／§7.2）。
 *
 * ★★ **本文件不起定时器**。本仓唯一的周期调度器是 `learning/trend.ts:startTrendScheduler`，
 *   契约 §5 点名了理由（`chat/memory-digest.ts` 文件头那节「为什么不新开调度器」）：新增一套
 *   调度就要多回答一遍"何时跑／跑多少／从哪段跑"，而这三问这里已经答过。⇒ 这里只出一个
 *   能被 tick 调用的同步函数，接线在 `trend.ts` 的循环里，一行。
 *
 * 三件事，顺序**有讲究**：
 *  ① **派单**（幂等键挡重复）；
 *  ② **对账**（`dispatchTasks` 内部尾部已 reconcile 一次：把"事实早已到位却还挂着"的单翻成 done
 *     并补发钥匙）——放在派单**之后**是刻意的：先补完旧单腾出 `MAX_OPEN_TASKS` 的空位，
 *     这一轮才派得进新单；反过来一轮就只能派 0 张、下一轮才补账，白等 6 小时；
 *  ③ **提醒开箱**（`claimChestReady` 的日级闸门挡重复，一天最多一条）。
 *
 * ★ 逐 owner 吞错：`trend.ts` 同一个 tick 里那两条链就是这么分的——一个人的一条坏数据
 *   不该让另一个人的任务清单永远停更。
 * ⚠️ 继承 `trend.ts:17` 那条前提：**定时器是进程内的**，多实例部署会各跑一份。
 *   派单有 `UNIQUE(owner_id, dedupe_key)` 挡重复写，发钥匙挂在 `status` 的翻转上
 *   （单次 UPDATE 的自然闸门），所以重复 tick 不产生第二份账；**但提醒没有**——
 *   多实例下同一人一天可能收到两条 `chest_ready`（两条 SSE 帧，不写库、不虚报任何数）。
 *   横向扩容前要先处理这条前提本身，不在这里提前发明分布式锁。
 */
import { cardsChannel } from '@sb/shared';
import { getDb } from '../storage/db.js';
import { publish } from '../chat/sse-bus.js';
import { claimChestReady } from './chest.js';
import { dispatchTasks } from './tasks.js';

export interface GameTickResult {
  owners: number;
  added: number;
  taskIds: string[];
  /** 本 tick 内**广播过**的条数（受日级闸门约束，恒 ≤ owners） */
  chestAnnounced: number;
}

/**
 * 本轮要为哪些人跑。
 * ★ 起点是**词条库**而不是提及流水（`trendOwners` 用的那张）：一个刚存了三个词、还没聊过天的人
 *   正是最该被派单和提醒的对象，按流水选就会把他漏掉——而"新用户第一周没被产品主动找过"
 *   恰恰是本功能的立项理由（契约 §0）。
 * ★ 匿名桶只在**没有任何具名 owner 时**才出一份，与 `trend.ts` 同一条判据：
 *   一旦有了登录用户，无主行就是"所有人混在一起的老数据"，不该为它单独产主动通知。
 */
export function gameOwners(): Array<string | null> {
  const rows = getDb().prepare('SELECT DISTINCT owner_id FROM term_library').all() as Array<{ owner_id: string }>;
  const named = rows.map((r) => r.owner_id).filter((o) => o !== '');
  if (named.length === 0) return [null];
  return named;
}

/**
 * 跑一轮。★ 同步、无 IO 等待：整条链全是 better-sqlite3 的同步调用，
 * 挂进 tick 不会把趋势卡那条异步链堵住。
 */
export function runGameTick(now = new Date()): GameTickResult {
  const out: GameTickResult = { owners: 0, added: 0, taskIds: [], chestAnnounced: 0 };
  for (const ownerId of gameOwners()) {
    out.owners += 1;
    try {
      const r = dispatchTasks(ownerId, now);
      if (r.added > 0) {
        out.added += r.added;
        out.taskIds.push(...r.taskIds);
        const channel = cardsChannel(ownerId);
        publish(channel, { type: 'task_dispatched', sessionId: channel, added: r.added, taskIds: r.taskIds });
      }
    } catch {
      /* 吞掉：见文件头"逐 owner" */
    }
    try {
      const ready = claimChestReady(ownerId, now);
      if (ready) {
        out.chestAnnounced += 1;
        const channel = cardsChannel(ownerId);
        publish(channel, { type: 'chest_ready', sessionId: channel, openedDay: ready.openedDay, left: ready.left });
      }
    } catch {
      /* 吞掉：同上 */
    }
  }
  return out;
}
