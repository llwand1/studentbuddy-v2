/**
 * learning/npc-ping — 伙伴**主动开口**：地图上冒一个气泡来找你说话（契约 `docs/NPC-PARTNER-SPEC.md` §11）。
 *
 * ★★ 这是「让 AI 成为知识大陆的原住民」那句话的落点，也是**唯一一处会自己花钱的功能**。
 *   所以三道闸写死在 `shared/npc-life.ts` 里（纯函数、可单测），本文件只负责执行：
 *     ① 全局每小时上限 `NPC_PING_HOURLY_CAP`（这是"最多花多少钱"的那个数）
 *     ② 任意两次至少隔 `NPC_PING_MIN_GAP_MS`（防一屏冒出一堆气泡）
 *     ③ 同一位至少隔 `NPC_PING_COOLDOWN_MS`（他不该是话痨）
 *   ★ 还有一道**最硬的闸在前端**：只有大陆页可见时才轮询（§11）。用户没在看地图，
 *     一次调用都不该发生 —— "主动"的前提是有人在场，没人在场时的主动只是烧钱。
 *
 * ★★ 话题来自**他此刻站的那一格**，不是他的家：这正是"随机移动"与"随机对话"两件事被
 *   串起来的地方 —— 他走到哪条词条上，就想聊哪条。走位决定话题，话题反过来解释了走位
 *   为什么值得做（否则移动只是个动画）。
 *
 * ★ 主动说的那句**照样落进他自己的会话**（`recordNpcTurn(assistantOnly)`）：
 *   用户点开面板时看到的是连续的对话史，而不是"气泡说过的话凭空消失了"。
 */
import {
  NPC_PING_TTL_MS,
  npcPingDecide,
  notePing,
  parseNpcPingState,
  rollPingHour,
  type NpcPingState,
} from '@sb/shared';
import { getDb } from '../storage/db.js';
import { ownerForWrite, ownerFilter } from '../auth/ownership.js';
import { resolveNpcTarget } from './npc-genesis.js';
import { ensureNpcSession, recordNpcTurn } from './npc-session.js';
import { npcList, type NpcView } from './npc.js';

/** 节流账落 `app_settings`（零新表，与花名册同一张表不同键） */
export const SETTING_KEY_NPC_PINGS = 'npc_pings';
/** 待领的气泡也落 `app_settings`：它是**一条**瞬时状态，为它建表不值当 */
export const SETTING_KEY_NPC_BUBBLE = 'npc_bubble';

/** 主动说的那句话的上限（比被动回答更短：他是路过搭个话，不是开讲座） */
const PING_MAX_TOKENS = 200;
const PING_TEMPERATURE = 0.9;

function settingKey(base: string, ownerId: string | null): string {
  // 与花名册同款：无主行用裸键，有主行按 owner 分键（`npc-party.ts` 同一口径）
  return ownerId ? `${base}:${ownerId}` : base;
}

function readSetting(key: string): string {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

function writeSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

export function loadPingState(ownerId: string | null): NpcPingState {
  return parseNpcPingState(readSetting(settingKey(SETTING_KEY_NPC_PINGS, ownerId)));
}

export function savePingState(ownerId: string | null, state: NpcPingState): void {
  writeSetting(settingKey(SETTING_KEY_NPC_PINGS, ownerId), JSON.stringify(state));
}

/** 地图上那个待领的气泡 */
export interface NpcBubble {
  npcId: string;
  name: string;
  /** 他说的那句话 */
  text: string;
  /** 他说这句话时站的那一格上的词条（前端把气泡画在这儿） */
  termId: string;
  term: string;
  row: number;
  col: number;
  at: number;
  /** ★ `fallback` ⇒ 这句不是模型写的，UI 要照实说（降级可以，假装没降级不行） */
  source: 'ai' | 'fallback';
}

export function loadBubble(ownerId: string | null, now = Date.now()): NpcBubble | null {
  const raw = readSetting(settingKey(SETTING_KEY_NPC_BUBBLE, ownerId));
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as NpcBubble;
    if (!b || typeof b.npcId !== 'string' || typeof b.text !== 'string') return null;
    // 过期即失效：三分钟没人理，他就"算了"（不然回到地图会看到一句十天前的话）
    if (now - (b.at ?? 0) > NPC_PING_TTL_MS) return null;
    return b;
  } catch {
    return null;
  }
}

export function clearBubble(ownerId: string | null): void {
  writeSetting(settingKey(SETTING_KEY_NPC_BUBBLE, ownerId), '');
}

/** 他此刻站的那一格是哪条词条（走位决定话题的那一步） */
function topicOf(npc: NpcView, cells: ReadonlyArray<{ row: number; col: number; term: string; termId: string; domain: string }>) {
  const here = cells.find((c) => c.row === npc.row && c.col === npc.col);
  // 站在自己家那格、或恰好没匹配上（地图刚变）⇒ 回落到他守的词条，绝不留空
  return here ?? { row: npc.row, col: npc.col, term: npc.term, termId: npc.termId, domain: npc.domain };
}

function buildPingPrompt(npc: NpcView, topic: { term: string; domain: string }, sameAsHome: boolean): string {
  const where = sameAsHome
    ? `你正待在自己那块地上（「${topic.term}」）。`
    : `你这会儿溜达到了「${topic.term}」这块地上（领域：${topic.domain}）——不是你自己那块，是路过。`;
  const state = npc.threat
    ? `不过「${npc.threat.term}」的怪就在旁边，你有点慌。`
    : '';
  return [
    `你是知识大陆上的学习伙伴「${npc.name}」。${npc.bio}`,
    where,
    state,
    '现在你**主动**招呼路过的用户，想跟他聊聊你脚下这块地的这条词条。',
    '要求：第一人称、口语、**一到两句**、像邻居隔着院子喊一声；可以抛一个关于这条词条的小问题勾他接话。',
    '不要列条目、不要用标题、不要说"你好我是..."这种自我介绍（你们早就认识了）。',
    '★ 不要编造用户的学习进度、复习数字、卡牌数量——那些由别的面板说，你说了就会和它们对不上。',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface PingResult {
  bubble: NpcBubble | null;
  /** 没冒泡的原因（诊断用，前端不展示） */
  blockedBy: string | null;
}

/**
 * 轮询入口：先看有没有还没领的气泡，没有就问三道闸能不能新开一句。
 *
 * ★ 已有未过期气泡 ⇒ **直接回它，不再调模型**：轮询每 20 秒来一次，
 *   不这样做的话同一个气泡会被反复重生成（钱按轮询频率烧）。
 */
export async function npcPing(ownerIdRaw: string | null, now = Date.now()): Promise<PingResult> {
  const ownerId = ownerForWrite(ownerIdRaw);
  const existing = loadBubble(ownerId, now);
  if (existing) return { bubble: existing, blockedBy: null };

  const state = rollPingHour(loadPingState(ownerId), now);
  const view = npcList(ownerId);
  // 能开口的：在册的每一位。遇险的那位**优先级不额外提**——求救走的是任务单那条路（§5），
  // 气泡是闲聊；两条路混在一起会让"救他"这件事的唯一入口变得不确定。
  const eligible = view.npcs.map((n) => n.id);
  const decision = npcPingDecide(eligible, state, now, `${ownerId ?? '-'}|${Math.floor(now / 60_000)}`);
  if (!decision.npcId) {
    savePingState(ownerId, state);
    return { bubble: null, blockedBy: decision.blockedBy };
  }
  const npc = view.npcs.find((n) => n.id === decision.npcId);
  if (!npc) {
    savePingState(ownerId, state);
    return { bubble: null, blockedBy: 'no-candidate' };
  }

  const topic = topicOf(npc, view.cells ?? []);
  const sameAsHome = topic.termId === npc.termId;
  const target = resolveNpcTarget(ownerId);
  let text = '';
  let source: 'ai' | 'fallback' = 'fallback';

  if (target?.model && target.apiKey) {
    try {
      for await (const chunk of target.adapter.chat({
        model: target.model,
        apiKey: target.apiKey,
        baseUrl: target.baseUrl,
        messages: [
          { role: 'system', content: buildPingPrompt(npc, topic, sameAsHome) },
          { role: 'user', content: '（他正好路过，你开口。）' },
        ],
        temperature: PING_TEMPERATURE,
        maxTokens: PING_MAX_TOKENS,
        streamMode: 'once',
      })) {
        if (chunk.content) text += chunk.content;
        if (chunk.done) break;
      }
      if (text.trim()) source = 'ai';
    } catch {
      text = '';
    }
  }

  // ★★ 降级时**不冒泡**，而不是冒一个本地台词的泡。
  //   理由与对话那边相反、但同源：被动对话是用户点了他、必须有回应；主动搭话是**我们**发起的，
  //   拿一句罐头台词去打扰用户，比不打扰更糟。没模型就安静待着。
  if (!text.trim()) {
    savePingState(ownerId, state);
    return { bubble: null, blockedBy: 'no-model' };
  }

  const bubble: NpcBubble = {
    npcId: npc.id,
    name: npc.name,
    text: text.trim(),
    termId: topic.termId,
    term: topic.term,
    row: npc.row,
    col: npc.col,
    at: now,
    source,
  };
  writeSetting(settingKey(SETTING_KEY_NPC_BUBBLE, ownerId), JSON.stringify(bubble));
  savePingState(ownerId, notePing(state, npc.id, now));

  // 主动说的这句照样进他自己的会话史（★ 否则点开面板会发现气泡说过的话凭空消失）
  const sessionId = ensureNpcSession(npc.id, ownerId, npc.name, npc.termId);
  recordNpcTurn({ sessionId, ownerId, userText: '', reply: bubble.text, assistantOnly: true });
  return { bubble, blockedBy: null };
}

/** 诊断口：把三道闸的当前读数摊开（`/api/npc/ping?debug=1` 用，**不进 UI**） */
export function pingDiagnostics(ownerId: string | null, now = Date.now()) {
  const s = rollPingHour(loadPingState(ownerForWrite(ownerId)), now);
  const f = ownerFilter(ownerId);
  return { hourUsed: s.hourUsed, lastAny: s.lastAny, npcs: Object.keys(s.lastByNpc).length, ownerScoped: f.sql !== '' };
}
