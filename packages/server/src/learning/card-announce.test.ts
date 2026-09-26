/**
 * learning/card-announce — 卡数变化帧的**取证**（契约 `docs/TERM-CARDS-SPEC.md` §7.2 的 `card_granted`）。
 *
 * ★ 观察方式：进程内驱动 + 读 `sse-bus` 的缓冲区（`snapshot`），不 mock `publish`。
 *   理由与仓规一致（"优先进程内驱动"）：mock 掉 `publish` 只能证明"我调用了一个函数"，
 *   证不了推出去的**形状**是不是 `shared/sse-events.ts` 登记的那一份——而形状错了前端就是收不到。
 * ⚠️ **缓冲区是模块级单例，`beforeEach` 重开库也清不掉它**（TTL 回收只在心跳里，15 秒一轮）。
 *   所以每条断言都取"跑之前的长度"做**差值**，不看绝对条数；直接数 `snapshot().length`
 *   的写法在同文件的第二条用例会假红（本文件第一版就是这么红的，改判记录留在这里）。
 *
 * 四件事，每件对应一类真会坏掉的东西：
 *  ① 复习打卡 ⇒ 推帧，且带的是**绝对卡数**（不是增量）；
 *  ② `silent` 种子 ⇒ **不推**（红线在 `auth/demo-seed.ts`，这里补上"也不许推"那一半）；
 *  ③ 命中提及 ⇒ 一帧带本轮全部命中词条；
 *  ④ 不推空帧、不推不属于这个人的词条（别人的 id 传进来 ⇒ 一帧都不发，而不是发 `cards: 0`）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cardsChannel, type SseEvent } from '@sb/shared';
import { openIsolated, closeDb, getDb } from '../storage/db.js';
import { snapshot } from '../chat/sse-bus.js';
import { announceCards } from './card-announce.js';
import { markReviewed } from './term-review.js';
import { countUsage } from './term-usage.js';
import { saveOneTerm } from './terms.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-card-announce-'));
  openIsolated(dir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 本频道**新增**的 `card_granted` 帧（★ 差值口径，见文件头那条陷阱） */
function grantedSince(ownerId: string | null, mark: number): Array<Extract<SseEvent, { type: 'card_granted' }>> {
  const all = snapshot(cardsChannel(ownerId)).filter(
    (e): e is Extract<SseEvent, { type: 'card_granted' }> => e.type === 'card_granted',
  );
  return all.slice(mark);
}

function mark(ownerId: string | null): number {
  return snapshot(cardsChannel(ownerId)).length;
}

function ownTerm(term: string, ownerId = ''): string {
  return saveOneTerm(term, `${term} 的释义`, '记忆机制', ownerId).id ?? '';
}

describe('card_granted', () => {
  it('复习打卡 ⇒ 推一帧，带的是绝对卡数与当前星', () => {
    const id = ownTerm('主动回忆');
    const before = mark(null);
    markReviewed(id, true, null);
    const frames = grantedSince(null, before);
    expect(frames).toHaveLength(1);
    // 1（建卡那张）+ 1（今天这个复习日）= 2 张 ⇒ ★1。★ 断言的是**读数**，不是"有没有调用"
    expect(frames[0]?.grants).toEqual([{ termId: id, cards: 2, star: 1 }]);
    // ★ 只锁**形状**不锁具体日：起点日是 `localDayKey(今天)`，把 2026-09-25 写进断言
    //   就是"把运行态配置当契约"（本仓踩过：测试不许锁用户可改/会走的数）。
    expect(frames[0]?.logSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('`silent` 的种子打卡不推帧（种子不是"有人学习了"）', () => {
    const id = ownTerm('间隔重复');
    const before = mark(null);
    markReviewed(id, true, null, { silent: true });
    expect(grantedSince(null, before)).toHaveLength(0);
    // ★ 反向半句：流水**照写**（silent 关的是事件与活动账，不是事实本身），否则卡牌读数会凭空少一张
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM term_review_log').get()).toMatchObject({ n: 1 });
  });

  it('一轮回复命中三个词条 ⇒ 一帧里三条，各带自己的卡数', () => {
    const a = ownTerm('组块');
    const b = ownTerm('生成效应');
    const c = ownTerm('交错练习');
    const before = mark(null);
    const n = countUsage('这就要说到组块、生成效应，还有交错练习这三个概念', null);
    expect(n).toBe(3);
    const frames = grantedSince(null, before);
    expect(frames).toHaveLength(1); // ★ 一帧三条，不是三条各一帧（帧数 = 轮数）
    expect([...(frames[0]?.grants.map((g) => g.termId) ?? [])].sort()).toEqual([a, b, c].sort());
    // ★ 2 张不是 1 张：本轮那行提及流水**已经落库**（`countUsage` 在事务**之后**才推帧），
    //   推的是"落库后的读数"。若这里期望 1，说明推在事务内 ⇒ 帧已发出、流水回滚（文件头那条判据）。
    expect(frames[0]?.grants.every((g) => g.cards === 2 && g.star === 1)).toBe(true);
  });

  it('空命中与别人的词条都不推帧（宁可不推，也不发一条假的 `cards: 0`）', () => {
    const before = mark(null);
    announceCards(null, []);
    announceCards('u1', ['属于别人、这里查不到的 id']);
    expect(grantedSince(null, before)).toHaveLength(0);
    expect(grantedSince('u1', before)).toHaveLength(0);
  });

  it('未登录与登录用户走**不同频道**（`cards:local` vs `cards:<id>`，四向隔离的最后一向）', () => {
    const anon = ownTerm('前摄抑制');
    const named = ownTerm('倒摄抑制', 'u9');
    const b0 = mark(null);
    const b9 = mark('u9');
    announceCards(null, [anon]);
    announceCards('u9', [named]);
    expect(grantedSince(null, b0)).toHaveLength(1);
    expect(grantedSince('u9', b9)).toHaveLength(1);
    expect(cardsChannel(null)).not.toBe(cardsChannel('u9'));
  });
});
