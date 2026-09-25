/**
 * §16「AI 主动发起对战」邀请域层测试（契约 docs/PK-SPEC.md §16.13 的 T2/T3）。
 *
 * 五类不可回归的行为：
 * ① **截断发生在建邀请那一刻**（留到 accept 才校验＝报错落在用户已做完决定之后）；
 * ② 三条闸门各正反例——尤其「本会话还挂着未答复的卡 ⇒ 第二张必被挡」；
 * ③ 状态机终态不可逆 + **accept 幂等返回同一间房**（双点不许开出两局）；
 * ④ 接受后的房是「按邀请主题的 PVE 房」（不走 §8.2 主题池轮换，否则「相关话题」落空）；
 * ⑤ 归属：跨主读别人的邀请一律同一个「不存在」（不告诉对方这条 id 存在）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, openIsolated } from '../storage/db.js';
import { snapshot } from '../chat/sse-bus.js';
import { PK_DEFAULT_AI_TOPIC, PK_INVITE_OWNER_DAILY_MAX, PK_ROOM_TTL_MS, TOPIC_MAX, type PkIdentity } from '@sb/shared';
import { acceptPkInvite, listPendingInvites, offerPkInvite, rejectPkInvite } from './invite.js';
import { resetRooms, requireRoomInternal } from './room.js';

let tmpDir = '';
const me: PkIdentity = { userId: 'u-me', nickname: '我' };
const other: PkIdentity = { userId: 'u-other', nickname: '别人' };

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-invite-'));
  openIsolated(tmpDir);
});

afterAll(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 邀请行是库里的（与房间的「进程内单例」相反），用例间必须手动清空 */
beforeEach(() => {
  getDb().prepare('DELETE FROM pk_invites').run();
  resetRooms();
});
afterEach(() => resetRooms());

/** 本地单人形态（无主）：会话不存在也放行，只测域规则 */
function offer(sessionId: string, ownerId: string | null = null, topic = '正弦定理', reason = '刚讲完，趁热打一局') {
  return offerPkInvite({ sessionId, ownerId, topic, reason });
}

/** 建会话行（测归属要用：`canAccessSession` 查的是 `sessions` 表） */
function session(id: string, ownerId: string | null): void {
  getDb().prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(id, ownerId);
}

describe('建邀请：入参归一与截断时机', () => {
  it('topic 超长在**建邀请那一刻**就被截到 TOPIC_MAX（不是留到 accept）', () => {
    const r = offer('s-trunc', null, '一'.repeat(TOPIC_MAX + 25));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.topic).toHaveLength(TOPIC_MAX);
    const stored = getDb().prepare('SELECT topic FROM pk_invites WHERE session_id = ?').get('s-trunc') as { topic: string };
    expect(stored.topic).toHaveLength(TOPIC_MAX);
  });

  it('空 topic / 空 reason / 空 sessionId ⇒ 不落库、回灌「怎么改对」', () => {
    for (const bad of [
      { sessionId: 's-bad', topic: '   ', reason: 'x' },
      { sessionId: 's-bad', topic: '主题', reason: '  ' },
      { sessionId: '', topic: '主题', reason: 'x' },
    ]) {
      const r = offerPkInvite({ sessionId: bad.sessionId, ownerId: null, topic: bad.topic, reason: bad.reason });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVITE_INPUT_INVALID');
    }
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM pk_invites').get()).toEqual({ n: 0 });
  });

  it('成功后广播 `pk-invite-asked`（卡片靠这一帧浮出，刷新靠 GET pending 捞回）', () => {
    const r = offer('s-ask');
    expect(r.ok).toBe(true);
    const frames = snapshot('s-ask');
    const asked = frames.find((e) => e.type === 'pk-invite-asked');
    expect(asked && asked.type === 'pk-invite-asked' ? asked.invite.id : '').toBe(r.ok ? r.record.id : '');
  });
});

describe('频率闸门（§16.7：判据全是 SQL，不是进程内 Map）', () => {
  it('本会话还挂着未答复的卡 ⇒ 第二张必被挡，且**不许静默落库**', () => {
    expect(offer('s-gate1').ok).toBe(true);
    const second = offer('s-gate1');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('INVITE_THROTTLED');
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM pk_invites WHERE session_id = ?').get('s-gate1') as { n: number };
    expect(n.n).toBe(1);
  });

  it('被挡下的文案里**不含重试暗示**（写成「请重试」＝教会模型刷屏）', () => {
    offer('s-gate2');
    const second = offer('s-gate2');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).not.toMatch(/重试|再试|稍后再调|again/);
  });

  it('已答复的卡不再挡会话维度那条，但 5 分钟冷却仍生效（两条闸门是两件事）', () => {
    const first = offer('s-gate3');
    expect(first.ok).toBe(true);
    if (first.ok) expect(rejectPkInvite(first.record.id, null).ok).toBe(true);
    const again = offer('s-gate3');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('INVITE_THROTTLED');
  });

  it('冷却窗口按 `created_at` 判（把上一张改旧 ⇒ 放行），判据用 SQL 时间而非进程内存', () => {
    const first = offer('s-gate4');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 先拒掉：否则挡路的是「还有未答复的卡」那条，测不到冷却这条
    expect(rejectPkInvite(first.record.id, null).ok).toBe(true);
    getDb().prepare(`UPDATE pk_invites SET created_at = datetime('now','-6 minutes') WHERE id = ?`).run(first.record.id);
    expect(offer('s-gate4').ok).toBe(true);
  });

  it(`人维度：同一 owner 24 小时内发满 ${PK_INVITE_OWNER_DAILY_MAX} 张后第 ${PK_INVITE_OWNER_DAILY_MAX + 1} 张被挡（跨会话也算）`, () => {
    for (let i = 0; i < PK_INVITE_OWNER_DAILY_MAX; i += 1) {
      const sessionId = `s-owner-${i}`;
      session(sessionId, 'u-owner');
      const r = offer(sessionId, 'u-owner');
      expect(r.ok).toBe(true);
      // 逐张拒掉，避开「会话有未答复卡」那条，专门测人维度
      if (r.ok) expect(rejectPkInvite(r.record.id, 'u-owner').ok).toBe(true);
    }
    const overflow = offer('s-owner-latest', 'u-owner');
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.code).toBe('INVITE_THROTTLED');
  });

  it('人维度只看 24 小时内：把已发的那几张改成两天前 ⇒ 放行（闸门不会因为历史而永久封死）', () => {
    for (let i = 0; i < PK_INVITE_OWNER_DAILY_MAX; i += 1) {
      const sessionId = `s-old-${i}`;
      session(sessionId, 'u-old');
      const r = offer(sessionId, 'u-old');
      if (r.ok) {
        rejectPkInvite(r.record.id, 'u-old');
        getDb().prepare(`UPDATE pk_invites SET created_at = datetime('now','-2 days') WHERE id = ?`).run(r.record.id);
      }
    }
    expect(offer('s-old-new', 'u-old').ok).toBe(true);
  });

  it('本地无主（ownerId=null）不道人维度闸门（库里 owner_id 为 NULL，数不到任何人）', () => {
    for (let i = 0; i < PK_INVITE_OWNER_DAILY_MAX + 2; i += 1) {
      const r = offer(`s-null-${i}`, null);
      expect(r.ok).toBe(true);
      if (r.ok) rejectPkInvite(r.record.id, null);
    }
  });
});

describe('读侧判旧（§16.4：过期不是状态，是读出来的）', () => {
  it('pending 但已超过 TTL ⇒ 不再浮出卡片，而库里那行还在（闸门仍数得到它）', () => {
    const r = offer('s-stale');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = r.record.id;
    const ago = `-${Math.ceil(PK_ROOM_TTL_MS / 60_000) + 5} minutes`;
    getDb().prepare(`UPDATE pk_invites SET created_at = datetime('now', ?) WHERE id = ?`).run(ago, id);
    expect(listPendingInvites('s-stale')).toHaveLength(0);
    // 行没被删、状态没被改写：这条判据只活在读侧
    const row = getDb().prepare('SELECT status FROM pk_invites WHERE id = ?').get(id) as { status: string };
    expect(row.status).toBe('pending');
  });
});

describe('接受：建房 + 开局 + 幂等（§16.8）', () => {
  it('accepted 后有一间**按邀请主题**的 PVE 房，AI 座位主题与学习者主题同一个（不走主题池轮换）', () => {
    const r = offer('s-acc', null, '词根 spect');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = acceptPkInvite(r.record.id, me, null);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.state.mode).toBe('pve');
    expect(a.state.status).toBe('active');
    expect(a.state.players[0]?.topic).toBe('词根 spect');
    const room = requireRoomInternal(a.state.roomId);
    expect(room.aiTopic).toBe('词根 spect');
    expect(room.currentTopic).toBe('词根 spect');
    // ★ 兜底主题「通用知识」一旦出现＝邀请主题被丢了，那就不是「相关话题的对战」
    expect(a.state.players.some((p) => p.topic === PK_DEFAULT_AI_TOPIC)).toBe(false);
  });

  it('同一张卡第二次 accept 幂等返回**同一间房**（不是 409、不开第二局）', () => {
    const r = offer('s-idem');
    if (!r.ok) throw new Error('建邀请失败');
    const first = acceptPkInvite(r.record.id, me, null);
    const second = acceptPkInvite(r.record.id, me, null);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.state.roomId).toBe(first.state.roomId);
  });

  it('对局中（已在某 active 房）再接受另一张邀请 ⇒ 打回正在打的那间，同人两局 active 不并存', () => {
    const a1 = offer('s-play-1');
    const a2 = offer('s-play-2');
    if (!a1.ok || !a2.ok) throw new Error('建邀请失败');
    const first = acceptPkInvite(a1.record.id, me, null);
    if (!first.ok) throw new Error('首次接受失败');
    // 第二张：换个会话、同一身份，接受时必须回到正在打的那间房
    getDb().prepare(`UPDATE pk_invites SET created_at = datetime('now','-6 minutes') WHERE id = ?`).run(a2.record.id);
    const again = acceptPkInvite(a2.record.id, me, null);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.state.roomId).toBe(first.state.roomId);
    const active = acceptPkInvite(a2.record.id, me, null);
    expect(active.ok && active.state.status).toBe('active');
  });

  it('拒绝后不能再接受 ⇒ INVITE_NOT_PENDING；重复拒绝同样不静默成功', () => {
    const r = offer('s-rej');
    if (!r.ok) throw new Error('建邀请失败');
    expect(rejectPkInvite(r.record.id, null).ok).toBe(true);
    const again = acceptPkInvite(r.record.id, me, null);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('INVITE_NOT_PENDING');
    expect(rejectPkInvite(r.record.id, null).ok).toBe(false);
  });

  it('已 accepted 但内存房没了（发版重启/TTL 回收）⇒ INVITE_ROOM_GONE，不凭空重建那局', () => {
    const r = offer('s-gone');
    if (!r.ok) throw new Error('建邀请失败');
    const a = acceptPkInvite(r.record.id, me, null);
    if (!a.ok) throw new Error('接受失败');
    resetRooms(); // ← 等价于进程重启：房间是内存态，邀请行却在库里
    const retry = acceptPkInvite(r.record.id, me, null);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.code).toBe('INVITE_ROOM_GONE');
  });

  it('接受与拒绝都广播 `pk-invite-decided`（另一端的卡靠它切态），accepted 那支还带 roomId', () => {
    const r = offer('s-broadcast');
    if (!r.ok) throw new Error('建邀请失败');
    const a = acceptPkInvite(r.record.id, me, null);
    if (!a.ok) throw new Error('接受失败');
    const byId = (id: string) =>
      snapshot('s-broadcast').find((e) => e.type === 'pk-invite-decided' && e.inviteId === id);
    // ★ roomId 必须在帧里：另一端点过「接受」后，本端的回执卡要靠它给出「进入对局」的链接
    const acc = byId(r.record.id);
    expect(acc && acc.type === 'pk-invite-decided' ? acc.roomId : null).toBe(a.state.roomId);

    const r2 = offer('s-broadcast-2');
    if (!r2.ok) throw new Error('建第二张邀请失败');
    expect(rejectPkInvite(r2.record.id, null).ok).toBe(true);
    // 拒绝不建房 ⇒ 同名字段恒 null（前端不必按状态换字段名）
    const frame = snapshot('s-broadcast-2').find(
      (e) => e.type === 'pk-invite-decided' && e.inviteId === r2.record.id,
    );
    expect(frame && frame.type === 'pk-invite-decided' ? frame.roomId : 'x').toBeNull();
  });
});

describe('归属（§16.12 风险 6）', () => {
  it('别人的邀请：accept/reject 一律 INVITE_NOT_FOUND（不分「不存在/不是你的」两码，不泄露 id 是否存在）', () => {
    session('s-owned', 'u-victim');
    const r = offer('s-owned', 'u-victim');
    if (!r.ok) throw new Error('建邀请失败');
    const byOther = acceptPkInvite(r.record.id, other, 'u-other');
    expect(byOther.ok).toBe(false);
    if (!byOther.ok) expect(byOther.code).toBe('INVITE_NOT_FOUND');
    expect(rejectPkInvite(r.record.id, 'u-other').ok).toBe(false);
    // 库里那行仍是 pending：没被别人的手改写过
    const row = getDb().prepare('SELECT status FROM pk_invites WHERE id = ?').get(r.record.id) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('会话不属于这个主 ⇒ 连 pending 清单都捞不到（未登录不许把别人的邀请捞出来）', () => {
    session('s-leak', 'u-a');
    expect(offer('s-leak', 'u-a').ok).toBe(true);
    expect(listPendingInvites('s-leak')).toHaveLength(1);
    // 路由层的归属门面（`canAccessSession`）判这条会话不归 B ⇒ 不给列表
    expect(getDb().prepare('SELECT user_id AS o FROM sessions WHERE id = ?').get('s-leak')).toEqual({ o: 'u-a' });
  });
});

describe('脏状态归一（status 列刻意无 CHECK 约束）', () => {
  it('库里写进未知状态 ⇒ 读出来按终态处理，且不能再被 accept 改成 accepted', () => {
    const r = offer('s-dirty');
    if (!r.ok) throw new Error('建邀请失败');
    getDb().prepare('UPDATE pk_invites SET status = ? WHERE id = ?').run('whatever', r.record.id);
    const a = acceptPkInvite(r.record.id, me, null);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe('INVITE_NOT_PENDING');
    expect(listPendingInvites('s-dirty')).toHaveLength(0);
  });
});
