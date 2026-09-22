/**
 * routes/coach — 复习督促小窗端到端（supertest，同 term-review.test.ts 手法）。
 *
 * 钉五件事：① 快照与「该不该催」的判定（欠账口径、冷却）；② 卡片流水的落库与读取；
 * ③ 对话链路的真编排（落卡 + SSE 广播 + 失败也有交代）；④ 入参闸门与跨源；⑤ 多租户隔离。
 *
 * ★ 假模型而不是真调上游：本文件要验的是**编排**（落库/广播/错误分支），不是模型水平。
 *   真调用既慢又不确定，且会让 CI 依赖外网（同 chat-send.test.ts 桩掉 handleMessage 的取舍）。
 *   桩的是 `routeRole` 这一层，所以 `/send` 走的是**真**路由、真库、真 SSE 总线。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-coach-test-'));

/** 可控假模型：`fail` 非空则抛错（验"模型挂了也要有交代"那一支） */
const llm = vi.hoisted(() => ({ chunks: ['先背「闭包」', '，它欠得最久。'] as string[], fail: '' }));
vi.mock('../llm/router.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../llm/router.js')>();
  return {
    ...mod,
    routeRole: () => ({
      adapter: {
        type: 'openai' as const,
        async *chat() {
          if (llm.fail) throw new Error(llm.fail);
          for (const c of llm.chunks) yield { content: c, done: false };
          yield { content: '', done: true };
        },
        async listModels() {
          return [];
        },
      },
      model: 'fake-model',
      apiKey: 'k',
      baseUrl: 'http://127.0.0.1:1/v1',
      streamMode: 'stream' as const,
    }),
  };
});

const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';

const addTerm = async (term: string): Promise<string> => {
  const res = await request(app)
    .post('/api/terms')
    .set('Origin', origin)
    .send({ term, definition: `${term} 的释义`, domain: 'math' })
    .expect(201);
  const id = (res.body as { id: string }).id;
  // ★ v28 复习范围：新词条**默认不在复习池**（默认全不选，老板 2026-09-18 拍板）。
  //   本文件验的是督促编排（欠账口径 / 冷却 / 落卡），词条必须在池里才谈得上催，
  //   故建完顺手勾进范围。范围本身的默认值与边界由 `term-review.test.ts` 单独钉。
  await request(app)
    .put('/api/terms/review/scope')
    .set('Origin', origin)
    .send({ termId: id, enabled: true })
    .expect(200);
  return id;
};

/** 把上次复习时间往回拨 N 天（造欠账；不碰系统时钟，理由见 term-review.test.ts） */
const age = (id: string, days: number): void => {
  getDb()
    .prepare(`UPDATE term_library SET last_reviewed_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${days} days`, id);
};

interface CoachStateBody {
  snapshot: { total: number; due: number; overdue: number; maxOverdueDays: number; streak: number; top: Array<{ term: string }> };
  nudge: { should: boolean; reason: string; line: string };
}

const state = async (): Promise<CoachStateBody> => (await request(app).get('/api/coach/state').expect(200)).body as CoachStateBody;

interface CardBody {
  id: string;
  kind: string;
  text?: string;
  term?: string;
  remembered?: boolean;
  stage?: number;
  intervalDays?: number;
  at: string;
}

const messages = async (): Promise<{ cards: CardBody[]; snapshot: { due: number } }> =>
  (await request(app).get('/api/coach/messages').expect(200)).body as { cards: CardBody[]; snapshot: { due: number } };

const send = (text: unknown) => request(app).post('/api/coach/send').set('Origin', origin).send({ text });

/** 等一个异步条件成立（/send 是"立即返回 + 后台生成"，落卡在后台） */
async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const nudgeCount = (): number =>
  (getDb().prepare(`SELECT COUNT(*) AS c FROM coach_messages WHERE kind = 'nudge'`).get() as { c: number }).c;

/**
 * 建一个账号并取出会话 cookie。
 *
 * ★ 本文件**不借道注册端点**（`POST /api/auth/register` 自 2026-09-22 起免验证码，契约 §2.7 作废；
 *   但那条路仍要吃 `register-limit.ts` 的 5/小时 IP 名额）：本文件主体是**督促编排**、不是注册流程
 *   ⇒ 夹具直接落在**账号 + 会话**这两层，省掉发信打桩、也不让「注册阈值一改本文件跟着红」。
 *   注册端点本身的端到端覆盖在 `routes/auth.test.ts`。
 */
const newCookie = async (email: string): Promise<string> => {
  const user = await createUser(email, 'good-password-1', undefined);
  const { token } = issueSession(user.id);
  return `${AUTH_COOKIE_NAME}=${token}`;
};

beforeEach(() => {
  llm.fail = '';
  llm.chunks = ['先背「闭包」', '，它欠得最久。'];
});

afterAll(() => closeDb());

describe('督促小窗 — 快照与提醒判定', () => {
  it('空库：一条欠账都没有 ⇒ 绝不主动冒泡（reason=empty，文案为空）', async () => {
    const s = await state();
    expect(s.snapshot.due).toBe(0);
    expect(s.nudge.should).toBe(false);
    expect(s.nudge.reason).toBe('empty');
    expect(s.nudge.line).toBe('');
  });

  it('刚入库的词条不算欠账（第一次复习在 1 天后）', async () => {
    await addTerm('云原生');
    const s = await state();
    expect(s.snapshot.total).toBeGreaterThanOrEqual(1);
    expect(s.nudge.should).toBe(false);
  });

  it('★ 逾期 3 天以上 ⇒ should=true，文案带出"最久欠了几天"', async () => {
    const id = await addTerm('闭包');
    age(id, 4);
    const s = await state();
    expect(s.snapshot.due).toBeGreaterThanOrEqual(1);
    expect(s.snapshot.overdue).toBeGreaterThanOrEqual(1);
    expect(s.snapshot.maxOverdueDays).toBeGreaterThanOrEqual(3);
    expect(s.nudge.should).toBe(true);
    expect(s.nudge.reason).toBe('overdue');
    expect(s.nudge.line).toContain(`${s.snapshot.maxOverdueDays} 天`);
    expect(s.snapshot.top[0]?.term).toBe('闭包'); // 欠得最久的排最前
  });
});

describe('督促小窗 — 提醒冷却（服务端把，不靠前端自觉）', () => {
  it('首次落一张提醒卡；紧接着再催 ⇒ cooldown 且**不落库**（否则开关一次多一条）', async () => {
    const before = nudgeCount();
    const first = await request(app).post('/api/coach/nudge').set('Origin', origin).expect(200);
    expect(first.body.card?.kind).toBe('nudge');
    expect(nudgeCount()).toBe(before + 1);

    const second = await request(app).post('/api/coach/nudge').set('Origin', origin).expect(200);
    expect(second.body.card).toBeNull();
    expect(second.body.reason).toBe('cooldown');
    expect(nudgeCount()).toBe(before + 1);
  });
});

describe('督促小窗 — 卡片流水', () => {
  it('/messages 同时给流水与快照，且口径与 /state 一致（不多算一条）', async () => {
    const m = await messages();
    const s = await state();
    expect(m.snapshot.due).toBe(s.snapshot.due);
    expect(m.cards.length).toBeGreaterThan(0);
    // 时间正序：前端直接渲染，不需要自己排
    const times = m.cards.map((c) => c.at);
    expect([...times].sort()).toEqual(times);
  });

  it('★ 复习打卡：落一张动作卡（带新阶段与下次间隔），并让该词条离开队列', async () => {
    const id = await addTerm('记忆化搜索');
    age(id, 5);
    // v1.2：队列响应是**对象**（`{items,goal,doneCards,doneTerms,poolSize}`），这里取 `items`
    const q0 = ((await request(app).get('/api/terms/review/queue').expect(200)).body as { items: Array<{ id: string }> })
      .items;
    expect(q0.map((t) => t.id)).toContain(id);

    const r = await request(app).post('/api/coach/review').set('Origin', origin).send({ termId: id, remembered: true }).expect(200);
    const card = r.body.card as CardBody;
    expect(card.kind).toBe('review');
    expect(card.term).toBe('记忆化搜索');
    expect(card.remembered).toBe(true);
    expect(card.stage).toBe(1); // 记住 → 推进一档
    expect(card.intervalDays).toBe(2);

    const q1 = ((await request(app).get('/api/terms/review/queue').expect(200)).body as { items: Array<{ id: string }> })
      .items;
    expect(q1.map((t) => t.id)).not.toContain(id);
  });

  it('忘了 ⇒ 动作卡记 remembered=false（归零重来），阶段回 0', async () => {
    const id = await addTerm('拓扑排序');
    age(id, 5);
    await request(app).post('/api/coach/review').set('Origin', origin).send({ termId: id, remembered: true }).expect(200);
    const r = await request(app).post('/api/coach/review').set('Origin', origin).send({ termId: id, remembered: false }).expect(200);
    expect((r.body.card as CardBody)).toMatchObject({ remembered: false, stage: 0 });
  });

  it('入参闸门：缺 termId 400、词条不存在 404、remembered 非布尔 400', async () => {
    await request(app).post('/api/coach/review').set('Origin', origin).send({ remembered: true }).expect(400);
    await request(app).post('/api/coach/review').set('Origin', origin).send({ termId: 'nope', remembered: true }).expect(404);
    const id = await addTerm('并查集');
    // 脏值不能被静默当成「忘了」——用户点的是「记住了」却看到归零是最难查的那种错
    await request(app).post('/api/coach/review').set('Origin', origin).send({ termId: id, remembered: 'true' }).expect(400);
  });
});

describe('督促小窗 — 对话', () => {
  it('★ 正常一轮：我的卡立即落库，token 与 done 走 SSE，AI 卡在收口后落库', async () => {
    const r = await send('今天先背哪个？').expect(200);
    expect((r.body.card as CardBody).kind).toBe('me');

    // 后台生成：等 AI 卡落库（它就是"用户最终会看到的那句话"的权威副本）
    const done = await waitFor(() => {
      const rows = getDb().prepare(`SELECT COUNT(*) AS c FROM coach_messages WHERE kind = 'ai'`).get() as { c: number };
      return rows.c > 0;
    });
    expect(done).toBe(true);
    const ai = getDb().prepare(`SELECT content FROM coach_messages WHERE kind = 'ai' ORDER BY rowid DESC LIMIT 1`).get() as {
      content: string;
    };
    expect(ai.content).toBe(llm.chunks.join(''));

    // SSE 总线：这一轮必须既有 token 也有 done（前端靠它们做打字机与收口）
    const live = (await request(app).get('/api/coach/live').expect(200)).body as { events: Array<{ type: string }> };
    const types = live.events.map((e) => e.type);
    expect(types).toContain('token');
    expect(types).toContain('done');
  });

  it('★ 模型挂了也要有交代：广播 chat-error，且落一条说明卡（下次打开小窗知道上次为什么没回）', async () => {
    llm.fail = '上游 502';
    await send('再给我排一下').expect(200);
    const ok = await waitFor(() => {
      const row = getDb().prepare(`SELECT content FROM coach_messages WHERE kind = 'ai' ORDER BY rowid DESC LIMIT 1`).get() as
        | { content: string }
        | undefined;
      return row !== undefined && row.content.includes('没回上');
    });
    expect(ok).toBe(true);
    const live = (await request(app).get('/api/coach/live').expect(200)).body as { events: Array<{ type: string }> };
    expect(live.events.map((e) => e.type)).toContain('chat-error');
  });

  it('空提问 400（空一轮会把"我的卡"落成一条空白）', async () => {
    const before = (getDb().prepare(`SELECT COUNT(*) AS c FROM coach_messages WHERE kind = 'me'`).get() as { c: number }).c;
    await send('   ').expect(400);
    await send(undefined).expect(400);
    const after = (getDb().prepare(`SELECT COUNT(*) AS c FROM coach_messages WHERE kind = 'me'`).get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe('督促小窗 — 闸门与隔离', () => {
  it('写接口无 Origin → 403（与其余写口同一道跨源闸门）', async () => {
    await request(app).post('/api/coach/send').send({ text: 'hi' }).expect(403);
    await request(app).post('/api/coach/nudge').send({}).expect(403);
  });

  it('★ 多租户：各自的督促流水互不可见（子表随主人的隔离，与 sessions 同一口径）', async () => {
    const cookieA = await newCookie('coach-a@example.com');
    const cookieB = await newCookie('coach-b@example.com');
    await request(app).post('/api/coach/send').set('Origin', origin).set('Cookie', cookieA).send({ text: 'A 的悄悄话' }).expect(200);

    const aCards = (await request(app).get('/api/coach/messages').set('Origin', origin).set('Cookie', cookieA).expect(200)).body as {
      cards: CardBody[];
    };
    const bCards = (await request(app).get('/api/coach/messages').set('Origin', origin).set('Cookie', cookieB).expect(200)).body as {
      cards: CardBody[];
    };
    expect(aCards.cards.some((c) => c.text === 'A 的悄悄话')).toBe(true);
    expect(bCards.cards.some((c) => c.text === 'A 的悄悄话')).toBe(false);

    // 未登录（单人本地模式）也看不到登录用户的流水：`owner_id IS NULL` 与 `owner_id = 'u'` 是两条道
    const anonCards = (await request(app).get('/api/coach/messages').expect(200)).body as { cards: CardBody[] };
    expect(anonCards.cards.some((c) => c.text === 'A 的悄悄话')).toBe(false);
  });
});
