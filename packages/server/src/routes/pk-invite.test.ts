/**
 * routes/pk-invite — §16「AI 主动发起对战」的 HTTP 面（契约 docs/PK-SPEC.md §16.13 的 T4）。
 *
 * 钉四件事：
 * ① **REST 侧没有创建口子**：邀请只能由模型的工具发出。直接 `POST /api/pk/invites` 必须 404——
 *    留着这个口，§16.7 那三条闸门就挡不住「任何人都能给自己刷一张卡」（闸门的判据是数库，
 *    管不住一个本该存在的公开端点）。
 * ② 状态码纪律：别人的/不存在的邀请一律 404（「不存在」与「不是你的」合一个码＝不泄露 id），
 *    已拒绝的再接受 409，内存房没了 404 `INVITE_ROOM_GONE`。
 * ③ 接受必须**点火 1s ticker**。★ 本轮实测逮到的真漏洞：接受走的是域层 `acceptInviteRoom`，
 *    不经过 `POST /rooms/:id/start`，而 ticker 的点火语句住在那个端点里（`routes/pk.ts:192`）
 *    ⇒ 少这一行**不报错、不红灯**，症状是对局永远不动（AI 不出题、超时不判、8 分钟不结算）。
 *    所以这条锁用 mock 断「被调过」，而不是断结果——结果在这个测试环境里根本不会发生。
 * ④ GET /pending 的三重过滤：会话归属 + 未答复 + 未过旧。
 *
 * 邀请一律用域函数 `offerPkInvite` 造（那是工具的唯一入口，也是契约里唯一的写入口），
 * HTTP 层只负责用户侧的三个动作。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, PK_INVITE_SESSION_COOLDOWN_MS, type PkRoomState } from '@sb/shared';

// ticker 只换掉点火语句本身（其余导出原样）：既能让 ③ 可断言，也让测试进程不留真定时器
vi.mock('../pk/match.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureTicker: vi.fn(),
}));

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pk-invite-test-'));
// 线上形态：身份一律走会话 cookie（同 pk-match.test.ts），401 分支才测得到
process.env.SB_REQUIRE_AUTH = '1';
const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { resetRooms } = await import('../pk/room.js');
const { ensureTicker } = await import('../pk/match.js');
const { offerPkInvite } = await import('../pk/invite.js');
const request = (await import('supertest')).default;

// 写操作过跨源闸门：模拟合法前端源（同 pk-match.test.ts）
const origin = 'http://localhost:5173';
const post = (url: string, cookie?: string) => {
  const r = request(app).post(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};
const get = (url: string, cookie?: string) => {
  const r = request(app).get(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};

let userSeq = 0;
let sessionSeq = 0;

/** 建账号 + 属于他的会话行（`canAccessSession` 查的是 `sessions`），返回 cookie 与会话 id */
async function login(): Promise<{ userId: string; cookie: string; sessionId: string }> {
  const { createUser } = await import('../auth/users.js');
  const { createSession } = await import('../auth/session.js');
  const user = await createUser(`pk-invite-${++userSeq}@test.local`, 'good-password-1', `甲${userSeq}`);
  const { token } = createSession(user.id);
  const sessionId = `s-http-${sessionSeq}`;
  sessionSeq += 1;
  getDb().prepare('INSERT INTO sessions (id, user_id) VALUES (?, ?)').run(sessionId, user.id);
  return { userId: user.id, cookie: `${AUTH_COOKIE_NAME}=${token}`, sessionId };
}

/** 造一张属于这个人的邀请（域函数＝工具的唯一入口），返回邀请 id */
function seedInvite(sessionId: string, ownerId: string | null, topic = '正弦定理的应用'): string {
  const r = offerPkInvite({ sessionId, ownerId, topic, reason: '刚讲完这个知识点' });
  if (!r.ok) throw new Error(`邀请造失败（测试前置）：${r.error}`);
  return r.record.id;
}

const inviteCount = (): number =>
  (getDb().prepare('SELECT COUNT(*) AS n FROM pk_invites').get() as { n: number }).n;

beforeEach(() => {
  resetRooms();
  getDb().prepare('DELETE FROM pk_invites').run();
  vi.mocked(ensureTicker).mockClear();
});

afterAll(() => {
  closeDb();
});

describe('创建口子只有一条（§16.7 闸门的前提）', () => {
  it('POST /api/pk/invites 不存在 ⇒ 全局 404、不落库（有口就能刷，闸门数库也挡不住）', async () => {
    const a = await login();
    const r = await post('/api/pk/invites', a.cookie).send({ sessionId: a.sessionId, topic: '想给自己刷一张卡' });
    expect(r.status).toBe(404);
    // 是全局兜底的 404（`{ error: 'not found' }`），不是路由里那个带 code 的「邀请不存在」
    expect((r.body as { code?: string }).code).toBeUndefined();
    expect(inviteCount()).toBe(0);
  });
});

describe('GET /pending（刷新/重连把卡捞回来）', () => {
  it('自己的会话有未答复的卡 ⇒ 200 数组，记录是 camelCase 的邀请形状', async () => {
    const a = await login();
    const id = seedInvite(a.sessionId, a.userId);
    const r = await get(`/api/pk/invites/pending?sessionId=${a.sessionId}`, a.cookie);
    expect(r.status).toBe(200);
    const list = r.body as Array<{ id: string; status: string; topic: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, status: 'pending', topic: '正弦定理的应用' });
    expect(list[0]).not.toHaveProperty('session_id'); // 对外不泄列名形状
  });

  it('会话缺省 / 不存在 / 属于别人 ⇒ 同一个 404（不伪装成「200 空数组」）', async () => {
    const a = await login();
    const b = await login();
    seedInvite(b.sessionId, b.userId);
    expect((await get('/api/pk/invites/pending', a.cookie)).status).toBe(404);
    expect((await get('/api/pk/invites/pending?sessionId=s-ghost', a.cookie)).status).toBe(404);
    // 别人的会话：即使里面真有卡，也不给看（拿到 404 而不是空数组＝不承认它有卡）
    expect((await get(`/api/pk/invites/pending?sessionId=${b.sessionId}`, a.cookie)).status).toBe(404);
  });

  it('已答复的卡不再浮出（拒的是状态、不是删行）；「过旧不浮出」的判据在域层测（pk/invite.test.ts）', async () => {
    const a = await login();
    const id = seedInvite(a.sessionId, a.userId);
    const pendingUrl = `/api/pk/invites/pending?sessionId=${a.sessionId}`;
    expect((await get(pendingUrl, a.cookie)).body).toHaveLength(1);
    expect((await post(`/api/pk/invites/${id}/reject`, a.cookie).send({})).status).toBe(200);
    expect((await get(pendingUrl, a.cookie)).body).toHaveLength(0);
    expect(inviteCount()).toBe(1); // 拒的是状态，不是删行
  });
});

describe('POST /:id/accept', () => {
  it('200 { invite, state }：按邀请主题的 PVE 房已开局，卡片转 accepted', async () => {
    const a = await login();
    const id = seedInvite(a.sessionId, a.userId, '词根 spect 的衍生词');
    const r = await post(`/api/pk/invites/${id}/accept`, a.cookie).send({});
    expect(r.status).toBe(200);
    const { invite, state } = r.body as { invite: { status: string; roomId: string | null }; state: PkRoomState };
    expect(invite.status).toBe('accepted');
    expect(invite.roomId).toBe(state.roomId);
    expect(state.mode).toBe('pve');
    expect(state.status).toBe('active');
    expect(state.players[0]?.topic).toBe('词根 spect 的衍生词');
  });

  it('接受会点火 1s ticker（★ 漏点锁：本路径不经过 POST /rooms/:id/start）', async () => {
    const a = await login();
    const id = seedInvite(a.sessionId, a.userId);
    expect(vi.mocked(ensureTicker)).not.toHaveBeenCalled();
    expect((await post(`/api/pk/invites/${id}/accept`, a.cookie).send({})).status).toBe(200);
    expect(vi.mocked(ensureTicker)).toHaveBeenCalledTimes(1);
  });

  it('重复点接受 ⇒ 200 且是同一间房（误触不吃 409，也不开第二局）', async () => {
    const a = await login();
    const id = seedInvite(a.sessionId, a.userId);
    const first = await post(`/api/pk/invites/${id}/accept`, a.cookie).send({});
    const second = await post(`/api/pk/invites/${id}/accept`, a.cookie).send({});
    expect(second.status).toBe(200);
    expect((second.body as { state: PkRoomState }).state.roomId).toBe(
      (first.body as { state: PkRoomState }).state.roomId,
    );
  });

  it('无 cookie ⇒ 401；别人的卡 / 不存在的 id ⇒ 404（同码，不泄露 id 是否存在）', async () => {
    const a = await login();
    const b = await login();
    const id = seedInvite(b.sessionId, b.userId);
    expect((await post(`/api/pk/invites/${id}/accept`).send({})).status).toBe(401);
    const byOther = await post(`/api/pk/invites/${id}/accept`, a.cookie).send({});
    expect(byOther.status).toBe(404);
    expect((byOther.body as { code: string }).code).toBe('INVITE_NOT_FOUND');
    const ghost = await post('/api/pk/invites/i-ghost/accept', a.cookie).send({});
    expect((ghost.body as { code: string }).code).toBe('INVITE_NOT_FOUND');
    // 别人的手没改库
    expect((getDb().prepare('SELECT status FROM pk_invites WHERE id = ?').get(id) as { status: string }).status).toBe(
      'pending',
    );
  });

  it('已拒绝的卡再接受 ⇒ 409 INVITE_NOT_PENDING（终态不可逆）', async () => {
    const a = await login();
    const id = seedInvite(a.sessionId, a.userId);
    expect((await post(`/api/pk/invites/${id}/reject`, a.cookie).send({})).status).toBe(200);
    const r = await post(`/api/pk/invites/${id}/accept`, a.cookie).send({});
    expect(r.status).toBe(409);
    expect((r.body as { code: string }).code).toBe('INVITE_NOT_PENDING');
  });

  it('已接受但内存房没了（发版重启 / TTL 回收）⇒ 404 INVITE_ROOM_GONE，不凭空重建那一局', async () => {
    const a = await login();
    const id = seedInvite(a.sessionId, a.userId);
    expect((await post(`/api/pk/invites/${id}/accept`, a.cookie).send({})).status).toBe(200);
    resetRooms(); // ← 等价进程重启：房间是内存态，邀请行却在库里指着它
    const r = await post(`/api/pk/invites/${id}/accept`, a.cookie).send({});
    expect(r.status).toBe(404);
    expect((r.body as { code: string }).code).toBe('INVITE_ROOM_GONE');
  });
});

describe('POST /:id/reject', () => {
  it('200 返回置好终态的记录；重复拒绝 ⇒ 409（不静默成功）', async () => {
    const a = await login();
    const id = seedInvite(a.sessionId, a.userId);
    const r = await post(`/api/pk/invites/${id}/reject`, a.cookie).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, status: 'rejected' });
    const again = await post(`/api/pk/invites/${id}/reject`, a.cookie).send({});
    expect(again.status).toBe(409);
  });

  it('拒绝不要求登录态之外的东西：别人的卡 ⇒ 404（和 accept 同一个门面）', async () => {
    const a = await login();
    const b = await login();
    const id = seedInvite(b.sessionId, b.userId);
    expect((await post(`/api/pk/invites/${id}/reject`, a.cookie).send({})).status).toBe(404);
  });

  it('拒掉后同一会话立即可发第二张？——不：冷却仍生效（闸门第二条是量，不是状态）', async () => {
    const a = await login();
    const id = seedInvite(a.sessionId, a.userId);
    expect((await post(`/api/pk/invites/${id}/reject`, a.cookie).send({})).status).toBe(200);
    const second = offerPkInvite({ sessionId: a.sessionId, ownerId: a.userId, topic: '再来一局', reason: '趁热' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('INVITE_THROTTLED');
    // 把上一张改到冷却窗外 ⇒ 放行（证明挡路的是时间窗而不是「有历史」）
    getDb()
      .prepare(`UPDATE pk_invites SET created_at = datetime('now', ?) WHERE id = ?`)
      .run(`-${Math.round(PK_INVITE_SESSION_COOLDOWN_MS / 1000) + 5} seconds`, id);
    expect(offerPkInvite({ sessionId: a.sessionId, ownerId: a.userId, topic: '再来一局', reason: '趁热' }).ok).toBe(true);
  });
});
