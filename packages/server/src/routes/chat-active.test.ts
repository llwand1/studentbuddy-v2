/**
 * routes/chat-active 端到端（supertest，同 quiz-search.test.ts 手法）。
 *
 * 钉的是「**谁正在生成**」这个问题的答案来源——侧栏「回复中」提示的唯一事实源。
 * 修 bug 前的病根在客户端：提示绑在「当前挂载的会话」上，于是一切开就漂到别的会话项、
 * 原会话反而没了提示。而**生成并不随页面切换中止**（`sse-bus` 的 `res.on('close')` 只摘订阅者，
 * 不碰 AbortController；flow 照跑照落库）⇒ 客户端只能问服务端，服务端的 `aborters` 就是真相。
 *
 * 因此本文件锁四条不变量：
 * ① 空闲时**必须是空数组**（不能靠「前端自己猜」兜底出假阳性）；
 * ② 发送后**立刻**在列表里（前端 2s 轮询也能及时亮起，不必等第一帧 token）；
 * ③ 生成收尾后**必须消失**（徽标不是永久挂着的装饰）；
 * ④ 两个会话同时生成时**两个都在**（这正是 bug 的核心：不是「当前会话」而是「全部在跑的」）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { boot, TEST_ORIGIN } from '../testing/http.js';

/** 只桩「本轮生成」这一段：本批验的是登记与摘除的时机，不验模型调用 */
const flowStub = vi.hoisted(() => ({
  /** 每个未收尾的生成挂一个 resolve：调用即「本轮跑完」 */
  pending: [] as Array<() => void>,
  calls: [] as Array<{ sessionId?: string }>,
}));

vi.mock('../chat/flow.js', () => ({
  handleMessage: (opts: { sessionId?: string }) =>
    new Promise<void>((resolve) => {
      flowStub.calls.push(opts);
      flowStub.pending.push(() => resolve());
    }),
}));

const { app, request, closeDb } = await boot('chat-active-test');
const origin = TEST_ORIGIN;

/** 当前「生成中」的会话 id；`/active` 是 GET，不受写操作 Origin 闸门约束 */
const active = async (): Promise<string[]> =>
  (await request(app).get('/api/chat/active')).body.sessionIds as string[];

const newSession = async (): Promise<string> =>
  (await request(app).post('/api/sessions').set('Origin', origin).send({})).body.id as string;

const send = (sessionId: string) =>
  request(app).post('/api/chat/send').set('Origin', origin).send({ sessionId, text: '你好' });

/** 放掉一个未收尾的生成，并等路由里 `.finally()` 的微任务真正落地 */
async function finishOne(): Promise<void> {
  flowStub.pending.shift()?.();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(async () => {
  // aborters 是模块级 Map、跨用例共享：上一例没跑完的生成必须先收干，否则污染下一例
  while (flowStub.pending.length > 0) await finishOne();
  flowStub.calls.length = 0;
});

afterAll(() => closeDb());

describe('/api/chat/active —— 「谁在生成」的唯一事实源', () => {
  it('空闲时是空数组（没有生成就不能有假阳性，前端不该自己猜）', async () => {
    expect(await active()).toEqual([]);
  });

  it('发送后立刻登记：不必等第一帧 token，前端轮询就能亮起', async () => {
    const sid = await newSession();
    await send(sid).expect(200);
    expect(await active()).toContain(sid);
  });

  it('★ 两个会话同时生成时两个都在——提示挂在「正在生成的会话」而不是「当前打开的会话」', async () => {
    const a = await newSession();
    const b = await newSession();
    await send(a).expect(200);
    await send(b).expect(200);
    const list = await active();
    expect(list).toContain(a);
    expect(list).toContain(b);
    expect(list).toHaveLength(2);
  });

  it('生成收尾后从列表消失（徽标不是永久挂着，前端轮询下一拍就摘掉）', async () => {
    const sid = await newSession();
    await send(sid).expect(200);
    expect(await active()).toContain(sid);
    await finishOne();
    expect(await active()).not.toContain(sid);
  });

  it('只摘除自己那一间：一间收尾不影响另一间仍在生成', async () => {
    const a = await newSession();
    const b = await newSession();
    await send(a).expect(200);
    await send(b).expect(200);
    await finishOne(); // 先收尾的是 a（FIFO）
    const list = await active();
    expect(list).not.toContain(a);
    expect(list).toContain(b);
  });

  it('登记的就是请求体里的 sessionId（防止提示指向与实际生成对象错位）', async () => {
    const sid = await newSession();
    await send(sid).expect(200);
    expect(flowStub.calls.at(-1)?.sessionId).toBe(sid);
  });

  it('缺 sessionId 的发送被 400 挡下——不会留下一个永远收不掉的无主登记', async () => {
    await request(app).post('/api/chat/send').set('Origin', origin).send({ text: '你好' }).expect(400);
    expect(await active()).toEqual([]);
  });
});
