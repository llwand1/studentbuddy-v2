/**
 * routes/pk-history — P0-8 投降与对战历史（契约 docs/PK-SPEC.md §12）。
 *
 * 两种驱动方式（与 pk-match.test.ts 同款）：
 * ① HTTP（supertest）钉路由层：401/403/404/409 的映射与「别人的记录一律 404」；
 * ② 域函数 + 假时钟：时钟归零结算直接调 `tickMatches(endsAt + 1)`（不起真定时器）。
 *
 * 三件本文件专盯的事：
 * ★ **投降是认输，不是比分比较**——分高的一方投降也判负（`forfeit` 不得退化成「谁分高谁赢」）；
 * ★ **比分定格**——投降那一刻的分数原样入库，不退分也不加罚；
 * ★ **AI 不写历史行**——PVE 一局只给真人写一行（`ai-<roomId>` 永远不会登录来查战绩）。
 *
 * ★ B1（§14.1，2026-09-20）改写：HTTP 层身份换成统一账号 cookie 会话——
 *   `/matches` 的 `?userId=` 自证查询已删，归属只认会话；「别人的记录 404」用**另一个真账号**验证。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTH_COOKIE_NAME,
  PK_HISTORY_KEEP,
  PK_HISTORY_LIMIT,
  PK_HISTORY_MAX,
  pkChannel,
  type PkMatchRecord,
  type PkRoomState,
  type QuizQuestion,
} from '@sb/shared';

// 出题管道整体 mock：历史测试不依赖真模型（quiz.ts 其余导出原样保留）
vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateQuiz: vi.fn(),
}));

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pk-history-test-'));
process.env.SB_REQUIRE_AUTH = '1';
const { app } = await import('../index.js');
const { closeDb, getDb } = await import('../storage/db.js');
const { resetRooms, requireRoomInternal } = await import('../pk/room.js');
const { resetMatchState, tickMatches } = await import('../pk/match.js');
const { clampHistoryLimit, resetMatches } = await import('../pk/history.js');
const { generateQuiz } = await import('../learning/quiz.js');
const { snapshot } = await import('../chat/sse-bus.js');
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

/** 固定单选：正确答案下标 1 */
const SINGLE: QuizQuestion = {
  type: 'single',
  question: '世界上最大的海洋是哪一个？',
  options: ['大西洋', '太平洋', '印度洋', '北冰洋'],
  answer: [1],
};

interface Who {
  userId: string;
  nickname: string;
  cookie: string;
}

function player(roomId: string, userId: string) {
  const p = requireRoomInternal(roomId).players.find((x) => x.userId === userId);
  if (!p) throw new Error(`玩家 ${userId} 不在房内（测试前置失败）`);
  return p;
}

/** 建统一账号 + 取会话 cookie（同 pk-room.test.ts 手法） */
let userSeq = 0;
async function login(nickname: string): Promise<Who> {
  const { createUser } = await import('../auth/users.js');
  const { createSession } = await import('../auth/session.js');
  const user = await createUser(`pk-hist-${++userSeq}@test.local`, 'good-password-1', nickname);
  const { token } = createSession(user.id);
  return { userId: user.id, nickname: user.nickname, cookie: `${AUTH_COOKIE_NAME}=${token}` };
}

/** 甲乙满员 + 房主开局（双方各带主题，否则 409 TOPIC_NOT_SET） */
async function makeActiveRoom() {
  const alice = await login('甲');
  const bob = await login('乙');
  const created = await post('/api/pk/rooms', alice.cookie).send({ topic: '历史' });
  expect(created.status).toBe(201);
  const { roomId, roomCode } = created.body as { roomId: string; roomCode: string };
  expect((await post('/api/pk/rooms/join', bob.cookie).send({ roomCode })).status).toBe(200);
  expect((await post(`/api/pk/rooms/${roomId}/topic`, bob.cookie).send({ topic: '地理' })).status).toBe(200);
  const started = await post(`/api/pk/rooms/${roomId}/start`, alice.cookie).send({});
  expect(started.status).toBe(200);
  return { alice, bob, roomId, state: (started.body as { state: PkRoomState }).state };
}

/** PVE 房：房主 + AI 座位，房主直接开局 */
async function makePveRoom() {
  const alice = await login('甲');
  const created = await post('/api/pk/rooms', alice.cookie).send({ mode: 'pve', topic: '历史' });
  expect(created.status).toBe(201);
  const { roomId } = created.body as { roomId: string };
  expect((await post(`/api/pk/rooms/${roomId}/start`, alice.cookie).send({})).status).toBe(200);
  return { alice, roomId };
}

/** 出题并返回题目 id（mock 固定单选，题目发给对手） */
async function ask(roomId: string, who: Who, prompt = '秦朝建立时间'): Promise<string> {
  const res = await post(`/api/pk/rooms/${roomId}/quiz`, who.cookie).send({ prompt });
  expect(res.status).toBe(200);
  const state = (res.body as { state: PkRoomState }).state;
  const last = state.questions[state.questions.length - 1];
  if (!last) throw new Error('出题后快照里没有题目（测试前置失败）');
  return last.id;
}

/** 建房 → 入房 → 各选主题 → 开局 → **由对手认输**；返回该局 roomId（历史用例的通用铺路） */
async function quickMatch(owner: Who, opponent: Who): Promise<string> {
  const created = await post('/api/pk/rooms', owner.cookie).send({ topic: '历史' });
  expect(created.status).toBe(201);
  const { roomId, roomCode } = created.body as { roomId: string; roomCode: string };
  expect((await post('/api/pk/rooms/join', opponent.cookie).send({ roomCode })).status).toBe(200);
  expect((await post(`/api/pk/rooms/${roomId}/topic`, opponent.cookie).send({ topic: '地理' })).status).toBe(200);
  expect((await post(`/api/pk/rooms/${roomId}/start`, owner.cookie).send({})).status).toBe(200);
  expect((await forfeit(roomId, opponent)).status).toBe(200);
  return roomId;
}

const forfeit = (roomId: string, who: Who) =>
  post(`/api/pk/rooms/${roomId}/forfeit`, who.cookie).send({});

/** 查我的历史（身份只认 cookie；limit 省略 = 服务端缺省） */
async function myMatches(who: Who, limit?: number): Promise<PkMatchRecord[]> {
  const url = `/api/pk/matches${limit === undefined ? '' : `?limit=${limit}`}`;
  const res = await get(url, who.cookie);
  expect(res.status).toBe(200);
  return (res.body as { matches: PkMatchRecord[] }).matches;
}

beforeEach(() => {
  resetRooms();
  resetMatchState(); // 上一例可能留了真 ticker，先拆掉（假时钟测试不容真实时间插手）
  resetMatches();
  vi.mocked(generateQuiz).mockResolvedValue({ questions: [SINGLE] });
});

afterAll(() => {
  closeDb();
});

describe('投降 · 对方直接胜、比分定格（契约 §12.1）', () => {
  it('认输后置 finished、对手为胜者，且**比分停在投降那一刻**', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    const qid = await ask(roomId, alice); // 甲出题 +1
    const ans = await post(`/api/pk/rooms/${roomId}/answer`, bob.cookie).send({ questionId: qid, choice: 0 });
    expect(ans.status).toBe(200); // 乙答错 −1
    expect(player(roomId, alice.userId).score).toBe(1);
    expect(player(roomId, bob.userId).score).toBe(-1);

    const res = await forfeit(roomId, bob);
    expect(res.status).toBe(200);
    const state = (res.body as { state: PkRoomState }).state;
    expect(state.status).toBe('finished');
    expect(state.winner).toBe(alice.userId);
    expect(state.endReason).toBe('forfeit');
    // 比分原样：不退分、不加罚
    expect(state.players.find((p) => p.userId === alice.userId)?.score).toBe(1);
    expect(state.players.find((p) => p.userId === bob.userId)?.score).toBe(-1);
  });

  it('★ 分**更高**的一方投降也判负——投降是认输，不是比分比较', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    const qid = await ask(roomId, alice);
    await post(`/api/pk/rooms/${roomId}/answer`, bob.cookie).send({ questionId: qid, choice: 1 });
    // 甲 1（出题 +1）／乙 2（答对 +2）——乙分更高
    expect(player(roomId, alice.userId).score).toBe(1);
    expect(player(roomId, bob.userId).score).toBe(2);

    const res = await forfeit(roomId, bob);
    expect(res.status).toBe(200);
    const state = (res.body as { state: PkRoomState }).state;
    expect(state.winner).toBe(alice.userId);
    expect(state.players.find((p) => p.userId === bob.userId)?.score).toBe(2); // 定格，不退分
  });

  it('PVE 认输：AI 座位判胜', async () => {
    const { alice, roomId } = await makePveRoom();
    const ai = requireRoomInternal(roomId).players.find((p) => p.userId.startsWith('ai-'));
    const res = await forfeit(roomId, alice);
    expect(res.status).toBe(200);
    expect((res.body as { state: PkRoomState }).state.winner).toBe(ai?.userId);
  });

  it('广播 pk-end 且载荷带 endReason=forfeit（前端靠这一帧当场换文案）', async () => {
    const { bob, roomId } = await makeActiveRoom();
    await forfeit(roomId, bob);
    const end = snapshot(pkChannel(roomId)).find((e) => e.type === 'pk-end');
    expect(end).toBeDefined();
    const payload = end as unknown as { winner?: string; state: PkRoomState };
    expect(payload.state.endReason).toBe('forfeit');
    expect(payload.state.status).toBe('finished');
  });

  it('不在房内的玩家认输 → 403 NOT_A_PLAYER', async () => {
    const { roomId } = await makeActiveRoom();
    const outsider = await login('路人');
    const res = await forfeit(roomId, outsider);
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe('NOT_A_PLAYER');
  });

  it('waiting 房不能认输（没有输赢可认）→ 409 ROOM_NOT_ACTIVE', async () => {
    const alice = await login('甲');
    const created = await post('/api/pk/rooms', alice.cookie).send({ topic: '历史' });
    const { roomId } = created.body as { roomId: string };
    const res = await forfeit(roomId, alice);
    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe('ROOM_NOT_ACTIVE');
  });

  it('重复认输 → 409（已结束的局不再接受投降，也不改写胜者）', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    expect((await forfeit(roomId, bob)).status).toBe(200);
    const again = await forfeit(roomId, alice);
    expect(again.status).toBe(409);
    expect(requireRoomInternal(roomId).winner).toBe(alice.userId);
  });

  it('未登录认输 → 401（无会话＝无身份，不进域层）', async () => {
    const { roomId } = await makeActiveRoom();
    expect((await post(`/api/pk/rooms/${roomId}/forfeit`).send({})).status).toBe(401);
  });

  it('房不存在 → 404', async () => {
    const alice = await login('甲');
    expect((await forfeit('r-ghost', alice)).status).toBe(404);
  });
});

describe('对战历史 · 视角行落库（契约 §12.2）', () => {
  it('自然结束（时钟归零）：双方各一行，视角各自折算正确', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    const qid = await ask(roomId, alice);
    await post(`/api/pk/rooms/${roomId}/answer`, bob.cookie).send({ questionId: qid, choice: 0 }); // 乙答错
    tickMatches(requireRoomInternal(roomId).endsAt + 1); // 假时钟直接结算

    const a = await myMatches(alice);
    expect(a).toHaveLength(1);
    expect(a[0]!.outcome).toBe('win');
    expect(a[0]!.reason).toBe('timeup');
    expect(a[0]!.myScore).toBe(1);
    expect(a[0]!.oppScore).toBe(-1);
    expect(a[0]!.opponentNickname).toBe('乙');
    expect(a[0]!.quizCount).toBe(1);
    expect(a[0]!.mode).toBe('pvp');

    const b = await myMatches(bob);
    expect(b).toHaveLength(1);
    expect(b[0]!.outcome).toBe('lose'); // 同一局，乙的视角是负
    expect(b[0]!.opponentNickname).toBe('甲');
  });

  it('投降结束的历史 reason=forfeit，胜负按投降判定', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    await forfeit(roomId, bob);
    const a = await myMatches(alice);
    expect(a[0]!.reason).toBe('forfeit');
    expect(a[0]!.outcome).toBe('win');
    const b = await myMatches(bob);
    expect(b[0]!.reason).toBe('forfeit');
    expect(b[0]!.outcome).toBe('lose');
  });

  it('★ AI 不写历史行：PVE 一局只给真人一行', async () => {
    const { alice, roomId } = await makePveRoom();
    await forfeit(roomId, alice);
    const rows = getDb().prepare('SELECT user_id FROM pk_matches WHERE room_id = ?').all(roomId) as { user_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(alice.userId);
    expect((await myMatches(alice))[0]!.mode).toBe('pve');
  });

  it('历史只列自己的（一局两行，甲乙各一行且互不可见）', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    await forfeit(roomId, bob);
    const a = await myMatches(alice);
    const b = await myMatches(bob);
    expect(a[0]!.id).not.toBe(b[0]!.id); // 视角行是两行
    expect((getDb().prepare('SELECT id FROM pk_matches').all() as { id: string }[])).toHaveLength(2);
    expect(a.map((m) => m.id)).not.toContain(b[0]!.id);
  });

  it('最近的排在前面（用不同对手昵称验证顺序，不看时间戳）', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    await forfeit(roomId, bob); // 第一局：对手乙
    const ding = await login('丁');
    await quickMatch(alice, ding); // 第二局：对手丁（更晚）

    const a = await myMatches(alice);
    expect(a).toHaveLength(2);
    expect(a[0]!.opponentNickname).toBe('丁');
    expect(a[1]!.opponentNickname).toBe('乙');
  });

  it('未登录查历史 → 401（归属只认会话，不再有 ?userId= 自证）', async () => {
    expect((await get('/api/pk/matches')).status).toBe(401);
  });

  it('limit 归一（缺省 20 / 上限 100 / 非法回缺省 / 下限 1）', () => {
    expect(clampHistoryLimit(undefined)).toBe(PK_HISTORY_LIMIT);
    expect(clampHistoryLimit('')).toBe(PK_HISTORY_LIMIT);
    expect(clampHistoryLimit('abc')).toBe(PK_HISTORY_LIMIT);
    expect(clampHistoryLimit(0)).toBe(1);
    expect(clampHistoryLimit(-5)).toBe(1);
    expect(clampHistoryLimit(3)).toBe(3);
    expect(clampHistoryLimit(PK_HISTORY_MAX + 1)).toBe(PK_HISTORY_MAX);
    expect(clampHistoryLimit('7')).toBe(7);
  });

  it('★ 常量不变式：保留量 ≥ 单页上限（否则列表永远填不满）', () => {
    expect(PK_HISTORY_KEEP).toBeGreaterThanOrEqual(PK_HISTORY_MAX);
  });

  it('limit 生效：只回最近 N 局（拿到的正是最新的那局）', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    await forfeit(roomId, bob);
    await quickMatch(alice, await login('丁'));
    const one = await myMatches(alice, 1);
    expect(one).toHaveLength(1);
    expect(one[0]!.opponentNickname).toBe('丁');
  });

  it('★ 每人只留 PK_HISTORY_KEEP 条：超出即删最旧', async () => {
    const alice = await login('甲');
    const db = getDb();
    const ins = db.prepare(
      `INSERT INTO pk_matches (id, room_id, user_id, opponent_id, opponent_nickname, mode, my_score, opp_score, outcome, reason, quiz_count, snapshot_json, ended_at)
       VALUES (?, ?, ?, 'x', '旧对手', 'pvp', 0, 0, 'win', 'timeup', 0, '{}', ?)`,
    );
    for (let i = 0; i < PK_HISTORY_KEEP; i += 1) ins.run(`old-${i}`, `r-old-${i}`, alice.userId, 1000 + i);
    // 直查库计数（不走接口：接口有条数上限，用接口断言会把「上限生效」误读成「裁剪生效」）
    const countRows = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM pk_matches WHERE user_id = ?').get(alice.userId) as { n: number }).n;
    expect(countRows()).toBe(PK_HISTORY_KEEP);

    // 再落一局（走真实路径）→ 总数不变，最旧那条被挤掉
    await quickMatch(alice, await login('丁'));

    const left = db.prepare('SELECT id FROM pk_matches WHERE user_id = ?').all(alice.userId) as { id: string }[];
    expect(left).toHaveLength(PK_HISTORY_KEEP);
    expect(countRows()).toBe(PK_HISTORY_KEEP);
    expect(left.map((r) => r.id)).not.toContain('old-0'); // 最旧的走了
    expect(left.map((r) => r.id)).toContain(`old-${PK_HISTORY_KEEP - 1}`); // 较新的还在
  });
});

describe('历史详情 · 含末快照（契约 §12.2）', () => {
  it('详情带回可回看的题目（题干/选项/我选了什么/正确答案）', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    const qid = await ask(roomId, alice);
    await post(`/api/pk/rooms/${roomId}/answer`, bob.cookie).send({ questionId: qid, choice: 1 });
    tickMatches(requireRoomInternal(roomId).endsAt + 1); // 乙 2 > 甲 1 ⇒ 乙胜

    const list = await myMatches(bob);
    const res = await get(`/api/pk/matches/${list[0]!.id}`, bob.cookie);
    expect(res.status).toBe(200);
    const { match } = res.body as { match: { outcome: string; snapshot: PkRoomState } };
    expect(match.outcome).toBe('win');
    expect(match.snapshot.questions).toHaveLength(1);
    const q = match.snapshot.questions[0]!;
    expect(q.stem).toContain('海洋');
    expect(q.options).toHaveLength(4);
    expect(q.chosen).toBe(1);
    expect(q.answerRevealed).toBe(1); // 已判定 → 回看时才揭示
  });

  it('别人的记录 → 404 MATCH_NOT_FOUND（不泄露「这个 id 存在」）', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    await forfeit(roomId, bob);
    const a = await myMatches(alice);
    const res = await get(`/api/pk/matches/${a[0]!.id}`, bob.cookie);
    expect(res.status).toBe(404);
    expect((res.body as { code?: string }).code).toBe('MATCH_NOT_FOUND');
  });

  it('不存在的 id → 404；未登录 → 401', async () => {
    const alice = await login('甲');
    expect((await get('/api/pk/matches/nope', alice.cookie)).status).toBe(404);
    expect((await get('/api/pk/matches/nope')).status).toBe(401);
  });
});
