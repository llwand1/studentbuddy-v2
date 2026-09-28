/**
 * shared/npc-life — 伙伴的「作息」：**随机游走** + **主动搭话的节流**（契约 `docs/NPC-PARTNER-SPEC.md` §10／§11）。
 *
 * ★★ 为什么这两件事住同一个文件：它们是**同一条时间轴上的两个读数**——
 *   「他此刻站在哪一格」决定了「他此刻想聊什么」（站在哪条词条上就聊哪条）。
 *   拆成两处就会出现「气泡说在聊光合作用、小人却站在牛顿第二定律上」这种自相矛盾。
 *
 * ★★ 全部是**纯函数**：输入（成员、当前格子、时刻、种子）一样，输出必然一样。
 *   ⇒ 走位可单测、可复现、刷新后一致；主动搭话的节流也能在不调模型的前提下验完。
 *   这是「服务端权威位置」这条裁定能成立的前提——位置若不可复现，"权威"就只是"随便给一个"。
 *
 * ★ 与 `npc.ts` 分家的理由：那边是**身份与名额**（他是谁、能不能建、遇没遇险），
 *   这边是**时间与行为**（他在走、他要开口）。`npc.ts` 已近 330 行，再塞进来必破 400 行红线。
 */
import { continentHash } from './continent.js';
import type { NpcSpot } from './npc.js';

// ──────────────────────────────── 游走 ────────────────────────────────

/**
 * 一步的时长。45 秒是**产品感受值**：
 * 快到「盯着地图能看见他在动」，慢到「不会像蚂蚁乱窜、也不会一直擦着别人身边过」。
 * ★ 要调只改这一处；它同时是"补步"的单位，改大改小都不影响可复现性。
 */
export const NPC_STEP_MS = 45_000;

/**
 * 离家最远几格（曼哈顿）。
 * ★★ 必须有这个笼子，否则伙伴会走到地图另一头 —— 那时「他守着那块地」这个设定就没了，
 *   遇险判定（怪压在他的地上）也会变成随机事件。3 格 ≈ 一屏内找得到他。
 */
export const NPC_WANDER_RADIUS = 3;

/**
 * 一次最多补几步。
 * ★ 关掉页面三天再回来，不该让服务端跑 5760 步的循环（也没人看得见中间过程）。
 * ★ 但也**不能直接瞬移到终点**：那样路径就不是"走"出来的，撞不到"避开别人"的约束。
 *   补 8 步 = 最多挪 8 格，足够看起来"我不在的时候他确实动过"。
 */
export const NPC_MAX_CATCHUP_STEPS = 8;

/** 四邻（不走斜线：像素小人走格子，斜线会穿墙角） */
const DIRS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

const cellKey = (row: number, col: number): string => `${row},${col}`;

/** 曼哈顿距离（本文件自用，避免为一行去 import `npc.ts` 造成双向依赖） */
function manhattan(aRow: number, aCol: number, bRow: number, bCol: number): number {
  return Math.abs(aRow - bRow) + Math.abs(aCol - bCol);
}

/**
 * 走一步：从 `from` 挑一个合法邻格。
 *
 * 合法 = ①是词条格（在 `walkable` 里）②离家 ≤ `NPC_WANDER_RADIUS` ③没被别的伙伴占着。
 * 没有合法邻格 ⇒ **原地不动**（返回 `from`）——地图很小或被围住时这是正常状态，不是错误。
 *
 * ★ 选择用 `continentHash(id|步序)` 而不是 `Math.random()`：
 *   同一位伙伴、同一步序，走到哪儿是**定死的** ⇒ 可单测、刷新后一致、服务端重启也一致。
 *   随机数一旦进来，"服务端权威位置"就退化成"服务端每次给个新位置"。
 */
export function npcWanderStep(
  npcId: string,
  stepIndex: number,
  from: NpcSpot,
  home: NpcSpot,
  walkable: ReadonlySet<string>,
  occupied: ReadonlySet<string>,
): NpcSpot {
  const legal: NpcSpot[] = [];
  for (const [dr, dc] of DIRS) {
    const row = from.row + dr;
    const col = from.col + dc;
    const key = cellKey(row, col);
    if (!walkable.has(key)) continue;
    if (occupied.has(key)) continue;
    if (manhattan(row, col, home.row, home.col) > NPC_WANDER_RADIUS) continue;
    legal.push({ row, col });
  }
  if (legal.length === 0) return { row: from.row, col: from.col };
  const pick = continentHash(`${npcId}|walk|${stepIndex}`) % legal.length;
  return legal[pick] as NpcSpot;
}

/**
 * 该走几步了。`lastStepAt` 为 0／未来时刻 ⇒ 0 步（新成员、或时钟回拨）。
 * ★ 时钟回拨返回 0 而不是负数：负数会让调用方的 for 循环直接不执行，行为虽同但读代码时看不出是**有意**的。
 */
export function npcStepsDue(lastStepAt: number, now: number): number {
  if (!Number.isFinite(lastStepAt) || lastStepAt <= 0) return 0;
  const elapsed = now - lastStepAt;
  if (elapsed < NPC_STEP_MS) return 0;
  return Math.min(Math.floor(elapsed / NPC_STEP_MS), NPC_MAX_CATCHUP_STEPS);
}

// ──────────────────────────────── 主动搭话 ────────────────────────────────

/**
 * 三道闸，**全部要过**才允许一次主动搭话（= 一次真实模型调用）。
 *
 * ★★ 为什么闸门定在这里而不是"随机数小于 0.1"：主动搭话是**花钱**的动作。
 *   免费档是 250 次/5 小时，9 位伙伴若各自随机开口，一个下午就能把额度打光，
 *   之后全员降级成本地台词 —— 用户看到的是"AI 突然变傻了"，比一开始就少说话糟得多。
 */
/** 同一位伙伴两次主动搭话的最小间隔：6 分钟（他不该是个话痨） */
export const NPC_PING_COOLDOWN_MS = 6 * 60_000;
/** 任意两次主动搭话的最小间隔：90 秒（防止一屏同时冒出好几个气泡） */
export const NPC_PING_MIN_GAP_MS = 90_000;
/** 全局每小时上限（硬闸：这是"最多花多少钱"的那个数） */
export const NPC_PING_HOURLY_CAP = 8;
/** 气泡活多久没人理就自己消失：3 分钟 */
export const NPC_PING_TTL_MS = 3 * 60_000;
/** 地图页轮询间隔：20 秒（★ 页面不可见时前端必须停轮询，见 §11） */
export const NPC_POLL_MS = 20_000;

/** 主动搭话的节流账（落 `app_settings.npc_pings`，零新表） */
export interface NpcPingState {
  /** npcId → 上次主动开口的时刻（毫秒） */
  lastByNpc: Record<string, number>;
  /** 最近一次任意伙伴开口的时刻 */
  lastAny: number;
  /** 当前小时窗的起点与已用次数（滑窗太重，整点窗够用且好解释） */
  hourStart: number;
  hourUsed: number;
}

export const EMPTY_PING_STATE: NpcPingState = { lastByNpc: {}, lastAny: 0, hourStart: 0, hourUsed: 0 };

/** 容错解析（数据容错 ADR-6）：坏 JSON／缺字段 ⇒ 回到空账，**不抛** */
export function parseNpcPingState(raw: string): NpcPingState {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== 'object') return { ...EMPTY_PING_STATE, lastByNpc: {} };
    const lastByNpc: Record<string, number> = {};
    const src = v.lastByNpc;
    if (src && typeof src === 'object') {
      for (const [k, n] of Object.entries(src as Record<string, unknown>)) {
        if (Number.isFinite(n)) lastByNpc[k] = Number(n);
      }
    }
    const num = (x: unknown): number => (Number.isFinite(x) ? Number(x) : 0);
    return { lastByNpc, lastAny: num(v.lastAny), hourStart: num(v.hourStart), hourUsed: num(v.hourUsed) };
  } catch {
    return { ...EMPTY_PING_STATE, lastByNpc: {} };
  }
}

/** 小时窗翻页（跨小时就清零）。纯函数：返回新账，不改入参 */
export function rollPingHour(state: NpcPingState, now: number): NpcPingState {
  if (now - state.hourStart >= 3_600_000) return { ...state, hourStart: now, hourUsed: 0 };
  return state;
}

/** 拒绝的理由（用于诊断口，**不给用户看**——用户看到的只是"有没有气泡"） */
export type NpcPingBlock = 'hourly-cap' | 'global-gap' | 'npc-cooldown' | 'no-candidate';

export interface NpcPingDecision {
  /** 该开口的那一位；null ⇒ 这一轮不开口 */
  npcId: string | null;
  blockedBy: NpcPingBlock | null;
}

/**
 * 这一轮该不该有人开口、该谁开口。
 *
 * ★ 顺序刻意是「全局闸 → 个体闸 → 挑人」：先便宜后贵。全局额度用完时，
 *   连"谁冷却好了"都不必算 —— 而且诊断口能直接说出是**哪一道**闸拦的。
 * ★ 挑人不用 `Math.random()`，用 `continentHash(种子)`：同一轮询时刻挑同一位，
 *   前端重试（网络抖动重发一次）不会变成两个人抢着说话。
 */
export function npcPingDecide(
  eligible: readonly string[],
  state: NpcPingState,
  now: number,
  seed: string,
): NpcPingDecision {
  if (state.hourUsed >= NPC_PING_HOURLY_CAP) return { npcId: null, blockedBy: 'hourly-cap' };
  if (state.lastAny > 0 && now - state.lastAny < NPC_PING_MIN_GAP_MS) {
    return { npcId: null, blockedBy: 'global-gap' };
  }
  const ready = eligible.filter((id) => {
    const last = state.lastByNpc[id] ?? 0;
    return last === 0 || now - last >= NPC_PING_COOLDOWN_MS;
  });
  if (ready.length === 0) {
    return { npcId: null, blockedBy: eligible.length === 0 ? 'no-candidate' : 'npc-cooldown' };
  }
  const pick = continentHash(`${seed}|ping|${ready.length}`) % ready.length;
  return { npcId: ready[pick] as string, blockedBy: null };
}

/** 记一次开口（纯函数：返回新账） */
export function notePing(state: NpcPingState, npcId: string, now: number): NpcPingState {
  const rolled = rollPingHour(state, now);
  return {
    ...rolled,
    lastByNpc: { ...rolled.lastByNpc, [npcId]: now },
    lastAny: now,
    hourStart: rolled.hourStart || now,
    hourUsed: rolled.hourUsed + 1,
  };
}

// ──────────────────────────────── 会话 ────────────────────────────────

/**
 * 伙伴的会话 id ＝ **伙伴 id 本身**（`npc:<termId>`）。
 *
 * ★★ 这是本次改动"零新表"的关键一步：`sessions.id` 是 TEXT 主键，直接拿 `npc:<termId>` 当会话 id ⇒
 *   历史对话天然落进既有 `messages` 表、单独记忆天然落进既有 `sessions.summary`，
 *   连"哪条词条"都有现成的 `sessions.forked_term` 列可放。**一张新表都不用建。**
 * ★ 前缀 `npc:` 同时是**聊天列表的过滤条件**（`id NOT LIKE 'npc:%'`）：
 *   伙伴的对话不该混进用户的聊天列表里 —— 那是两种东西。
 */
export function npcSessionIdOf(npcId: string): string {
  return npcId;
}

/** 反向判断：这个会话是不是伙伴会话（聊天列表与导出都要据此排除） */
export function isNpcSessionId(sessionId: string): boolean {
  return sessionId.startsWith('npc:');
}
