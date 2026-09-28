/**
 * npc-life.test — 伙伴「会走路 + 会主动开口」的纯逻辑（契约 `docs/NPC-PARTNER-SPEC.md` §10/§11）。
 *
 * ★ 为什么这一层值得单测到这个密度：它是本次改动里**唯一同时被服务端和前端依赖**的判定，
 *   而且它决定**花不花钱**。走位错了是观感问题，闸门错了是账单问题。
 *   所以下面锁的三件事，每一件烂掉都不会有人当场发现：
 *   ① 走位**确定性**——同一位伙伴同一步序必须走到同一格（否则"服务端权威"名存实亡）；
 *   ② 追帧**有上限**——挂机一夜回来不许一次性跑 1900 步；
 *   ③ 三道闸的**优先级与理由**——被拦时要说得出是哪一道拦的，否则线上只能靠猜。
 */
import { describe, it, expect } from 'vitest';
import {
  NPC_MAX_CATCHUP_STEPS,
  NPC_PING_COOLDOWN_MS,
  NPC_PING_HOURLY_CAP,
  NPC_PING_MIN_GAP_MS,
  NPC_STEP_MS,
  NPC_WANDER_RADIUS,
  EMPTY_PING_STATE,
  isNpcSessionId,
  notePing,
  npcPingDecide,
  npcSessionIdOf,
  npcStepsDue,
  npcWanderStep,
  parseNpcPingState,
  rollPingHour,
} from './npc-life.js';

/** 一块 9×9 的全词条地（够 `NPC_WANDER_RADIUS=3` 撒开腿走） */
function field(n = 9): Set<string> {
  const s = new Set<string>();
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) s.add(`${r},${c}`);
  return s;
}

const HOME = { row: 4, col: 4 };

describe('npcWanderStep — 走一步', () => {
  it('同一位伙伴、同一步序 ⇒ 永远走到同一格（确定性，可刷新、可重启）', () => {
    const a = npcWanderStep('npc:t1', 7, HOME, HOME, field(), new Set());
    const b = npcWanderStep('npc:t1', 7, HOME, HOME, field(), new Set());
    expect(a).toEqual(b);
  });

  it('不同伙伴在同一格同一步序会分开走（不然一群人叠在一起同步位移）', () => {
    const picks = new Set(
      ['npc:a', 'npc:b', 'npc:c', 'npc:d', 'npc:e'].map((id) => {
        const p = npcWanderStep(id, 3, HOME, HOME, field(), new Set());
        return `${p.row},${p.col}`;
      }),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it('只走四邻格，且一步只挪一格', () => {
    const p = npcWanderStep('npc:t1', 1, HOME, HOME, field(), new Set());
    expect(Math.abs(p.row - HOME.row) + Math.abs(p.col - HOME.col)).toBe(1);
  });

  it('★ 永不越过离家 NPC_WANDER_RADIUS 格（连走 200 步也不行）', () => {
    let at = { ...HOME };
    for (let i = 0; i < 200; i++) {
      at = npcWanderStep('npc:t1', i, at, HOME, field(), new Set());
      const d = Math.abs(at.row - HOME.row) + Math.abs(at.col - HOME.col);
      expect(d).toBeLessThanOrEqual(NPC_WANDER_RADIUS);
    }
  });

  it('非词条格不可踏（走不出这块地）', () => {
    const only = new Set([`${HOME.row},${HOME.col}`, `${HOME.row},${HOME.col + 1}`]);
    const p = npcWanderStep('npc:t1', 0, HOME, HOME, only, new Set());
    expect(`${p.row},${p.col}`).toBe(`${HOME.row},${HOME.col + 1}`);
  });

  it('别人占着的格不踏（两位伙伴不会重叠）', () => {
    const only = new Set([`${HOME.row},${HOME.col}`, `${HOME.row},${HOME.col + 1}`]);
    const p = npcWanderStep('npc:t1', 0, HOME, HOME, only, new Set([`${HOME.row},${HOME.col + 1}`]));
    expect(p).toEqual(HOME); // 无路可走 ⇒ 原地
  });

  it('被彻底围住 ⇒ 原地不动，而不是抛错或瞬移', () => {
    const p = npcWanderStep('npc:t1', 0, HOME, HOME, new Set([`${HOME.row},${HOME.col}`]), new Set());
    expect(p).toEqual(HOME);
  });
});

describe('npcStepsDue — 该走几步', () => {
  it('不到一个间隔 ⇒ 0 步', () => {
    expect(npcStepsDue(1_000_000, 1_000_000 + NPC_STEP_MS - 1)).toBe(0);
  });

  it('刚好一个间隔 ⇒ 1 步', () => {
    expect(npcStepsDue(1_000_000, 1_000_000 + NPC_STEP_MS)).toBe(1);
  });

  it('★ 挂机一整夜回来 ⇒ 截到 NPC_MAX_CATCHUP_STEPS（不许一次跑上千步）', () => {
    expect(npcStepsDue(1_000_000, 1_000_000 + NPC_STEP_MS * 5000)).toBe(NPC_MAX_CATCHUP_STEPS);
  });

  it('新成员（lastStepAt=0）⇒ 0 步，不会从 1970 年开始追帧', () => {
    expect(npcStepsDue(0, Date.now())).toBe(0);
  });

  it('时钟回拨 ⇒ 0 步，不返回负数', () => {
    expect(npcStepsDue(2_000_000, 1_000_000)).toBe(0);
  });
});

describe('npcPingDecide — 主动搭话的三道闸', () => {
  const T = 10_000_000;

  it('干净状态下会挑一位开口', () => {
    const d = npcPingDecide(['a', 'b'], EMPTY_PING_STATE, T, 's');
    expect(d.npcId).not.toBeNull();
    expect(d.blockedBy).toBeNull();
  });

  it('★ 小时额度用尽 ⇒ hourly-cap（最先拦，最便宜的一道）', () => {
    const state = { ...EMPTY_PING_STATE, hourStart: T, hourUsed: NPC_PING_HOURLY_CAP };
    const d = npcPingDecide(['a'], state, T, 's');
    expect(d).toEqual({ npcId: null, blockedBy: 'hourly-cap' });
  });

  it('★ 全局最小间隔内 ⇒ global-gap（别的伙伴刚说过话，不许接龙）', () => {
    const state = { ...EMPTY_PING_STATE, hourStart: T, lastAny: T - NPC_PING_MIN_GAP_MS + 1 };
    expect(npcPingDecide(['a'], state, T, 's').blockedBy).toBe('global-gap');
  });

  it('★ 本人冷却未过 ⇒ npc-cooldown（而不是笼统的"不开口"）', () => {
    const state = {
      ...EMPTY_PING_STATE,
      hourStart: T,
      lastAny: T - NPC_PING_MIN_GAP_MS - 1,
      lastByNpc: { a: T - NPC_PING_COOLDOWN_MS + 1 },
    };
    expect(npcPingDecide(['a'], state, T, 's').blockedBy).toBe('npc-cooldown');
  });

  it('没有候选人 ⇒ no-candidate（与"都在冷却"区分开）', () => {
    expect(npcPingDecide([], EMPTY_PING_STATE, T, 's').blockedBy).toBe('no-candidate');
  });

  it('冷却过了的那位会被选中（另一位还在冷却）', () => {
    const state = {
      ...EMPTY_PING_STATE,
      hourStart: T,
      lastAny: T - NPC_PING_MIN_GAP_MS - 1,
      lastByNpc: { a: T - 1_000, b: T - NPC_PING_COOLDOWN_MS - 1 },
    };
    expect(npcPingDecide(['a', 'b'], state, T, 's').npcId).toBe('b');
  });

  it('同一个种子挑同一位（前端重发一次不会变成两人抢话）', () => {
    const one = npcPingDecide(['a', 'b', 'c'], EMPTY_PING_STATE, T, 'same');
    const two = npcPingDecide(['a', 'b', 'c'], EMPTY_PING_STATE, T, 'same');
    expect(one.npcId).toBe(two.npcId);
  });
});

describe('notePing / rollPingHour — 记账', () => {
  const T = 10_000_000;

  it('记一次后：本人冷却与全局间隔同时生效，额度 +1', () => {
    const next = notePing(EMPTY_PING_STATE, 'a', T);
    expect(next.hourUsed).toBe(1);
    expect(next.lastAny).toBe(T);
    expect(next.lastByNpc.a).toBe(T);
    expect(npcPingDecide(['a'], next, T + 1, 's').blockedBy).toBe('global-gap');
  });

  it('★ 跨过一小时 ⇒ 额度归零重开（否则第一个小时用完就永久闭嘴）', () => {
    const used = { ...EMPTY_PING_STATE, hourStart: T, hourUsed: NPC_PING_HOURLY_CAP };
    const rolled = rollPingHour(used, T + 3_600_000 + 1);
    expect(rolled.hourUsed).toBe(0);
    expect(npcPingDecide(['a'], rolled, T + 3_600_000 + 1, 's').npcId).toBe('a');
  });

  it('同一小时内不归零', () => {
    const used = { ...EMPTY_PING_STATE, hourStart: T, hourUsed: 3 };
    expect(rollPingHour(used, T + 60_000).hourUsed).toBe(3);
  });
});

describe('parseNpcPingState — 读坏账不许崩', () => {
  it.each(['', 'null', '[]', '{', 'not json', '3'])('垃圾输入 %j ⇒ 回到空账', (raw) => {
    expect(parseNpcPingState(raw)).toEqual(EMPTY_PING_STATE);
  });

  it('正常账原样读回', () => {
    const s = { lastByNpc: { a: 5 }, lastAny: 5, hourStart: 1, hourUsed: 2 };
    expect(parseNpcPingState(JSON.stringify(s))).toEqual(s);
  });
});

describe('npcSessionIdOf / isNpcSessionId — 会话 id 就是伙伴 id', () => {
  it('伙伴 id 直接当会话 id 用（零新表的支点）', () => {
    expect(npcSessionIdOf('npc:t1')).toBe('npc:t1');
  });

  it('★ 会话列表据此过滤：伙伴会话不能混进用户的聊天记录', () => {
    expect(isNpcSessionId('npc:t1')).toBe(true);
    expect(isNpcSessionId('sess_abc')).toBe(false);
    expect(isNpcSessionId('npcsomething')).toBe(false);
  });
});
