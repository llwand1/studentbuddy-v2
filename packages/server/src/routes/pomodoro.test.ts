/**
 * routes/pomodoro 端到端（supertest，同 guide.test.ts 手法）：`GET / PUT / DELETE /api/pomodoro` 与**三处偏向**。
 *
 * 钉六件事：
 *  ① 没开钟 ⇒ `{session:null, focus:null}`；PUT 整份落库后 GET 原样读回，`focus` 由服务端派生（工作段才有）；
 *  ② 形状不对（方向为空 / 时间坏 / 不是对象）⇒ 400，库里不写；DELETE 后再 GET 为空；跨源写 ⇒ 403；
 *  ③ ★ 多租户：A 的番茄钟 B 看不到（`app_settings` 按人一行）；
 *  ④ ★ 对话上下文：工作段 ⇒ `focus` 段在、内容引用方向；休息段 / 没开钟 ⇒ 没有这一段（空段剔除）；
 *  ⑤ ★ 引路灯：工作段 ⇒ 提示词里有方向、规则推荐的 `chat.topic` text 落在方向里；休息段 ⇒ 都没有；
 *  ⑥ ★ 刷词出新词：工作段 ⇒ 提示词里有方向句；
 *  ⑦ ★ 出题主题：缺省主题被换成方向（看 `generateBlendedQuiz` 收到的 topic）。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTH_COOKIE_NAME, nextPomodoroPhase, startPomodoro, type GuideNextResponse, type PomodoroSession } from '@sb/shared';

process.env.SB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pomodoro-test-'));

const llm = vi.hoisted(() => ({ ready: true, calls: [] as Array<{ messages: Array<{ role: string; content: string }> }> }));
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
          }
        : null,
  };
});
const blend = vi.hoisted(() => ({ topics: [] as string[] }));
vi.mock('../learning/quiz-blend.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../learning/quiz-blend.js')>();
  return {
    ...mod,
    // 只记 topic 就停：本文件验的是「主题被换成方向」，不是出题引擎（那在 quiz*.test.ts）。抛错 ⇒ 路由 500，不影响断言
    generateBlendedQuiz: async (topic: string) => {
      blend.topics.push(topic);
      throw new Error('stop-after-topic');
    },
  };
});

const { app } = await import('../index.js');
const { closeDb } = await import('../storage/db.js');
const { createUser } = await import('../auth/users.js');
const { createSession: issueSession } = await import('../auth/session.js');
const { collectContextSegments } = await import('../chat/context-segments.js');
const request = (await import('supertest')).default;

const origin = 'http://localhost:5173';
const NOW = new Date();
const work = (subject = '数学'): PomodoroSession => startPomodoro({ subject, workMin: 30 }, NOW)!;
const rest = (): PomodoroSession => nextPomodoroPhase(work(), NOW);

const put = (session: unknown, cookie?: string) => {
  const r = request(app).put('/api/pomodoro').set('Origin', origin);
  return (cookie ? r.set('Cookie', cookie) : r).send({ session });
};
const get = (cookie?: string) => {
  const r = request(app).get('/api/pomodoro');
  return cookie ? r.set('Cookie', cookie) : r;
};
const newCookie = async (email: string): Promise<string> => {
  const user = await createUser(email, 'good-password-1', undefined);
  return `${AUTH_COOKIE_NAME}=${issueSession(user.id).token}`;
};
const systemPrompt = (n = 0): string => llm.calls[n]?.messages.find((m) => m.role === 'system')?.content ?? '';

beforeEach(async () => {
  llm.ready = true;
  llm.calls = [];
  blend.topics = [];
  await request(app).delete('/api/pomodoro').set('Origin', origin).expect(200);
});
afterAll(() => {
  closeDb();
  fs.rmSync(process.env.SB_DATA_DIR as string, { recursive: true, force: true });
});

describe('① ② 读写与闸门', () => {
  it('没开钟 ⇒ 都是 null；PUT 后原样读回、focus 由服务端派生；休息段 focus 为 null', async () => {
    expect((await get().expect(200)).body).toEqual({ session: null, focus: null });
    const s = work();
    const saved = (await put(s).expect(200)).body as { session: PomodoroSession; focus: { subject: string; leftMin: number } | null };
    expect(saved.session).toEqual(s);
    expect(saved.focus?.subject).toBe('数学');
    expect(saved.focus?.leftMin).toBeGreaterThan(0);
    expect(((await get().expect(200)).body as { session: PomodoroSession }).session).toEqual(s);
    const b = (await put(rest()).expect(200)).body as { focus: unknown };
    expect(b.focus).toBeNull();
  });

  it('坏形状 ⇒ 400 且不落库；DELETE 清空；跨源写 ⇒ 403', async () => {
    await put({ ...work(), subject: '  ' }).expect(400);
    await put({ ...work(), phaseEndsAt: 'nope' }).expect(400);
    await put('x').expect(400);
    expect(((await get().expect(200)).body as { session: unknown }).session).toBeNull();
    await put(work()).expect(200);
    await request(app).delete('/api/pomodoro').set('Origin', origin).expect(200);
    expect(((await get().expect(200)).body as { session: unknown }).session).toBeNull();
    await request(app).put('/api/pomodoro').set('Origin', 'http://evil.example').send({ session: work() }).expect(403);
  });

  it('③ 多租户：A 开的钟 B 看不到', async () => {
    const a = await newCookie('a-pomo@example.com');
    const b = await newCookie('b-pomo@example.com');
    await put(work('化学'), a).expect(200);
    expect(((await get(a).expect(200)).body as { session: PomodoroSession }).session.subject).toBe('化学');
    expect(((await get(b).expect(200)).body as { session: unknown }).session).toBeNull();
  });
});

describe('④ 对话上下文段', () => {
  const segs = () => collectContextSegments({ history: [], sessionId: 'no-such-session', text: '随便问问', ownerId: null }).segments;

  it('工作段 ⇒ 有 focus 段且引用方向；休息段 / 没开钟 ⇒ 没有这一段', async () => {
    expect(segs().some((s) => s.kind === 'focus')).toBe(false);
    await put(work('线性代数')).expect(200);
    const f = segs().find((s) => s.kind === 'focus');
    expect(f?.content).toContain('「线性代数」');
    expect(f?.content).toContain('不要硬扯回去');
    await put(rest()).expect(200);
    expect(segs().some((s) => s.kind === 'focus')).toBe(false);
  });
});

describe('⑤ 引路灯', () => {
  const CAN = ['chat.topic', 'nav.terms', 'nav.continent', 'nav.pk', 'nav.settings'];
  const next = async (): Promise<GuideNextResponse> =>
    (await request(app).post('/api/guide/next').set('Origin', origin).send({ lang: 'zh', view: 'chat', can: CAN, busy: false }).expect(200))
      .body as GuideNextResponse;

  it('工作段 ⇒ 提示词写明方向、规则推荐的话题落在方向里；没开钟 ⇒ 两处都没有', async () => {
    await put(work('有机化学')).expect(200);
    const r = await next();
    expect(systemPrompt()).toContain('学习方向是「有机化学」');
    const topic = r.items.find((i) => i.kind === 'chat.topic');
    expect(topic?.text).toContain('有机化学');
    await request(app).delete('/api/pomodoro').set('Origin', origin).expect(200);
    llm.calls = [];
    const r2 = await next();
    expect(systemPrompt()).not.toContain('番茄钟');
    expect(r2.items.find((i) => i.kind === 'chat.topic')?.text).not.toContain('有机化学');
  });
});

describe('⑥ ⑦ 刷词与出题', () => {
  it('刷词出新词：工作段 ⇒ 提示词里有方向句', async () => {
    await put(work('数据结构')).expect(200);
    await request(app).post('/api/drill/new-terms').set('Origin', origin).send({}).expect(200);
    expect(systemPrompt()).toContain('「数据结构」');
  });

  it('出题：缺省主题被换成方向；自定主题加方向标签；没开钟原样', async () => {
    await put(work('数学')).expect(200);
    await request(app).post('/api/quiz/generate').set('Origin', origin).send({ topic: '根据当前对话内容出题' });
    await request(app).post('/api/quiz/generate').set('Origin', origin).send({ topic: '二次函数' });
    await request(app).delete('/api/pomodoro').set('Origin', origin).expect(200);
    await request(app).post('/api/quiz/generate').set('Origin', origin).send({ topic: '二次函数' });
    expect(blend.topics).toEqual(['数学（结合当前对话）', '【数学】二次函数', '二次函数']);
  });
});
