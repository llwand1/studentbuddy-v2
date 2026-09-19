/**
 * routes/chat-send — `/api/chat/send` 的入站闸门（supertest，同 chat-active.test.ts 手法）。
 *
 * 看图功能（v17）给这条路由加了三个判决，每一个都是**用户能感知**的行为，故上仪器：
 * ① **纯图片提问放行**——「这张图讲了什么」没有文字，前端已允许空 text，
 *    这里若还按老规矩 `!text.trim()` 打 400，用户看到的就是「点了发送没反应」；
 * ② **超过 4 张 / 单张 >10MB 打 400 并给能照着改的文案**（数量与体积闸门在 `chat/vision.ts`）；
 * ③ **非 `data:image/` 的脏值被静默丢弃而非打 400**——夹带垃圾不该毁掉一次正常提问，
 *    但也绝不能透传给视觉模型（它会把任意字符串当图片发过去）。
 *
 * 只桩「本轮生成」：`handleMessage` 换成记录参数的立即 resolve，本文件不验模型调用。
 * P3 追加：`/api/chat/tool-confirm` 的状态码透传与端到端收口（门语义在 confirm.test.ts，
 * 这里只锁「路由没把 400/404/409 吞成 200」这一层接线）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chat-send-test-'));

const flowStub = vi.hoisted(() => ({
  calls: [] as Array<{ sessionId?: string; text?: string; images?: unknown; grillMe?: boolean }>,
}));

vi.mock('../chat/flow.js', () => ({
  handleMessage: (opts: { sessionId?: string; text?: string; images?: unknown; grillMe?: boolean }) => {
    flowStub.calls.push(opts);
    return Promise.resolve({ ok: true });
  },
}));

const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const PNG = 'data:image/png;base64,AAAA';

const newSession = async (): Promise<string> =>
  (await request(app).post('/api/sessions').set('Origin', origin).send({})).body.id as string;

const send = (body: Record<string, unknown>) =>
  request(app).post('/api/chat/send').set('Origin', origin).send(body);

beforeEach(() => {
  flowStub.calls.length = 0;
});

afterAll(() => closeDb());

describe('/api/chat/send — 入站闸门', () => {
  it('没文字也没图 → 400（空提问不能开一轮）', async () => {
    const sid = await newSession();
    const r = await send({ sessionId: sid, text: '   ' });
    expect(r.status).toBe(400);
    expect(flowStub.calls).toHaveLength(0);
  });

  it('只有图没有文字 → 放行（「这张图讲了什么」是正当用法，不能静默吞）', async () => {
    const sid = await newSession();
    const r = await send({ sessionId: sid, text: '', images: [{ dataUrl: PNG }] });
    expect(r.status).toBe(200);
    expect(flowStub.calls).toHaveLength(1);
    expect(flowStub.calls[0]?.images).toEqual([{ dataUrl: PNG }]);
  });

  it('图随提问原样送到 flow（含文件名）', async () => {
    const sid = await newSession();
    const r = await send({ sessionId: sid, text: '这题怎么解', images: [{ dataUrl: PNG, name: 'q.png' }] });
    expect(r.status).toBe(200);
    expect(flowStub.calls[0]?.text).toBe('这题怎么解');
    expect(flowStub.calls[0]?.images).toEqual([{ dataUrl: PNG, name: 'q.png' }]);
  });

  it('超 4 张 → 400（不是静默截断，用户得知道哪张没发）', async () => {
    const sid = await newSession();
    const r = await send({
      sessionId: sid,
      text: '看图',
      images: Array.from({ length: 5 }, () => ({ dataUrl: PNG })),
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/最多上传 4 张/);
    expect(flowStub.calls).toHaveLength(0);
  });

  it('单张超过约 5MB → 400（拦在路由层，别让它打爆视觉模型）', async () => {
    const sid = await newSession();
    const r = await send({
      sessionId: sid,
      text: '看图',
      images: [{ dataUrl: `data:image/png;base64,${'A'.repeat(7_000_001)}` }],
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/过大/);
  });

  it('★ 承载图片的这条路由放宽了 body 上限：2MB 之外的截图不会被 express 提前 413', async () => {
    // 回归锁：全局 json 上限是 2mb（防 DoS，继承 v1），一张截图 base64 常 2~5MB。
    // 本路由若沿用 2mb，请求到不了业务校验就被打回——前端表现为「点了发送没反应」。
    const sid = await newSession();
    const big = `data:image/png;base64,${'A'.repeat(4_000_000)}`; // ≈3MB 原图，业务上限内
    const r = await send({ sessionId: sid, text: '看图', images: [{ dataUrl: big }] });
    expect(r.status).toBe(200);
    expect(flowStub.calls).toHaveLength(1);
  });

  it('脏值被丢弃而不打 400，且不透传给视觉模型', async () => {
    const sid = await newSession();
    const r = await send({
      sessionId: sid,
      text: '看图',
      images: [{ dataUrl: 'data:text/plain;base64,zzz' }, { dataUrl: 'http://evil/x.png' }, { dataUrl: PNG }],
    });
    expect(r.status).toBe(200);
    // 脏值不该占额度，更不该进 flow：只剩那张合法图
    expect(flowStub.calls[0]?.images).toEqual([{ dataUrl: PNG }]);
  });
});

describe('/api/chat/send — grill-me 开关（v18）', () => {
  it('grillMe=true 原样进 flow（服务端据此强绑 tool_choice）', async () => {
    const sid = await newSession();
    const r = await send({ sessionId: sid, text: '讲讲二分查找', grillMe: true });
    expect(r.status).toBe(200);
    expect(flowStub.calls[0]?.grillMe).toBe(true);
  });

  it('不传 / 传脏值 → 一律归一成 false（默认不开，且「真值」不会漏进来）', async () => {
    const sid = await newSession();
    await send({ sessionId: sid, text: 'a' });
    await send({ sessionId: sid, text: 'b', grillMe: 'yes' });
    expect(flowStub.calls[0]?.grillMe).toBe(false);
    expect(flowStub.calls[1]?.grillMe).toBe(false);
  });
});

describe('/api/chat/tool-confirm — 确认门回执路由（P3 §6.4 状态码透传）', () => {
  const answer = (body: Record<string, unknown>) =>
    request(app).post('/api/chat/tool-confirm').set('Origin', origin).send(body);

  it('requestId 缺失 → 400；decision 非法 → 400（confirm.ts 的口径原样透传成 HTTP 码）', async () => {
    expect((await answer({ decision: 'allow_once' })).status).toBe(400);
    expect((await answer({ requestId: 'x', decision: 'meow' })).status).toBe(400);
  });

  it('不存在的 requestId → 404（猜不中的 uuid v4 就是这道门的归属判定，同 /api/choices 信任模型）', async () => {
    const r = await answer({ requestId: 'no-such-request', decision: 'allow_once' });
    expect(r.status).toBe(404);
  });

  it('真挂起的确认走 HTTP 收口：allow_once → 200 且服务端 waiter 被唤醒（端到端接线锁）', async () => {
    const { requestConfirmation } = await import('../chat/tools/confirm.js');
    const decided = requestConfirmation({
      sessionId: 'http-confirm-sess',
      tool: 'delete_terms',
      source: 'builtin',
      actionSummary: '删 1 条',
      affected: 1,
      items: ['甲［cs］'],
    });
    // 先登记的 requestId 只能从发布帧拿——路由按 id 裁决，这里从 sse-bus 缓冲取（与前端同源）
    const { snapshot } = await import('../chat/sse-bus.js');
    const frame = snapshot('http-confirm-sess').find((e) => e.type === 'tool-confirm-request') as
      | { requestId: string }
      | undefined;
    if (!frame) throw new Error('requestConfirmation 没发布帧');
    const r = await answer({ requestId: frame.requestId, decision: 'allow_once' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(await decided).toBe('allow_once');
    // 迟到的第二次点选：409（单一裁决者，路由不吞这层语义）
    expect((await answer({ requestId: frame.requestId, decision: 'deny' })).status).toBe(409);
  });
});
