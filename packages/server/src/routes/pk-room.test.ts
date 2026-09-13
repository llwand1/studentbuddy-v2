/**
 * routes/pk 房间端到端（supertest，同 pk-auth.test.ts 手法）。
 * 钉 P0-1 房间契约（docs/PK-SPEC.md §2.1/§2.2/§4）：建房幂等 / 入房与满员 / 房主开局 /
 * 快照 / 频道隔离。计分与出题属 P0-2，不在本文件。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PK_MATCH_MS, PK_MAX_PLAYERS, PK_ROOM_CODE_LEN, pkChannel } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pk-room-test-'));
const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { resetRooms } = await import('../pk/room.js');
const { snapshot } = await import('../chat/sse-bus.js');
const request = (await import('supertest')).default;

// 写操作过跨源闸门（originCheck）：与 pk-auth.test.ts 同款，模拟合法前端源
const origin = 'http://localhost:5173';
const post = (url: string) => request(app).post(url).set('Origin', origin);
const get = (url: string) => request(app).get(url).set('Origin', origin);

interface Identity {
  userId: string;
  nickname: string;
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

async function login(nickname: string): Promise<Identity> {
  const res = await post('/api/pk/auth/login').send({ nickname });
  expect(res.status).toBe(200);
  return res.body as Identity;
}

async function createRoom(userId: string): Promise<{ roomId: string; roomCode: string; state: StateLite }> {
  // P0-7：建房人顺带定自己的主题（入房的人在 makeFullRoom 里补选）
  const res = await post('/api/pk/rooms').send({ userId, topic: '历史' });
  expect(res.status).toBe(201);
  return res.body as { roomId: string; roomCode: string; state: StateLite };
}

/** 建一间两人房（甲建房、乙入房），返回双方身份与房信息 */
async function makeFullRoom() {
  const alice = await login('甲');
  const bob = await login('乙');
  const room = await createRoom(alice.userId);
  const joined = await post('/api/pk/rooms/join').send({ roomCode: room.roomCode, userId: bob.userId });
  expect(joined.status).toBe(200);
  // P0-7：乙方入房后补选自己的主题（开局前双方都得有）
  expect((await post(`/api/pk/rooms/${room.roomId}/topic`).send({ userId: bob.userId, topic: '地理' })).status).toBe(200);
  return { alice, bob, room, joinedState: joined.body.state as StateLite };
}

beforeEach(() => {
  // 房间是进程内单例，用例间必须清空（否则上一例的房号会串进下一例的满员判定）
  resetRooms();
});

describe('POST /api/pk/rooms（建房）', () => {
  it('建房：201 + 6 位数字房号 + 建房人当房主，初始零分', async () => {
    const alice = await login('甲');
    const { roomId, roomCode, state } = await createRoom(alice.userId);
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
    const first = await createRoom(alice.userId);
    const again = await createRoom(alice.userId);
    expect(again.roomId).toBe(first.roomId);
    expect(again.roomCode).toBe(first.roomCode);
  });

  it('未登录 / 不存在的 userId → 401 且不建出房来', async () => {
    const res = await post('/api/pk/rooms').send({ userId: 'u-ghost' });
    expect(res.status).toBe(401);
    const missing = await post('/api/pk/rooms').send({});
    expect(missing.status).toBe(401);
  });

  it('建房用服务端昵称，不信客户端自报（防冒名）', async () => {
    const alice = await login('真名');
    const res = await post('/api/pk/rooms').send({ userId: alice.userId, nickname: '假名' });
    expect(res.status).toBe(201);
    expect((res.body.state as StateLite).players[0]?.nickname).toBe('真名');
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
    const again = await post('/api/pk/rooms/join').send({ roomCode: room.roomCode, userId: bob.userId });
    expect(again.status).toBe(200);
    expect((again.body.state as StateLite).players).toHaveLength(PK_MAX_PLAYERS);
  });

  it('房号不存在 → 404', async () => {
    const alice = await login('甲');
    const res = await post('/api/pk/rooms/join').send({ roomCode: '000000', userId: alice.userId });
    expect(res.status).toBe(404);
  });

  it('缺房号 → 400', async () => {
    const alice = await login('甲');
    expect((await post('/api/pk/rooms/join').send({ userId: alice.userId })).status).toBe(400);
    expect((await post('/api/pk/rooms/join').send({ roomCode: '   ', userId: alice.userId })).status).toBe(400);
  });

  it('满员（第 3 人）→ 409，且房内仍是 2 人（失败不入房）', async () => {
    const { room } = await makeFullRoom();
    const carol = await login('丙');
    const res = await post('/api/pk/rooms/join').send({ roomCode: room.roomCode, userId: carol.userId });
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('ROOM_FULL');
    const state = await get(`/api/pk/rooms/${room.roomId}/state`);
    expect((state.body.state as StateLite).players).toHaveLength(PK_MAX_PLAYERS);
  });

  it('每人只占一间 waiting 房：换房时旧房被回收（不留下空壳房号）', async () => {
    const alice = await login('甲');
    const first = await createRoom(alice.userId);
    const second = await createRoom(alice.userId);
    expect(second.roomId).toBe(first.roomId); // 重复建房幂等：直接回原房，不新建
    // 换条路径验证回收：甲改入乙的房，则甲自己那间 waiting 房（已空）应被摘掉
    const bob = await login('乙');
    const bobRoom = await createRoom(bob.userId);
    const joined = await post('/api/pk/rooms/join').send({ roomCode: bobRoom.roomCode, userId: alice.userId });
    expect(joined.status).toBe(200);
    expect(joined.body.roomId).toBe(bobRoom.roomId);
    expect((await get(`/api/pk/rooms/${first.roomId}/state`)).status).toBe(404);
  });
});

describe('POST /api/pk/rooms/:id/start（开局）', () => {
  it('正常开局（房主 + 双方已进房）→ active，endsAt = 服务端 now + 8 分钟', async () => {
    const { alice, room } = await makeFullRoom();
    const before = Date.now();
    const res = await post(`/api/pk/rooms/${room.roomId}/start`).send({ userId: alice.userId });
    expect(res.status).toBe(200);
    const state = res.body.state as StateLite;
    expect(state.status).toBe('active');
    expect(state.endsAt).toBeGreaterThanOrEqual(before + PK_MATCH_MS);
    expect(state.endsAt).toBeLessThanOrEqual(Date.now() + PK_MATCH_MS);
  });

  it('对手还没进房 → 409 ROOM_NOT_READY', async () => {
    const alice = await login('甲');
    const room = await createRoom(alice.userId);
    const res = await post(`/api/pk/rooms/${room.roomId}/start`).send({ userId: alice.userId });
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('ROOM_NOT_READY');
  });

  it('非房主（后进房的人）→ 403 NOT_ROOM_OWNER', async () => {
    const { bob, room } = await makeFullRoom();
    const res = await post(`/api/pk/rooms/${room.roomId}/start`).send({ userId: bob.userId });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('NOT_ROOM_OWNER');
  });

  it('重复开局 → 409 ROOM_NOT_WAITING（已 active 不再重置时钟）', async () => {
    const { alice, room } = await makeFullRoom();
    const first = await post(`/api/pk/rooms/${room.roomId}/start`).send({ userId: alice.userId });
    const endsAt = (first.body.state as StateLite).endsAt;
    const again = await post(`/api/pk/rooms/${room.roomId}/start`).send({ userId: alice.userId });
    expect(again.status).toBe(409);
    const state = await get(`/api/pk/rooms/${room.roomId}/state`);
    expect((state.body.state as StateLite).endsAt).toBe(endsAt); // 时钟没被重置
  });

  it('房间不存在 → 404', async () => {
    const alice = await login('甲');
    const res = await post('/api/pk/rooms/r-ghost/start').send({ userId: alice.userId });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/pk/rooms/:id/state（快照）', () => {
  it('返回房号 / 状态 / 玩家；不存在 → 404', async () => {
    const { alice, room } = await makeFullRoom();
    const res = await get(`/api/pk/rooms/${room.roomId}/state`);
    expect(res.status).toBe(200);
    const state = res.body.state as StateLite;
    expect(state.roomCode).toBe(room.roomCode);
    expect(state.players[0]?.userId).toBe(alice.userId);
    expect((await get('/api/pk/rooms/r-ghost/state')).status).toBe(404);
  });
});

describe('GET /api/pk/stream（房间频道）', () => {
  it('缺 roomId → 400；房间不存在 → 404（不让人挂空连接）', async () => {
    expect((await get('/api/pk/stream')).status).toBe(400);
    expect((await get('/api/pk/stream?roomId=r-ghost')).status).toBe(404);
  });
});

describe('频道隔离（契约 §2.2：pk: 前缀 vs 聊天 sessionId）', () => {
  it('建房广播落在 pk:<roomId>，同名 sessionId 空间不受影响（串台防护）', async () => {
    const alice = await login('隔离甲');
    const { roomId } = await createRoom(alice.userId);
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
    const room = await createRoom(alice.userId);
    await post('/api/pk/rooms/join').send({ roomCode: room.roomCode, userId: bob.userId });
    expect(snapshot(pkChannel(room.roomId))).toHaveLength(2);
    // P0-7：乙方补选主题同样广播一次（开局前双方都得有主题，否则开局 409）
    await post(`/api/pk/rooms/${room.roomId}/topic`).send({ userId: bob.userId, topic: '地理' });
    await post(`/api/pk/rooms/${room.roomId}/start`).send({ userId: alice.userId });
    const evs = snapshot(pkChannel(room.roomId));
    expect(evs).toHaveLength(4);
    expect(evs[3]?.type).toBe('pk-state');
  });
});

afterAll(() => {
  closeDb();
});
