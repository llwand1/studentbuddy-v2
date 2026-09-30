/**
 * routes/guide 端到端（supertest，同 coach.test.ts 手法）：`POST /api/guide/next`。
 *
 * 钉七件事：
 *  ① 入参闸门：lang / view 非法、`can` 里有白名单外的动作、不是对象 ⇒ 400；跨源写请求被拒；
 *  ② ★ 没模型 ⇒ 200 + `mode: 'rules'` + `reason: 'no-model'`（永不 5xx），第一项去设置；
 *  ③ 有模型 ⇒ `mode: 'ai'`；第一次（没有会话）话题第一位，模型现想的话题原样保留；
 *  ④ ★ 现场是服务端自己从库里读的：末一问、轮数、「已出过几组题」进了提示词，而题卡登记行**不会**被当成「AI 最近一答」；
 *  ⑤ 三个时刻：做完题（`can` 里有解析）⇒ 解析第一，即使模型给了乱码、走规则兜底也一样；
 *  ⑥ 上游炸 ⇒ 200 + `reason: 'upstream'`；忙态 ⇒ 没有项、模型零调用；
 *  ⑦ ★ 多租户：B 带着 A 的会话 id 来问，A 的对话内容不会进 B 的提示词；非对话页带 sessionId 也不读会话。
 *
 * ★ 假模型而不是真调上游：本文件验的是**编排**（取现场 / 兜底 / 隔离），不是模型水平。桩的是 `routeRole` 这一层，
 *   所以走的是**真**路由、真库、真网关。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AUTH_COOKIE_NAME, type GuideNextResponse } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-guide-test-'));

/** 可控假模型：`ready=false` ⇒ 没绑模型；`fail` 非空 ⇒ 上游抛错；`calls` 记下每次收到的请求 */
const llm = vi.hoisted(() => ({
  ready: true,
  fail: '',
  reply: '',
  calls: [] as Array<{ messages: Array<{ role: string; content: string }> }>,
}));
vi.mock('../llm/router.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../llm/router.js')>();
  return {
    ...mod,
    routeRole: () =>
      llm.ready
        ? {
            adapter: {
              type: 'openai' as const,
              async *chat(req: { messages: Array<{ role: string; content: string }> }) {
                llm.calls.push(req);
                if (llm.fail) throw new Error(llm.fail);
                yield { content: llm.reply, done: true };
              },
              async listModels() {
                return [];
              },
            },
            model: 'fake-model',
            apiKey: 'k',
            baseUrl: 'http://127.0.0.1:1/v1',
            streamMode: 'stream' as const,
          }
        : null,
  };
});

const { app } = await import('../index.js');
const { getDb, closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const NAV = ['nav.terms', 'nav.continent', 'nav.pk', 'nav.settings'];
const CHAT_CAN = ['chat.topic', 'chat.ask', 'chat.remember', 'chat.videos', 'session.new', 'quiz.start', 'quiz.scenario', ...NAV];

const post = (body: unknown, cookie?: string) => {
  const r = request(app).post('/api/guide/next').set('Origin', origin);
  return (cookie ? r.set('Cookie', cookie) : r).send(body as object);
};
const next = async (body: unknown, cookie?: string): Promise<GuideNextResponse> => (await post(body, cookie).expect(200)).body as GuideNextResponse;
const systemPrompt = (n = 0): string => llm.calls[n]?.messages.find((m) => m.role === 'system')?.content ?? '';

const newCookie = async (email: string): Promise<string> => {
  const user = await createUser(email, 'good-password-1', undefined);
  return `${AUTH_COOKIE_NAME}=${issueSession(user.id).token}`;
};
const newSessionId = async (cookie?: string): Promise<string> => {
  const r = request(app).post('/api/sessions').set('Origin', origin);
  const res = await (cookie ? r.set('Cookie', cookie) : r).send({}).expect(201);
  return (res.body as { id: string }).id;
};
const addMsg = (sessionId: string, role: 'user' | 'assistant', content: string): void => {
  getDb().prepare('INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)').run(randomUUID(), sessionId, role, content);
};

beforeEach(() => {
  llm.ready = true;
  llm.fail = '';
  llm.reply = '';
  llm.calls = [];
});
afterAll(() => {
  closeDb();
  fs.rmSync(process.env.SB_DATA_DIR as string, { recursive: true, force: true });
});

describe('① 入参闸门', () => {
  it.each([
    ['不是对象', 'hello'],
    ['缺 view', { can: [] }],
    ['view 不认', { view: 'pk', can: [] }],
    ['lang 不认', { lang: 'fr', view: 'chat', can: [] }],
    ['can 不是数组', { view: 'chat', can: 'quiz.start' }],
    ['can 里有白名单外的动作', { view: 'chat', can: ['quiz.start', 'drop.table'] }],
  ])('%s ⇒ 400', async (_name, body) => {
    const res = await post(body).expect(400);
    expect((res.body as { error: string }).error).toMatch(/请求形状不对/);
    expect(llm.calls).toHaveLength(0);
  });

  it('跨源的写请求被拒（与全站写口同一道 Origin 闸）', async () => {
    await request(app).post('/api/guide/next').set('Origin', 'https://evil.example.com').send({ view: 'chat', can: [] }).expect(403);
  });
});

describe('② 没模型', () => {
  it('★ 200 + rules + reason no-model，第一项去设置；模型零调用', async () => {
    llm.ready = false;
    const r = await next({ view: 'chat', can: CHAT_CAN });
    expect(r).toMatchObject({ mode: 'rules', reason: 'no-model', stage: 'nomodel' });
    expect(r.items[0]?.kind).toBe('nav.settings');
    expect(llm.calls).toHaveLength(0);
  });
});

describe('③ 有模型', () => {
  it('第一次（没有会话）⇒ ai，话题第一位，模型现想的话题原样保留；提示词里写了「还没有内容」', async () => {
    llm.reply = JSON.stringify({
      headline: '先从一个小问题开始吧',
      items: [
        { kind: 'chat.topic', label: '随机聊个话题', hint: '猫和纸箱的秘密', text: '为什么猫总爱钻进纸箱？' },
        { kind: 'nav.terms', label: '翻翻词条库', hint: '看看 AI 替你记了什么' },
      ],
    });
    const r = await next({ view: 'chat', can: CHAT_CAN.filter((k) => !k.startsWith('quiz') && k !== 'chat.ask') });
    expect(r).toMatchObject({ mode: 'ai', stage: 'fresh', headline: '先从一个小问题开始吧' });
    expect(r.items[0]).toMatchObject({ kind: 'chat.topic', text: '为什么猫总爱钻进纸箱？', hint: '猫和纸箱的秘密' });
    expect(systemPrompt()).toContain('还没有内容');
    expect(systemPrompt()).toContain('必须包含 chat.topic');
  });

  it('英文请求 ⇒ 提示词要求英文，规则兜底文案也是英文', async () => {
    llm.reply = 'not json at all';
    const r = await next({ lang: 'en', view: 'chat', can: CHAT_CAN });
    expect(systemPrompt()).toContain('in English');
    expect(r.mode).toBe('rules');
    expect(r.items[0]?.label).toBe('Chat about something random');
  });
});

describe('④ 现场由服务端读库', () => {
  it('★ 末一问、轮数、出过几组题进了提示词；题卡登记行不被当成「AI 最近一答」', async () => {
    const sid = await newSessionId();
    addMsg(sid, 'user', '什么是向量数据库');
    addMsg(sid, 'assistant', '向量数据库用来存储与检索高维向量，常配合近似最近邻索引。');
    addMsg(sid, 'assistant', '[QUIZ]{"title":"向量数据库","questions":[]}[/QUIZ]');
    llm.reply = JSON.stringify({ items: [{ kind: 'quiz.scenario', label: '出道情景题' }, { kind: 'chat.remember', label: '存入记忆' }] });
    const r = await next({ view: 'chat', sessionId: sid, can: CHAT_CAN });
    expect(r).toMatchObject({ mode: 'ai', stage: 'chatted' });
    const p = systemPrompt();
    expect(p).toContain('「什么是向量数据库」');
    expect(p).toContain('共 1 轮');
    expect(p).toContain('已出过 1 组题');
    expect(p).toContain('向量数据库用来存储与检索高维向量');
    expect(p).not.toContain('[QUIZ]');
    // 已出过题 ⇒ 提示词倾向换个形式
    expect(p).toContain('倾向 quiz.scenario');
  });

  it('词条现状进了提示词', async () => {
    await request(app).post('/api/terms').set('Origin', origin).send({ term: '向量索引', definition: '加速近邻检索的数据结构', domain: 'db' }).expect(201);
    llm.reply = JSON.stringify({ items: [{ kind: 'chat.topic', label: '随机话题', text: '随便聊聊今天的事' }] });
    await next({ view: 'chat', can: ['chat.topic', 'nav.terms'] });
    expect(systemPrompt()).toMatch(/词条 \d+ 条，今天到期 \d+ 条/);
  });
});

describe('⑤ 做完题', () => {
  it('★ can 里有一键解析 ⇒ quizzed，解析第一', async () => {
    const sid = await newSessionId();
    addMsg(sid, 'user', '考我一下');
    llm.reply = JSON.stringify({ items: [{ kind: 'quiz.retry', label: '再练一遍' }, { kind: 'chat.remember', label: '存入记忆' }] });
    const r = await next({ view: 'chat', sessionId: sid, can: ['quiz.explain', 'quiz.retry', 'chat.remember', 'chat.topic', 'session.new', ...NAV] });
    expect(r).toMatchObject({ mode: 'ai', stage: 'quizzed' });
    expect(r.items[0]).toMatchObject({ kind: 'quiz.explain', label: '一键解析' });
  });

  it('★ 模型给了乱码 ⇒ 规则兜底，解析照样第一（reason parse；共 2 次调用＝1 次修复）', async () => {
    llm.reply = '啊这……我不知道';
    const r = await next({ view: 'chat', can: ['quiz.explain', 'quiz.retry', 'chat.remember', ...NAV] });
    expect(r).toMatchObject({ mode: 'rules', reason: 'parse', stage: 'quizzed' });
    expect(r.items[0]?.kind).toBe('quiz.explain');
    expect(llm.calls).toHaveLength(2);
  });
});

describe('⑥ 失败与忙态', () => {
  it('★ 上游炸 ⇒ 仍然 200 + rules + reason upstream，项可用', async () => {
    llm.fail = 'boom 503';
    const r = await next({ view: 'chat', can: CHAT_CAN });
    expect(r).toMatchObject({ mode: 'rules', reason: 'upstream' });
    expect(r.items.length).toBeGreaterThan(0);
  });

  it('忙态 ⇒ 没有项、没有 reason、模型零调用', async () => {
    const r = await next({ view: 'chat', can: CHAT_CAN, busy: true });
    expect(r).toMatchObject({ mode: 'rules', stage: 'busy', items: [] });
    expect(r.reason).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
  });

  it('非对话页 ⇒ tour：不推当前页自己，提示词写明所在页面', async () => {
    llm.reply = JSON.stringify({ items: [{ kind: 'chat.topic', label: '回去聊聊', text: '我们聊点轻松的吧' }, { kind: 'nav.continent', label: '去知识大陆' }] });
    const r = await next({ view: 'terms', can: CHAT_CAN });
    expect(r.stage).toBe('tour');
    expect(r.items.map((i) => i.kind)).toEqual(['chat.topic', 'nav.continent']);
    expect(systemPrompt()).toContain('所在页面：词条库页');
    expect(systemPrompt()).not.toContain('- nav.terms：');
  });
});

describe('⑦ 多租户', () => {
  it('★ B 带着 A 的会话 id 来问：A 的对话内容不进 B 的提示词，B 看到的是 fresh', async () => {
    const cookieA = await newCookie('guide-a@example.com');
    const cookieB = await newCookie('guide-b@example.com');
    const sidA = await newSessionId(cookieA);
    addMsg(sidA, 'user', 'A 的私密问题：我的银行卡密码策略');
    addMsg(sidA, 'assistant', 'A 的私密回答');
    llm.reply = JSON.stringify({ items: [{ kind: 'chat.topic', label: '随机话题', text: '随便聊聊今天的天气' }] });
    const asB = await next({ view: 'chat', sessionId: sidA, can: ['chat.topic', 'session.new', ...NAV] }, cookieB);
    expect(asB.stage).toBe('fresh');
    expect(systemPrompt()).not.toContain('私密');
    // A 自己来问：看得到
    llm.calls = [];
    llm.reply = JSON.stringify({ items: [{ kind: 'quiz.start', label: '来一套题' }] });
    const asA = await next({ view: 'chat', sessionId: sidA, can: CHAT_CAN }, cookieA);
    expect(asA.stage).toBe('chatted');
    expect(systemPrompt()).toContain('A 的私密问题');
  });

  it('非对话页带了 sessionId 也不读会话（别的页谈不上「当前会话」）', async () => {
    const sid = await newSessionId();
    addMsg(sid, 'user', '只该在对话页被读到的话');
    llm.reply = JSON.stringify({ items: [{ kind: 'chat.topic', label: '回去聊聊', text: '聊点什么好呢' }] });
    await next({ view: 'settings', sessionId: sid, can: CHAT_CAN });
    expect(systemPrompt()).not.toContain('只该在对话页被读到的话');
  });
});
