/**
 * routes/pk 房间端到端（supertest，同 pk-auth.test.ts 手法）。
 * 钉 P0-1 房间契约（docs/PK-SPEC.md §2.1/§2.2/§4）：建房幂等 / 入房与满员 / 房主开局 /
 * 快照 / 频道隔离。计分与出题属 P0-2，不在本文件。
 *
 * ★ B1（§14.1，2026-09-20）改写：身份从「客户端自报 userId」换成统一账号 cookie 会话。
 *   本文件跑在 **cloud 形态**（SB_REQUIRE_AUTH=1）——PK 是多人在线功能，按线上语义钉：
 *   未登录 401、身份只认 cookie、客户端自报的 userId/nickname 一律无效。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, PK_MATCH_MS, PK_MAX_PLAYERS, PK_ROOM_CODE_LEN, pkChannel } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pk-room-test-'));
process.env.SB_REQUIRE_AUTH = '1';
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { resetRooms } = await import('../pk/room.js');
const { snapshot } = await import('../chat/sse-bus.js');
const request = (await import('supertest')).default;

// 写操作过跨源闸门（originCheck）：与 pk-auth.test.ts 同款，模拟合法前端源
const origin = 'http://localhost:5173';
const post = (url: string, cookie?: string) => {
  const r = request(app).post(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};
const get = (url: string, cookie?: string) => {
  const r = request(app).get(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};

interface Identity {
  userId: string;
  nickname: string;
  /** 统一账号会话 cookie（`sb_sid=<token>`），之后每个请求都得带上 */
  cookie: string;
}

interface PlayerLite {
  userId: string;
  nickname: string;
  score: number;
  correct: number;
  answered: number;
  lastQuizAt: number;
}

interface StateLite {
  roomId: string;
  roomCode: string;
  status: string;
  players: PlayerLite[];
  endsAt: number;
  questions: unknown[];
  nextQuizAt: Record<string, number>;
  winner?: string;
}

/**
 * 建一个统一账号并取出会话 cookie（同 tenancy.test.ts 的 signUp 手法）。
 * 不借道注册端点：省一次发信打桩，也不吃注册限流名额。邮箱带序号防 UNIQUE 冲突。
 */
let userSeq = 0;
async function login(nickname: string): Promise<Identity> {
  const { createUser } = await import('../auth/users.js');
  const { createSession } = await import('../auth/session.js');
  const user = await createUser(`pk-room-${++userSeq}@test.local`, 'good-password-1', nickname);
  const { token } = createSession(user.id);
  return { userId: user.id, nickname: user.nickname, cookie: `${AUTH_COOKIE_NAME}=${token}` };
}

async function createRoom(identity: Identity): Promise<{ roomId: string; roomCode: string; state: StateLite }> {
  // P0-7：建房人顺带定自己的主题（入房的人在 makeFullRoom 里补选）
  const res = await post('/api/pk/rooms', identity.cookie).send({ topic: '历史' });
  expect(res.status).toBe(201);
  return res.body as { roomId: string; roomCode: string; state: StateLite };
}

/** 建一间两人房（甲建房、乙入房），返回双方身份与房信息 */
async function makeFullRoom() {
  const alice = await login('甲');
  const bob = await login('乙');
  const room = await createRoom(alice);
  const joined = await post('/api/pk/rooms/join', bob.cookie).send({ roomCode: room.roomCode });
  expect(joined.status).toBe(200);
  // P0-7：乙方入房后补选自己的主题（开局前双方都得有）
  expect((await post(`/api/pk/rooms/${room.roomId}/topic`, bob.cookie).send({ topic: '地理' })).status).toBe(200);
  return { alice, bob, room, joinedState: joined.body.state as StateLite };
}

beforeEach(() => {
  // 房间是进程内单例，用例间必须清空（否则上一例的房号会串进下一例的满员判定）
  resetRooms();
});

describe('POST /api/pk/rooms（建房）', () => {
  it('建房：201 + 6 位数字房号 + 建房人当房主，初始零分', async () => {
    const alice = await login('甲');
    const { roomId, roomCode, state } = await createRoom(alice);
    expect(roomId).toMatch(/^r-/);
    expect(roomCode).toHaveLength(PK_ROOM_CODE_LEN);
    expect(roomCode).toMatch(/^\d+$/); // 纯数字：要能被人口头念出来
    expect(state.status).toBe('waiting');
    expect(state.players).toHaveLength(1);
    expect(state.players[0]?.userId).toBe(alice.userId);
    expect(state.players[0]?.nickname).toBe('甲');
    expect(state.players[0]?.score).toBe(0);
    expect(state.endsAt).toBe(0); // 未开局没有对局时钟
    expect(state.questions).toEqual([]); // P0-1 不出题
  });

  it('同一人重复建房 → 返回原房（幂等，不制造第二间）', async () => {
    const alice = await login('甲');
    const first = await createRoom(alice);
    const again = await createRoom(alice);
    expect(again.roomId).toBe(first.roomId);
    expect(again.roomCode).toBe(first.roomCode);
  });

  it('未登录 → 401（cookie 会话是唯一身份来源，自报 userId 无效）', async () => {
    const res = await post('/api/pk/rooms').send({ userId: 'u-ghost' });
    expect(res.status).toBe(401);
    expect((res.body as { code?: string }).code).toBe('UNAUTHENTICATED');
    const missing = await post('/api/pk/rooms').send({});
    expect(missing.status).toBe(401);
  });

  it('建房用服务端昵称，不信客户端自报（防冒名）', async () => {
    const alice = await login('真名');
    // 自报假 userId / 假 nickname 都不影响：身份与昵称都只从会话折算（pkIdentityOf）
    const res = await post('/api/pk/rooms', alice.cookie).send({ userId: 'u-forge', nickname: '假名' });
    expect(res.status).toBe(201);
    const players = (res.body.state as StateLite).players;
    expect(players[0]?.nickname).toBe('真名');
    expect(players[0]?.userId).toBe(alice.userId);
  });
});

describe('POST /api/pk/rooms/join（入房）', () => {
  it('凭房号入房：第二人进房，状态仍是 waiting（等房主开局）', async () => {
    const { bob, joinedState } = await makeFullRoom();
    expect(joinedState.players).toHaveLength(PK_MAX_PLAYERS);
    expect(joinedState.players[1]?.userId).toBe(bob.userId);
    expect(joinedState.status).toBe('waiting');
  });

  it('重复入同一间房 → 幂等（玩家不会被放进两次）', async () => {
    const { bob, room } = await makeFullRoom();
    const again = await post('/api/pk/rooms/join', bob.cookie).send({ roomCode: room.roomCode });
    expect(again.status).toBe(200);
    expect((again.body.state as StateLite).players).toHaveLength(PK_MAX_PLAYERS);
  });

  it('房号不存在 → 404', async () => {
    const alice = await login('甲');
    const res = await post('/api/pk/rooms/join', alice.cookie).send({ roomCode: '000000' });
    expect(res.status).toBe(404);
  });

  it('缺房号 → 400', async () => {
    const alice = await login('甲');
    expect((await post('/api/pk/rooms/join', alice.cookie).send({})).status).toBe(400);
    expect((await post('/api/pk/rooms/join', alice.cookie).send({ roomCode: '   ' })).status).toBe(400);
  });

  it('满员（第 3 人）→ 409，且房内仍是 2 人（失败不入房）', async () => {
    const { room } = await makeFullRoom();
    const carol = await login('丙');
    const res = await post('/api/pk/rooms/join', carol.cookie).send({ roomCode: room.roomCode });
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('ROOM_FULL');
    const state = await get(`/api/pk/rooms/${room.roomId}/state`, carol.cookie);
    expect((state.body.state as StateLite).players).toHaveLength(PK_MAX_PLAYERS);
  });

  it('每人只占一间 waiting 房：换房时旧房被回收（不留下空壳房号）', async () => {
    const alice = await login('甲');
    const first = await createRoom(alice);
    const second = await createRoom(alice);
    expect(second.roomId).toBe(first.roomId); // 重复建房幂等：直接回原房，不新建
    // 换条路径验证回收：甲改入乙的房，则甲自己那间 waiting 房（已空）应被摘掉
    const bob = await login('乙');
    const bobRoom = await createRoom(bob);
    const joined = await post('/api/pk/rooms/join', alice.cookie).send({ roomCode: bobRoom.roomCode });
    expect(joined.status).toBe(200);
    expect(joined.body.roomId).toBe(bobRoom.roomId);
    expect((await get(`/api/pk/rooms/${first.roomId}/state`, alice.cookie)).status).toBe(404);
  });
});

describe('POST /api/pk/rooms/:id/start（开局）', () => {
  it('正常开局（房主 + 双方已进房）→ active，endsAt = 服务端 now + 8 分钟', async () => {
    const { alice, room } = await makeFullRoom();
    const before = Date.now();
    const res = await post(`/api/pk/rooms/${room.roomId}/start`, alice.cookie).send({});
    expect(res.status).toBe(200);
    const state = res.body.state as StateLite;
    expect(state.status).toBe('active');
    expect(state.endsAt).toBeGreaterThanOrEqual(before + PK_MATCH_MS);
    expect(state.endsAt).toBeLessThanOrEqual(Date.now() + PK_MATCH_MS);
  });

  it('对手还没进房 → 409 ROOM_NOT_READY', async () => {
    const alice = await login('甲');
    const room = await createRoom(alice);
    const res = await post(`/api/pk/rooms/${room.roomId}/start`, alice.cookie).send({});
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('ROOM_NOT_READY');
  });

  it('非房主（后进房的人）→ 403 NOT_ROOM_OWNER', async () => {
    const { bob, room } = await makeFullRoom();
    const res = await post(`/api/pk/rooms/${room.roomId}/start`, bob.cookie).send({});
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('NOT_ROOM_OWNER');
  });

  it('重复开局 → 409 ROOM_NOT_WAITING（已 active 不再重置时钟）', async () => {
    const { alice, room } = await makeFullRoom();
    const first = await post(`/api/pk/rooms/${room.roomId}/start`, alice.cookie).send({});
    const endsAt = (first.body.state as StateLite).endsAt;
    const again = await post(`/api/pk/rooms/${room.roomId}/start`, alice.cookie).send({});
    expect(again.status).toBe(409);
    const state = await get(`/api/pk/rooms/${room.roomId}/state`, alice.cookie);
    expect((state.body.state as StateLite).endsAt).toBe(endsAt); // 时钟没被重置
  });

  it('房间不存在 → 404', async () => {
    const alice = await login('甲');
    const res = await post('/api/pk/rooms/r-ghost/start', alice.cookie).send({});
    expect(res.status).toBe(404);
  });
});

describe('GET /api/pk/rooms/:id/state（快照）', () => {
  it('返回房号 / 状态 / 玩家；不存在 → 404', async () => {
    const { alice, room } = await makeFullRoom();
    const res = await get(`/api/pk/rooms/${room.roomId}/state`, alice.cookie);
    expect(res.status).toBe(200);
    const state = res.body.state as StateLite;
    expect(state.roomCode).toBe(room.roomCode);
    expect(state.players[0]?.userId).toBe(alice.userId);
    expect((await get('/api/pk/rooms/r-ghost/state', alice.cookie)).status).toBe(404);
  });
});

describe('GET /api/pk/stream（房间频道）', () => {
  it('缺 roomId → 400；房间不存在 → 404（不让人挂空连接）', async () => {
    const { alice } = await makeFullRoom();
    expect((await get('/api/pk/stream', alice.cookie)).status).toBe(400);
    expect((await get('/api/pk/stream?roomId=r-ghost', alice.cookie)).status).toBe(404);
  });
});

describe('频道隔离（契约 §2.2：pk: 前缀 vs 聊天 sessionId）', () => {
  it('建房广播落在 pk:<roomId>，同名 sessionId 空间不受影响（串台防护）', async () => {
    const alice = await login('隔离甲');
    const { roomId } = await createRoom(alice);
    const evs = snapshot(pkChannel(roomId));
    expect(evs).toHaveLength(1);
    expect(evs[0]?.type).toBe('pk-state');
    // ★ 关键断言：裸 roomId 当频道键查，必须空——两者共用 sse-bus，只有前缀能防串台
    expect(snapshot(roomId)).toHaveLength(0);
    expect(snapshot(`pk:${roomId}`)).toHaveLength(1);
    expect(pkChannel(roomId)).toBe(`pk:${roomId}`);
  });

  it('入房与开局各自再广播一次状态（前端靠推送发现变化，不靠轮询）', async () => {
    const alice = await login('广播甲');
    const bob = await login('广播乙');
    const room = await createRoom(alice);
    await post('/api/pk/rooms/join', bob.cookie).send({ roomCode: room.roomCode });
    expect(snapshot(pkChannel(room.roomId))).toHaveLength(2);
    // P0-7：乙方补选主题同样广播一次（开局前双方都得有主题，否则开局 409）
    await post(`/api/pk/rooms/${room.roomId}/topic`, bob.cookie).send({ topic: '地理' });
    await post(`/api/pk/rooms/${room.roomId}/start`, alice.cookie).send({});
    const evs = snapshot(pkChannel(room.roomId));
    expect(evs).toHaveLength(4);
    expect(evs[3]?.type).toBe('pk-state');
  });
});

afterAll(() => {
  closeDb();
});
