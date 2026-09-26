/**
 * routes/pk-terms — PK 出题的词条硬绑定（契约 docs/PK-SPEC.md §15.6，B3 批 2026-09-20）。
 *
 * 老板拍板「可选 + 选了即硬绑定」：不选走原路径（**请求体与 B3 之前逐字一致**，契约 T6 的
 * 服务端镜像）；选了＝词条约束进提示词 + 释义走 material（generateQuiz 第 2 参，此前恒 undefined）。
 *
 * 四条硬判据（§15.9 T4）：
 * ① 选词条后 generateQuiz 的入参带词条约束与释义素材；② **跨 ownerId 取不到别人的词条**
 * （隔离在 SQL WHERE 里，「不存在」与「不是你的」合成 404 一个码）；③ 超 5 条 → 400；
 * ④ 词条校验失败**不吃 CD**（输入错误不该罚人 60 秒冷却）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';
import { AUTH_COOKIE_NAME, type QuizQuestion } from '@sb/shared';

vi.mock('../learning/quiz.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateQuiz: vi.fn(),
}));

const { app, request, closeDb } = await boot('pk-terms-test', { requireAuth: true });
const origin = TEST_ORIGIN;

const { resetRooms, requireRoomInternal } = await import('../pk/room.js');
const { resetMatchState } = await import('../pk/match.js');
const { generateQuiz } = await import('../learning/quiz.js');

const post = (url: string, cookie?: string) => {
  const r = request(app).post(url).set('Origin', origin);
  return cookie ? r.set('Cookie', cookie) : r;
};

const SINGLE: QuizQuestion = {
  type: 'single',
  question: '世界上最大的海洋是哪一个？',
  options: ['大西洋', '太平洋', '印度洋', '北冰洋'],
  answer: [1],
};

let userSeq = 0;
async function login(nickname: string): Promise<{ userId: string; cookie: string }> {
  const { createUser } = await import('../auth/users.js');
  const { createSession } = await import('../auth/session.js');
  const user = await createUser(`pk-terms-${++userSeq}@test.local`, 'good-password-1', nickname);
  const { token } = createSession(user.id);
  return { userId: user.id, cookie: `${AUTH_COOKIE_NAME}=${token}` };
}

/** 通过词条 HTTP 接口建一条词条，返回 id（顺带回归「词条库 CRUD 与 PK 通道用同一个 owner 口径」） */
async function addTerm(cookie: string, term: string, definition: string): Promise<string> {
  const r = await post('/api/terms', cookie).send({ term, definition });
  expect(r.status).toBe(201);
  return (r.body as { id: string }).id;
}

/** 甲乙满员 + 开局（同 pk-match.test.ts 手法） */
async function makeActiveRoom() {
  const alice = await login('甲');
  const bob = await login('乙');
  const created = await post('/api/pk/rooms', alice.cookie).send({ topic: '历史' });
  expect(created.status).toBe(201);
  const { roomId, roomCode } = created.body as { roomId: string; roomCode: string };
  expect((await post('/api/pk/rooms/join', bob.cookie).send({ roomCode })).status).toBe(200);
  expect((await post(`/api/pk/rooms/${roomId}/topic`, bob.cookie).send({ topic: '地理' })).status).toBe(200);
  expect((await post(`/api/pk/rooms/${roomId}/start`, alice.cookie).send({})).status).toBe(200);
  return { alice, bob, roomId };
}

beforeEach(() => {
  resetRooms();
  resetMatchState();
  vi.mocked(generateQuiz).mockResolvedValue({ questions: [SINGLE] });
});

describe('§15.6 词条硬绑定 · 约束拼接与素材通道', () => {
  it('带 termIds 出题：提示词点名词条、material 走 generateQuiz 第 2 参（此前恒 undefined）', async () => {
    const { alice, roomId } = await makeActiveRoom();
    const id = await addTerm(alice.cookie, '丝绸之路', '古代连接亚欧的商贸路线');
    const r = await post(`/api/pk/rooms/${roomId}/quiz`, alice.cookie).send({
      prompt: '出一道贸易路线的题',
      termIds: [id],
    });
    expect(r.status).toBe(200);
    const call = vi.mocked(generateQuiz).mock.lastCall;
    if (!call) throw new Error('generateQuiz 未被调用');
    expect(call[0]).toContain('必须考察以下词条：丝绸之路（古代连接亚欧的商贸路线）');
    expect(call[1]).toContain('【丝绸之路】');
    expect(call[1]).toContain('古代连接亚欧的商贸路线');
  });

  it('不带 termIds 字段：走原路径——material 仍 undefined、提示词无词条字样（B3 之前逐字一致）', async () => {
    const { alice, roomId } = await makeActiveRoom();
    const r = await post(`/api/pk/rooms/${roomId}/quiz`, alice.cookie).send({ prompt: '出一道唐代的题' });
    expect(r.status).toBe(200);
    const call = vi.mocked(generateQuiz).mock.lastCall;
    if (!call) throw new Error('generateQuiz 未被调用');
    expect(call[1]).toBeUndefined();
    expect(call[0]).not.toContain('词条');
  });

  it('termIds 非字符串元素被过滤：null/数字不炸、全无效后等同没选', async () => {
    const { alice, roomId } = await makeActiveRoom();
    const r = await post(`/api/pk/rooms/${roomId}/quiz`, alice.cookie).send({
      prompt: '出一道题',
      termIds: [null, 42, ''],
    });
    expect(r.status).toBe(200);
    expect(vi.mocked(generateQuiz).mock.lastCall?.[1]).toBeUndefined();
  });
});

describe('§15.6 词条硬绑定 · 校验与错误码', () => {
  it('跨 ownerId：带别人的词条 id → 404 TERM_NOT_FOUND（不泄露「存在」）', async () => {
    const { alice, bob, roomId } = await makeActiveRoom();
    const alicesTerm = await addTerm(alice.cookie, '甲的私藏词条', '只属于甲');
    const r = await post(`/api/pk/rooms/${roomId}/quiz`, bob.cookie).send({
      prompt: '出一道题',
      termIds: [alicesTerm],
    });
    expect(r.status).toBe(404);
    expect((r.body as { code: string }).code).toBe('TERM_NOT_FOUND');
    // CD 未被消耗：修好词条 id 后立即可出（错误不吃冷却）
    expect(requireRoomInternal(roomId).nextQuizAt[bob.userId] ?? 0).toBeLessThanOrEqual(Date.now());
  });

  it('超过 5 条 → 400 TERM_LIMIT_EXCEEDED', async () => {
    const { alice, roomId } = await makeActiveRoom();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await addTerm(alice.cookie, `词条${i}`, `第 ${i} 条释义`));
    const r = await post(`/api/pk/rooms/${roomId}/quiz`, alice.cookie).send({ prompt: '出题', termIds: ids });
    expect(r.status).toBe(400);
    expect((r.body as { code: string }).code).toBe('TERM_LIMIT_EXCEEDED');
  });

  it('id 不存在 → 404 TERM_NOT_FOUND；重复 id 去重后不误伤合法请求', async () => {
    const { alice, roomId } = await makeActiveRoom();
    const missing = await post(`/api/pk/rooms/${roomId}/quiz`, alice.cookie).send({
      prompt: '出题',
      termIds: ['no-such-term'],
    });
    expect(missing.status).toBe(404);
    const id = await addTerm(alice.cookie, '去重词条', '重复传两遍也只算一条');
    const ok = await post(`/api/pk/rooms/${roomId}/quiz`, alice.cookie).send({
      prompt: '出题',
      termIds: [id, id],
    });
    expect(ok.status).toBe(200);
  });
});

afterAll(() => {
  closeDb();
});
